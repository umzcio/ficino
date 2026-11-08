/**
 * PDF text extraction and page rendering with MuPDF (WASM), ported from worker/lib/pdf_extractor.py.
 *
 * The markdown must match PyMuPDF's `extract_text_pymupdf` because chunks and embeddings derive from it, so
 * this file rebuilds PyMuPDF's own text-page walks (pymupdf/__init__.py in PyMuPDF 1.28.0):
 * - `page.get_text()` is `JM_print_stext_page_as_text`: every char whose bbox overlaps the page, and a newline
 *   after each line unless its last char was one.
 * - `page.get_text("dict")` spans come from `JM_make_spanlist`: runs of chars with the same size, font flags,
 *   font name, color and bidi level.
 * Both PyMuPDF text pages run the whole page (contents, annotations and widgets) with TEXTFLAGS_TEXT /
 * TEXTFLAGS_DICT, so the structured text here is built from the page's display list with the matching options.
 * Every function is synchronous.
 *
 * Bounds (not in PyMuPDF's walks; output under them is unchanged): `openPdf` rejects more than `maxPages` pages,
 * the page walks call an optional `checkpoint` before each page so a job's time limit stops them between pages,
 * and a render whose raster would pass `MAX_RENDER_PIXELS` or `MAX_RENDER_EDGE` is drawn at a smaller scale.
 */
import * as mupdf from 'mupdf';
import { logger } from '../logger.js';
import { PY_WORD, PY_WS, pyIsUpper, pyLen, pyRound, pySplit, pyStrip } from '../shared/pystr.js';

// MuPDF engine messages (repairs, font fallbacks) go to the process logger instead of raw stderr. The hook is
// process-wide and set once here, so it carries no job context (no per-job state, see the globals).
mupdf.setLog({
  warning: (message) => logger.warn({ mupdf: message }, 'mupdf_warning'),
  error: (message) => logger.warn({ mupdf: message }, 'mupdf_error'),
});

export class PdfOpenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PdfOpenError';
  }
}

export type PdfDoc = { readonly doc: mupdf.Document };

/** TEXTFLAGS_TEXT: preserve ligatures and whitespace, clip to the page, CID for unknown unicode. */
const TEXT_OPTIONS = 'preserve-ligatures,preserve-whitespace,use-cid-for-unknown-unicode';
/** TEXTFLAGS_DICT: the same plus preserve images (image blocks split text blocks and lines). */
const DICT_OPTIONS = `${TEXT_OPTIONS},preserve-images`;

/** The default for `openPdf`'s `maxPages` (the worker passes `MAX_PDF_PAGES`). */
export const DEFAULT_MAX_PDF_PAGES = 500;

/**
 * Open a PDF, or throw a `PdfOpenError` if it cannot be read, needs a password, has no pages or has more than
 * `maxPages` pages.
 */
export function openPdf(bytes: Uint8Array, { maxPages = DEFAULT_MAX_PDF_PAGES }: { maxPages?: number } = {}): PdfDoc {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  } catch (err) {
    throw new PdfOpenError(`cannot open PDF: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  let reason: string | null = null;
  try {
    if (doc.needsPassword()) reason = 'PDF is password protected';
    else {
      const pages = doc.countPages();
      if (pages === 0) reason = 'PDF has no pages';
      else if (pages > maxPages) reason = `PDF has ${pages} pages; the limit is ${maxPages}`;
    }
  } catch (err) {
    reason = `cannot read PDF: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (reason !== null) {
    doc.destroy();
    throw new PdfOpenError(reason);
  }
  return { doc };
}

export function closePdf(doc: PdfDoc): void {
  doc.doc.destroy();
}

export function pageCount(doc: PdfDoc): number {
  return doc.doc.countPages();
}

// --- Structured text --------------------------------------------------------------------------------------

type Rect = [number, number, number, number];

type FontInfo = { name: string; flags: number };

type Char = {
  c: string;
  size: number;
  font: FontInfo;
  /** RGB of the char's color (alpha is not exposed by the walker). */
  rgb: number;
  bidi: number;
  superscript: boolean;
  bbox: Rect;
};

type Line = { bbox: Rect; chars: Char[] };
type Block = { bbox: Rect; lines: Line[] };

const TEXT_FONT_SUPERSCRIPT = 1;
const TEXT_FONT_ITALIC = 2;
const TEXT_FONT_SERIFED = 4;
const TEXT_FONT_MONOSPACED = 8;
const TEXT_FONT_BOLD = 16;

/** `fz_is_empty_rect`. */
const isEmpty = (r: Rect): boolean => r[0] >= r[2] || r[1] >= r[3];

/** `JM_rects_overlap`. */
const overlaps = (a: Rect, b: Rect): boolean => !(a[0] >= b[2] || a[1] >= b[3] || a[2] <= b[0] || a[3] <= b[1]);

/** `fz_intersect_rect` is empty. */
const intersectionEmpty = (a: Rect, b: Rect): boolean =>
  isEmpty([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);

/** `JM_font_name`: drop a 6-letter subset prefix ("ABCDEF+Name"). */
function fontName(name: string): string {
  return name.indexOf('+') === 6 ? name.slice(7) : name;
}

/** `JM_char_bbox`: the char quad's bounding rect, made at least `size` tall in vertical mode. */
function charBBox(quad: mupdf.Quad, wmode: number, size: number): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const r: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if (wmode && r[3] < r[1] + size) r[1] = r[3] - size;
  return r;
}

/**
 * Walk one page's structured text into blocks, lines and chars, with PyMuPDF's per-char font flags.
 *
 * mupdf.js's walker builds each char with `String.fromCharCode`, which truncates code points above U+FFFF.
 * `asText()` writes every char as UTF-8 in the same order (one line per text line, a blank line per block),
 * so the true code points are taken from it while the two line up. From the first mismatch on, the walker's
 * chars are kept and `aligned` is false: any later astral char on the page is then a truncated BMP unit.
 * (The one known trigger is a lone surrogate, which `asText()` writes as three U+FFFD.) Like PyMuPDF's
 * `make_escape`, an orphaned surrogate becomes U+FFFD.
 */
function readPage(
  doc: PdfDoc,
  index: number,
  options: string,
): { bounds: Rect; blocks: Block[]; aligned: boolean } {
  const page = doc.doc.loadPage(index);
  try {
    const list = page.toDisplayList(true);
    try {
      const stext = list.toStructuredText(options);
      try {
        return walkPage(stext, list.getBounds() as Rect);
      } finally {
        stext.destroy();
      }
    } finally {
      list.destroy();
    }
  } finally {
    page.destroy();
  }
}

function walkPage(stext: mupdf.StructuredText, bounds: Rect): { bounds: Rect; blocks: Block[]; aligned: boolean } {
  const fonts = new Map<number, FontInfo>();
  const blocks: Block[] = [];
  const text = Array.from(stext.asText());
  let pos = 0;
  let aligned = true;
  const expectBreak = (): void => {
    if (text[pos] === '\n') pos++;
    else aligned = false;
  };
  let line: Line | null = null;
  let wmode = 0;
  let horizontal = false;
  let firstOriginY = 0;
  stext.walk({
    beginTextBlock(bbox) {
      blocks.push({ bbox: bbox as Rect, lines: [] });
    },
    beginLine(bbox, lineWmode, dir) {
      line = { bbox: bbox as Rect, chars: [] };
      blocks[blocks.length - 1]!.lines.push(line);
      wmode = lineWmode;
      horizontal = lineWmode === 0 && dir[0] === 1 && dir[1] === 0;
    },
    onChar(c, origin, font, size, quad, color, bidi) {
      // The walker wraps each char's font in a new Font; read it once per font, then free the wrapper.
      let info = fonts.get(font.pointer);
      try {
        if (!info) {
          info = {
            name: fontName(font.getName()),
            flags:
              (font.isItalic() ? TEXT_FONT_ITALIC : 0) +
              (font.isSerif() ? TEXT_FONT_SERIFED : 0) +
              (font.isMono() ? TEXT_FONT_MONOSPACED : 0) +
              (font.isBold() ? TEXT_FONT_BOLD : 0),
          };
          fonts.set(font.pointer, info);
        }
      } finally {
        font.destroy();
      }
      const cur = line!;
      if (cur.chars.length === 0) firstOriginY = origin[1];
      let ch = c;
      if (aligned) {
        const real = text[pos];
        if (real !== undefined && (real.codePointAt(0)! & 0xffff) === c.charCodeAt(0)) {
          ch = real;
          pos++;
        } else aligned = false;
      }
      if (/^[\uD800-\uDFFF]$/.test(ch)) ch = String.fromCodePoint(0xfffd);
      const [r, g, b] = color as number[];
      cur.chars.push({
        c: ch,
        size,
        font: info,
        rgb: (Math.round(r! * 255) << 16) | (Math.round(g! * 255) << 8) | Math.round(b! * 255),
        bidi,
        superscript: horizontal && origin[1] < firstOriginY - size * 0.1,
        bbox: charBBox(quad, wmode, size),
      });
    },
    endLine() {
      if (aligned) expectBreak();
    },
    endTextBlock() {
      if (aligned) expectBreak();
    },
  });
  return { bounds, blocks, aligned };
}

/** Optional sink for extraction warnings (a pino logger fits). */
export interface PdfWarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** One warning per call listing the pages (0-based) whose astral chars could not be recovered. */
function warnMisaligned(log: PdfWarnLogger | undefined, pages: number[]): void {
  if (log && pages.length > 0)
    log.warn({ pages }, 'pdf text walk and asText() disagree; chars above U+FFFF on these pages may be truncated');
}

/** Called before each page a walk reads; it throws to stop the walk (a job's time limit or abort). */
export type PdfCheckpoint = () => void;

/**
 * `page.get_text()` for each page: `JM_print_stext_page_as_text`. With `pages`, only the first `pages` pages
 * are read.
 */
export function extractPagesText(
  doc: PdfDoc,
  log?: PdfWarnLogger,
  { pages = Infinity, checkpoint }: { pages?: number; checkpoint?: PdfCheckpoint } = {},
): string[] {
  const out: string[] = [];
  const misaligned: number[] = [];
  const n = Math.min(pageCount(doc), pages);
  for (let i = 0; i < n; i++) {
    checkpoint?.();
    const { bounds, blocks, aligned } = readPage(doc, i, TEXT_OPTIONS);
    if (!aligned) misaligned.push(i);
    let s = '';
    for (const block of blocks)
      for (const line of block.lines) {
        let last = '';
        for (const ch of line.chars) {
          if (!overlaps(bounds, ch.bbox)) continue;
          last = ch.c;
          s += ch.c;
        }
        if (last !== '\n' && last !== '' && last !== '\0') s += '\n';
      }
    out.push(s);
  }
  warnMisaligned(log, misaligned);
  return out;
}

// --- Markdown (extract_text_pymupdf) ----------------------------------------------------------------------

type Span = { text: string; size: number; flags: number; font: string; bbox: Rect };

/** `JM_make_text_block` + `JM_make_spanlist` for the lines of a page, as `get_text("dict")` exposes them. */
function pageSpanLines(doc: PdfDoc, index: number, misaligned: number[]): Span[][] {
  const { bounds, blocks, aligned } = readPage(doc, index, DICT_OPTIONS);
  if (!aligned) misaligned.push(index);
  const lines: Span[][] = [];
  for (const block of blocks) {
    if (intersectionEmpty(bounds, block.bbox)) continue;
    for (const line of block.lines) {
      if (intersectionEmpty(bounds, line.bbox)) continue;
      const spans: Span[] = [];
      let span: Span | null = null;
      let key = { size: -1, flags: -1, font: '', rgb: -1, bidi: 0 };
      for (const ch of line.chars) {
        if (!overlaps(bounds, ch.bbox)) continue;
        const flags = ch.font.flags + (ch.superscript ? TEXT_FONT_SUPERSCRIPT : 0);
        if (
          ch.size !== key.size ||
          flags !== key.flags ||
          ch.rgb !== key.rgb ||
          ch.font.name !== key.font ||
          ch.bidi !== key.bidi
        ) {
          if (span) spans.push(span);
          key = { size: ch.size, flags, font: ch.font.name, rgb: ch.rgb, bidi: ch.bidi };
          span = { text: '', size: ch.size, flags, font: ch.font.name, bbox: ch.bbox };
        }
        span!.text += ch.c;
        span!.bbox = union(span!.bbox, ch.bbox);
      }
      // Only the last span is dropped when its rect is empty (as in JM_make_spanlist).
      if (span && !isEmpty(span.bbox)) spans.push(span);
      lines.push(spans);
    }
  }
  return lines;
}

/** `fz_union_rect`: invalid (inverted) rects are ignored. */
function union(a: Rect, b: Rect): Rect {
  const valid = (r: Rect): boolean => r[0] <= r[2] && r[1] <= r[3];
  if (!valid(b)) return a;
  if (!valid(a)) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

const BOLD_NAME_PARTS = ['.B', 'Bold', '-Bold', 'bold', '.b', '-Bd', 'Bd'];

/** `_is_bold_span`: the bold flag or a bold-looking font name. */
function isBoldSpan(span: Span): boolean {
  if (span.flags & TEXT_FONT_BOLD) return true;
  return BOLD_NAME_PARTS.some((b) => span.font.includes(b));
}

/** `_analyze_font_stats`: the char-weighted mode of round(size, 1) over the first 10 pages. */
function bodySize(pages: Span[][][]): number {
  const sizeChars = new Map<number, number>();
  for (const lines of pages)
    for (const spans of lines)
      for (const span of spans) {
        const text = pyStrip(span.text);
        if (!text) continue;
        const size = pyRound(span.size, 1);
        sizeChars.set(size, (sizeChars.get(size) ?? 0) + pyLen(text));
      }
  // Counter.most_common(1): the first-inserted key among those with the highest count.
  let best = 10.0;
  let bestCount = -1;
  for (const [size, count] of sizeChars)
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  return best;
}

// Python's re: `\s` is str.isspace, `\d` is any Unicode decimal digit, `\w` is PY_WORD, and IGNORECASE also
// lets "i" match U+0130 and U+0131 (JS's `iu` already covers U+212A for "k" and U+017F for "s").
const S = `[${PY_WS}]`;
const HEADING_PATTERNS = new RegExp(
  ('^(abstract|introduction|background|literature\\s+review|related\\s+work|' +
    'methods?|methodology|approach|materials?\\s+and\\s+methods?|' +
    'results?|findings?|analysis|' +
    'discussion|conclusion|conclusions|summary|' +
    'limitations?|future\\s+work|implications?|' +
    'references?|bibliography|appendix|appendices|' +
    'acknowledgm?ents?|funding|declarations?|' +
    'supplementary|data\\s+availability|ethics|' +
    'theoretical\\s+framework|conceptual\\s+framework|' +
    'research\\s+design|study\\s+design|participants?|' +
    'data\\s+collection|data\\s+analysis|procedure|' +
    'key\\s+findings|main\\s+findings|' +
    'recommendations?|policy\\s+implications?)$'
  )
    .replace(/i/g, '[i\\u0130\\u0131]')
    .replace(/\\s/g, S),
  'iu',
);
const NUMBERED_HEADING = new RegExp(`^\\p{Nd}+\\.?\\p{Nd}*\\.?${S}+${PY_WORD}`, 'u');
const LEADING_NUMBER = new RegExp(`^\\p{Nd}+\\.?\\p{Nd}*\\.?${S}*`, 'u');
const PARENTHETICAL = /^\([^\n]*\)$/u;
const NUMERIC_JUNK = /^[\p{Nd}./:]+$/u;

/** `_is_heading`: 0 (not a heading), 1 (h1) or 2 (h2). */
function isHeading(text: string, fontSize: number, isBold: boolean, body: number, lineCharCount: number): number {
  const stripped = pyStrip(text);
  if (!stripped) return 0;

  const isAllcaps = pyIsUpper(stripped) && pyLen(stripped) > 2;
  const sizeRatio = body > 0 ? fontSize / body : 1.0;
  const isLarger = sizeRatio >= 1.1;

  const cleanText = pyStrip(stripped.replace(LEADING_NUMBER, ''));
  const isKnownHeading = HEADING_PATTERNS.test(cleanText);
  const isNumbered = NUMBERED_HEADING.test(stripped);
  const words = pySplit(stripped).length;

  if (sizeRatio >= 1.5) return 1;
  if (isLarger && isKnownHeading) return 1;
  if (isLarger && lineCharCount < 80 && words <= 10) {
    if (isKnownHeading) return 1;
    if (words >= 2) return sizeRatio >= 1.3 ? 1 : 2;
  }
  if (isBold && isKnownHeading) return 1;
  if (isBold && isNumbered) return sizeRatio >= 1.0 ? 1 : 2;
  if (isBold && isLarger && lineCharCount < 80) return 1;
  if (isBold && lineCharCount < 60) {
    if (PARENTHETICAL.test(stripped)) return 0;
    if (NUMERIC_JUNK.test(stripped)) return 0;
    if (pyLen(stripped) < 3) return 0;
    if (isKnownHeading) return 1;
    if (words >= 3 && lineCharCount >= 10) return 2;
  }
  if (isAllcaps && lineCharCount < 60 && words >= 3) return 2;
  return 0;
}

/** `extract_text_pymupdf`: page text with `#`/`##` headings from font size, bold and section names. */
export function extractTextMarkdown(
  doc: PdfDoc,
  log?: PdfWarnLogger,
  { checkpoint }: { checkpoint?: PdfCheckpoint } = {},
): string {
  const n = pageCount(doc);
  const misaligned: number[] = [];
  const read = (i: number): Span[][] => {
    checkpoint?.();
    return pageSpanLines(doc, i, misaligned);
  };
  const statPages: Span[][][] = [];
  for (let i = 0; i < Math.min(10, n); i++) statPages.push(read(i));
  const body = bodySize(statPages);

  const pages: string[] = [];
  for (let i = 0; i < n; i++) {
    const lines = i < statPages.length ? statPages[i]! : read(i);
    const parts: string[] = [];
    for (const spans of lines) {
      let lineText = '';
      let maxSize = 0.0;
      let lineBold = false;
      for (const span of spans) {
        lineText += span.text;
        maxSize = Math.max(maxSize, span.size);
        if (isBoldSpan(span)) lineBold = true;
      }
      const text = pyStrip(lineText);
      if (!text) continue;
      const level = isHeading(text, maxSize, lineBold, body, pyLen(text));
      if (level === 1) parts.push(`\n# ${text}\n`);
      else if (level === 2) parts.push(`\n## ${text}\n`);
      else parts.push(text);
    }
    pages.push(parts.join('\n'));
  }
  warnMisaligned(log, misaligned);
  return pages.join('\n\n');
}

// --- Rendering --------------------------------------------------------------------------------------------

/** Most pixels in one page raster (75 MB of RGB); figure detection holds up to 4 at once. */
export const MAX_RENDER_PIXELS = 25_000_000;
/** Longest side of one page raster, in pixels. */
export const MAX_RENDER_EDGE = 10_000;

/** `fz_round_rect` of the page bounds under `matrix`, as PyMuPDF sizes the pixmap. */
function deviceBBox(page: mupdf.Page, matrix: mupdf.Matrix): Rect {
  const r = mupdf.Rect.transform(page.getBounds(), matrix);
  return [Math.floor(r[0] + 0.001), Math.floor(r[1] + 0.001), Math.ceil(r[2] - 0.001), Math.ceil(r[3] - 0.001)];
}

const overCap = (w: number, h: number): boolean => w * h > MAX_RENDER_PIXELS || Math.max(w, h) > MAX_RENDER_EDGE;

/**
 * The matrix and device bbox to render with: `matrix` itself when its raster fits the caps (every ordinary page,
 * so those match PyMuPDF), else `matrix` scaled down uniformly until it does. Checked before any allocation.
 */
function boundedRender(page: mupdf.Page, matrix: mupdf.Matrix): { matrix: mupdf.Matrix; bbox: Rect } {
  let bbox = deviceBBox(page, matrix);
  let w = bbox[2] - bbox[0];
  let h = bbox[3] - bbox[1];
  if (!bbox.every(Number.isFinite)) throw new RangeError(`page bounds are not finite ([${bbox.join(', ')}])`);
  if (!overCap(w, h)) return { matrix, bbox };
  const from = { width: w, height: h };
  // Rounding the scaled bbox outward can add a pixel per side, so aim a little under and shrink until it fits.
  let s = Math.min(Math.sqrt(MAX_RENDER_PIXELS / (w * h)), MAX_RENDER_EDGE / Math.max(w, h)) * 0.999;
  let scaled = matrix;
  for (let tries = 0; tries < 8; tries++, s *= 0.99) {
    scaled = mupdf.Matrix.concat(matrix, mupdf.Matrix.scale(s, s));
    bbox = deviceBBox(page, scaled);
    w = bbox[2] - bbox[0];
    h = bbox[3] - bbox[1];
    if (!overCap(w, h)) break;
  }
  if (overCap(w, h)) throw new RangeError(`cannot fit a ${from.width}x${from.height} page raster under the caps`);
  logger.warn({ from, to: { width: w, height: h } }, 'pdf_render_scaled_down');
  return { matrix: scaled, bbox };
}

/**
 * Draw the whole page like PyMuPDF's `JM_pixmap_from_display_list`, scaled down first if the raster would pass
 * the caps. The caller destroys the pixmap.
 */
function renderPixmap(page: mupdf.Page, requested: mupdf.Matrix): mupdf.Pixmap {
  const { matrix, bbox } = boundedRender(page, requested);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(matrix, pix);
    try {
      page.run(dev, mupdf.Matrix.identity);
      dev.close();
    } finally {
      dev.destroy();
    }
    return pix;
  } catch (err) {
    pix.destroy();
    throw err;
  }
}

function withPage<T>(doc: PdfDoc, index: number, fn: (page: mupdf.Page) => T): T {
  const page = doc.doc.loadPage(index);
  try {
    return fn(page);
  } finally {
    page.destroy();
  }
}

const scaleFor = (dpi: number): mupdf.Matrix => mupdf.Matrix.scale(dpi / 72, dpi / 72);

/**
 * Render a page as RGB (no alpha) with `scale(dpi / 72)`, like `page.get_pixmap(matrix=...)`; a page too large
 * for the raster caps comes back at a lower effective dpi (see `width`/`height`).
 */
export function renderPage(doc: PdfDoc, index: number, dpi: number): { png: Uint8Array; width: number; height: number } {
  return withPage(doc, index, (page) => {
    const pix = renderPixmap(page, scaleFor(dpi));
    try {
      return { png: pix.asPNG(), width: pix.getWidth(), height: pix.getHeight() };
    } finally {
      pix.destroy();
    }
  });
}

/** A page rendered once: its PNG for a detector, plus crops copied from that same pixmap. */
export interface RenderedPage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  crop(box: [number, number, number, number]): { png: Uint8Array; width: number; height: number };
  /** Frees the pixmap. Idempotent; `crop` throws afterwards. */
  dispose(): void;
}

/**
 * Render a page once (the `renderPage` path) and keep the pixmap so any number of boxes can be cropped
 * from it, as the Python worker crops every box from the one raster the VLM saw. The caller must `dispose()`.
 */
export function openRenderedPage(doc: PdfDoc, index: number, dpi: number): RenderedPage {
  const src = withPage(doc, index, (page) => renderPixmap(page, scaleFor(dpi)));
  let png: Uint8Array;
  try {
    png = src.asPNG();
  } catch (err) {
    src.destroy();
    throw err;
  }
  const pageW = src.getWidth();
  const pageH = src.getHeight();
  let disposed = false;
  return {
    png,
    width: pageW,
    height: pageH,
    crop(box) {
      if (disposed) throw new Error('rendered page already disposed');
      const [x0, y0, x1, y1] = box;
      if (!box.every(Number.isInteger) || x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > pageW || y1 > pageH)
        throw new RangeError(`crop box [${box.join(', ')}] is not inside the ${pageW}x${pageH} page`);
      const w = x1 - x0;
      const h = y1 - y0;
      const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
      try {
        // Take both heap views after the last allocation (WASM memory growth would detach them).
        const from = src.getPixels();
        const to = out.getPixels();
        const srcStride = src.getStride();
        const outStride = out.getStride();
        for (let y = 0; y < h; y++) {
          const at = (y0 + y) * srcStride + x0 * 3;
          to.set(from.subarray(at, at + w * 3), y * outStride);
        }
        return { png: out.asPNG(), width: w, height: h };
      } finally {
        out.destroy();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      src.destroy();
    },
  };
}

/**
 * The device-pixel `box` (x0, y0, x1, y1) of `renderPage`'s output. Like the Python worker, which crops the
 * full render with PIL, it renders the whole page and copies the box out, so the pixels equal that
 * sub-rectangle by construction (MuPDF's image drawing depends on the clip, so drawing only the box would
 * not). The box must be whole pixels inside the page with x1 > x0 and y1 > y0. For several boxes on one
 * page use `openRenderedPage`.
 */
export function cropPage(
  doc: PdfDoc,
  index: number,
  dpi: number,
  box: [number, number, number, number],
): { png: Uint8Array; width: number; height: number } {
  const page = openRenderedPage(doc, index, dpi);
  try {
    return page.crop(box);
  } finally {
    page.dispose();
  }
}
