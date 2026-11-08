import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closePdf,
  cropPage,
  DEFAULT_MAX_PAGE_CHARS,
  extractPagesText,
  extractTextMarkdown,
  MAX_RENDER_EDGE,
  MAX_RENDER_PIXELS,
  openPdf,
  openRenderedPage,
  pageCount,
  PdfLimitError,
  PdfOpenError,
  renderPage,
  type PdfDoc,
} from '../../src/ingest/pdf.js';
import { formBomb, glyphPages } from '../helpers/pdfBombs.js';

// Goldens come from worker/lib/pdf_extractor.py run on sample.pdf inside the ficino-worker image
// (PyMuPDF 1.28.0); see test/fixtures/goldens/README.md (tag `python-final`).
const fixture = (name: string): string => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const SAMPLE = new Uint8Array(readFileSync(fixture('sample.pdf')));
const GOLDEN_MD = readFileSync(fixture('goldens/sample.pymupdf.md'), 'utf8');
const GOLDEN_PAGES = JSON.parse(readFileSync(fixture('goldens/sample.pages.json'), 'utf8')) as string[];
type RasterPage = { width: number; height: number; probes: { x: number; y: number; rgb: number[] }[] };
const GOLDEN_RASTER = JSON.parse(readFileSync(fixture('goldens/sample.raster.json'), 'utf8')) as RasterPage[];

/** Decode a PNG with mupdf into packed RGB rows (copied out of the WASM heap). */
function decode(png: Uint8Array): { w: number; h: number; n: number; px: Uint8ClampedArray } {
  const image = new mupdf.Image(png);
  try {
    const pix = image.toPixmap();
    try {
      expect(pix.getStride()).toBe(pix.getWidth() * pix.getNumberOfComponents());
      return { w: pix.getWidth(), h: pix.getHeight(), n: pix.getNumberOfComponents(), px: pix.getPixels().slice() };
    } finally {
      pix.destroy();
    }
  } finally {
    image.destroy();
  }
}

/** Assert `part` is exactly the `box` sub-rectangle of `full`. */
function expectSubRect(full: ReturnType<typeof decode>, part: ReturnType<typeof decode>, box: number[]): void {
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  expect([part.w, part.h, part.n]).toEqual([x1 - x0, y1 - y0, 3]);
  for (let y = 0; y < part.h; y++) {
    const want = full.px.subarray(((y0 + y) * full.w + x0) * 3, ((y0 + y) * full.w + x1) * 3);
    const got = part.px.subarray(y * part.w * 3, (y + 1) * part.w * 3);
    expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
  }
}

describe('pdf extraction (pinned to PyMuPDF goldens)', () => {
  let doc: PdfDoc;
  beforeAll(() => {
    doc = openPdf(SAMPLE);
  });
  afterAll(() => closePdf(doc));

  it('counts pages', () => expect(pageCount(doc)).toBe(3));

  it('extractTextMarkdown equals extract_text_pymupdf byte for byte', () => {
    expect(Buffer.from(extractTextMarkdown(doc), 'utf8').equals(Buffer.from(GOLDEN_MD, 'utf8'))).toBe(true);
    expect(extractTextMarkdown(doc)).toBe(GOLDEN_MD);
  });

  it('extractPagesText equals extract_pages_text', () => {
    expect(extractPagesText(doc)).toEqual(GOLDEN_PAGES);
  });

  it('renderPage at 150 dpi matches the golden size and probe pixels', () => {
    expect(GOLDEN_RASTER).toHaveLength(3);
    GOLDEN_RASTER.forEach((golden, i) => {
      const out = renderPage(doc, i, 150);
      expect([out.width, out.height]).toEqual([golden.width, golden.height]);
      const img = decode(out.png);
      expect([img.w, img.h, img.n]).toEqual([golden.width, golden.height, 3]);
      for (const { x, y, rgb } of golden.probes) {
        const at = (y * img.w + x) * 3;
        // ±2 per channel: anti-aliasing can differ between the WASM build and PyMuPDF's native build.
        for (let c = 0; c < 3; c++) expect(Math.abs(img.px[at + c]! - rgb[c]!)).toBeLessThanOrEqual(2);
      }
    });
  });

  it('cropPage renders exactly that region of renderPage', () => {
    const full = decode(renderPage(doc, 0, 150).png);
    const crop = cropPage(doc, 0, 150, [10, 20, 110, 70]);
    expect([crop.width, crop.height]).toEqual([100, 50]);
    expectSubRect(full, decode(crop.png), [10, 20, 110, 70]);
  });

  it('cropPage pixels equal renderPage over a region with chart bars and text', () => {
    const full = decode(renderPage(doc, 1, 150).png);
    expectSubRect(full, decode(cropPage(doc, 1, 150, [400, 700, 900, 1100]).png), [400, 700, 900, 1100]);
  });

  it('cropPage rejects a box that is empty, fractional or outside the page', () => {
    for (const box of [
      [10, 10, 10, 20],
      [10, 20, 5, 30],
      [-1, 0, 10, 10],
      [0, 0, 1276, 10],
      [0, 0, 10, 1651],
      [0.5, 0, 10, 10],
    ] as [number, number, number, number][])
      expect(() => cropPage(doc, 0, 150, box)).toThrow(RangeError);
    expect(cropPage(doc, 0, 150, [0, 0, 1275, 1650]).width).toBe(1275);
  });
});

/** A one-page PDF from raw object bodies (object 1 is the catalog). */
function rawPdf(objs: string[]): Uint8Array {
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('characters outside the BMP', () => {
  // mupdf.js's StructuredText.walk truncates code points above U+FFFF; pdf.ts recovers them from asText().
  // F1 maps CID 1 to U+1D465 (MATHEMATICAL ITALIC SMALL X) via ToUnicode; F2 has no ToUnicode at all.
  // Expected values were checked against PyMuPDF 1.28.0 in the ficino-worker image.
  const cmap =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def ' +
    '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0001> <D835DC65> endbfchar ' +
    'endcmap CMapName currentdict /CMap defineresource pop end end';
  const content = 'BT /F1 12 Tf 72 700 Td <00010001> Tj ET BT /F2 12 Tf 72 650 Td <00410042> Tj ET';
  const cidFont = (name: string): string =>
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} ` +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
    `/FontDescriptor << /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [0 0 1000 1000] ` +
    '/ItalicAngle 0 /Ascent 900 /Descent -100 /CapHeight 700 /StemV 80 >> /DW 1000 >>';
  const bytes = rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 7 0 R >> >> ' +
      '/Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /MathA /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    cidFont('MathA'),
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /NoMap /Encoding /Identity-H /DescendantFonts [8 0 R] >>',
    cidFont('NoMap'),
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);

  it('keeps the full code point in both extractions', () => {
    const doc = openPdf(bytes);
    try {
      expect(extractPagesText(doc)).toEqual(['\u{1d465}\u{1d465}\n^_\n']);
      expect(extractTextMarkdown(doc)).toBe('\u{1d465}\u{1d465}\n^_');
    } finally {
      closePdf(doc);
    }
  });

  it('warns when the walk and asText() drift apart, and keeps the walker chars from there on', () => {
    // A ToUnicode entry that is a lone surrogate: asText() writes it as three U+FFFD, the walker as one unit,
    // so alignment is lost. The astral char on the next line then comes back truncated to U+D465, where
    // PyMuPDF 1.28.0 gives "A\ufffdA\n\U0001d465A\n". The warning is how callers learn about it.
    const loneCmap = cmap.replace(
      '1 beginbfchar <0001> <D835DC65> endbfchar',
      '3 beginbfchar <0001> <D835> <0002> <D835DC65> <0003> <0041> endbfchar',
    );
    const loneContent = 'BT /F1 12 Tf 72 700 Td <000300010003> Tj ET BT /F1 12 Tf 72 650 Td <00020003> Tj ET';
    const lone = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /MathA /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
      cidFont('MathA'),
      `<< /Length ${loneCmap.length} >>\nstream\n${loneCmap}\nendstream`,
      `<< /Length ${loneContent.length} >>\nstream\n${loneContent}\nendstream`,
    ]);
    const doc = openPdf(lone);
    try {
      const log = { warn: vi.fn() };
      expect(extractPagesText(doc, log)).toEqual(['A\ufffdA\n\ud465A\n']);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]![0]).toEqual({ pages: [0] });
      log.warn.mockClear();
      expect(extractTextMarkdown(doc, log)).toBe('A\ufffdA\n\ud465A');
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]![0]).toEqual({ pages: [0] });
    } finally {
      closePdf(doc);
    }
  });

  it('does not warn when every page lines up', () => {
    const doc = openPdf(bytes);
    try {
      const log = { warn: vi.fn() };
      extractPagesText(doc, log);
      extractTextMarkdown(doc, log);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      closePdf(doc);
    }
  });
});

describe('cropPage with raster images', () => {
  // MuPDF draws images differently under a smaller clip, so cropPage must cut from the full render.
  // Page 1 has a small image scaled up (non-integer scale) and a large one sheared; both hold noise.
  const noise = (w: number, h: number, seed: number): mupdf.Image => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    try {
      const px = pix.getPixels();
      let s = seed;
      for (let i = 0; i < px.length; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        px[i] = s >> 16;
      }
      return new mupdf.Image(pix);
    } finally {
      pix.destroy();
    }
  };
  let bytes: Uint8Array;
  beforeAll(() => {
    const pdf = new mupdf.PDFDocument();
    const small = noise(37, 23, 12345);
    const large = noise(600, 440, 777);
    const res = pdf.newDictionary();
    const xobjects = pdf.newDictionary();
    xobjects.put('Im0', pdf.addImage(small));
    xobjects.put('Im1', pdf.addImage(large));
    res.put('XObject', xobjects);
    const content =
      'q 301.3 0 0 187.7 50.2 400.4 cm /Im0 Do Q q 1 0 0.2 1 0 0 cm 400.7 0 0 290.3 100.1 60.6 cm /Im1 Do Q';
    pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, res, content));
    const buf = pdf.saveToBuffer('');
    bytes = buf.asUint8Array().slice();
    buf.destroy();
    small.destroy();
    large.destroy();
    pdf.destroy();
  });

  it.each([150, 96])('crops equal the full render at %d dpi', (dpi) => {
    const doc = openPdf(bytes);
    try {
      const full = decode(renderPage(doc, 0, dpi).png);
      // Boxes cutting through the scaled image, the sheared image, both, and the image edges.
      const s = dpi / 72;
      const boxes = [
        [50.2, 404.4, 351.5, 592.1],
        [60, 410, 200, 500],
        [100, 60, 600, 360],
        [150, 100, 220, 170],
        [40, 200, 612, 600],
      ].map((b) => [
        Math.floor(b[0]! * s),
        Math.floor((792 - b[3]!) * s),
        Math.ceil(b[2]! * s),
        Math.ceil((792 - b[1]!) * s),
      ]);
      for (const box of boxes) expectSubRect(full, decode(cropPage(doc, 0, dpi, box as never).png), box);
    } finally {
      closePdf(doc);
    }
  });
});

describe('openPdf', () => {
  it('throws PdfOpenError on %PDF- followed by junk', () => {
    expect(() => openPdf(new TextEncoder().encode('%PDF-1.7\nthis is not a pdf at all \x00\x01\x02'))).toThrow(
      PdfOpenError,
    );
  });

  it('throws PdfOpenError on an empty buffer', () => {
    expect(() => openPdf(new Uint8Array())).toThrow(PdfOpenError);
  });

  it('throws PdfOpenError on an encrypted PDF', () => {
    const pdf = new mupdf.PDFDocument();
    pdf.insertPage(-1, pdf.addPage([0, 0, 200, 200], 0, pdf.newDictionary(), ''));
    const buf = pdf.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner');
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    pdf.destroy();
    // The same bytes open fine once the password is known, so the error really is the password check.
    const raw = mupdf.Document.openDocument(bytes, 'application/pdf');
    try {
      expect(raw.needsPassword()).toBe(true);
      expect(raw.authenticatePassword('secret')).toBeGreaterThan(0);
    } finally {
      raw.destroy();
    }
    expect(() => openPdf(bytes)).toThrow(PdfOpenError);
  });

  it('throws PdfOpenError on a PDF with no pages', () => {
    const pdf = new mupdf.PDFDocument();
    const buf = pdf.saveToBuffer('');
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    pdf.destroy();
    expect(() => openPdf(bytes)).toThrow(PdfOpenError);
  });
});

/** A PDF with one page per mediabox, every page sharing one small text content stream. */
function pdfWithPages(mediaboxes: Array<[number, number, number, number]>): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const font = pdf.addSimpleFont(new mupdf.Font('Helvetica'));
    const contents = pdf.addStream('BT /F1 10 Tf 20 20 Td (bounded page) Tj ET', {});
    for (const box of mediaboxes) {
      const page = pdf.addPage(box, 0, { Font: { F1: font } }, '');
      page.put('Contents', contents);
      pdf.insertPage(-1, page);
    }
    const buf = pdf.saveToBuffer('compress');
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    pdf.destroy();
  }
}

const letter = (n: number) => Array.from({ length: n }, (): [number, number, number, number] => [0, 0, 612, 792]);

describe('page cap', () => {
  it('openPdf rejects more pages than maxPages with a PdfOpenError naming both counts', () => {
    const bytes = pdfWithPages(letter(4));
    expect(() => openPdf(bytes, { maxPages: 3 })).toThrow(PdfOpenError);
    expect(() => openPdf(bytes, { maxPages: 3 })).toThrow('PDF has 4 pages; the limit is 3');
    const doc = openPdf(bytes, { maxPages: 4 });
    try {
      expect(pageCount(doc)).toBe(4);
    } finally {
      closePdf(doc);
    }
  });

  it('openPdf defaults to a 500-page cap', () => {
    expect(() => openPdf(pdfWithPages(letter(501)))).toThrow('PDF has 501 pages; the limit is 500');
    closePdf(openPdf(pdfWithPages(letter(500))));
  });
});

describe('raster cap', () => {
  const pngSize = (png: Uint8Array) => {
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  };

  it('scales a huge page down under the pixel and edge caps instead of allocating it', () => {
    // 14400 pt square at 150 dpi would be a 30000 x 30000 px (2.7 GB) pixmap.
    const doc = openPdf(pdfWithPages([[0, 0, 14400, 14400]]));
    try {
      const r = renderPage(doc, 0, 150);
      expect(r.width * r.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
      expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(MAX_RENDER_EDGE);
      expect(Math.abs(r.width - r.height)).toBeLessThanOrEqual(1);
      expect(r.width).toBeGreaterThanOrEqual(0.99 * Math.sqrt(MAX_RENDER_PIXELS)); // scaled to the cap, not far under it
      expect(pngSize(r.png)).toEqual({ w: r.width, h: r.height });

      const page = openRenderedPage(doc, 0, 150);
      try {
        expect([page.width, page.height]).toEqual([r.width, r.height]);
        expect(page.crop([0, 0, 10, 10]).width).toBe(10);
      } finally {
        page.dispose();
      }
    } finally {
      closePdf(doc);
    }
  });

  it('caps the long side of a thin page at the edge limit', () => {
    const doc = openPdf(pdfWithPages([[0, 0, 14400, 100]]));
    try {
      const r = renderPage(doc, 0, 150);
      expect(r.width).toBeLessThanOrEqual(MAX_RENDER_EDGE);
      expect(r.width).toBeGreaterThanOrEqual(0.99 * MAX_RENDER_EDGE);
      expect(r.height).toBeGreaterThan(0);
      expect(r.height).toBeLessThanOrEqual(Math.ceil((100 * MAX_RENDER_EDGE) / 14400) + 1);
    } finally {
      closePdf(doc);
    }
  });

  it('leaves a page under the caps at its requested dpi', () => {
    const doc = openPdf(pdfWithPages([[0, 0, 612, 792]]));
    try {
      const r = renderPage(doc, 0, 150);
      expect([r.width, r.height]).toEqual([1275, 1650]);
    } finally {
      closePdf(doc);
    }
  });
});

describe('checkpoint between pages', () => {
  it('extractTextMarkdown and extractPagesText call it before each page and keep the golden output', () => {
    const doc = openPdf(SAMPLE);
    try {
      let calls = 0;
      const checkpoint = () => void calls++;
      expect(extractTextMarkdown(doc, undefined, { checkpoint })).toBe(GOLDEN_MD);
      expect(calls).toBe(3);
      calls = 0;
      expect(extractPagesText(doc, undefined, { checkpoint })).toEqual(GOLDEN_PAGES);
      expect(calls).toBe(3);
    } finally {
      closePdf(doc);
    }
  });

  it('a checkpoint that throws stops the walk at that page', () => {
    const doc = openPdf(pdfWithPages(letter(6)));
    const loads = vi.spyOn(doc.doc, 'loadPage');
    try {
      const stop = new Error('time is up');
      let calls = 0;
      const checkpoint = () => {
        if (++calls === 3) throw stop;
      };
      expect(() => extractTextMarkdown(doc, undefined, { checkpoint })).toThrow(stop);
      expect(loads).toHaveBeenCalledTimes(2);
      loads.mockClear();
      calls = 0;
      expect(() => extractPagesText(doc, undefined, { checkpoint })).toThrow(stop);
      expect(loads).toHaveBeenCalledTimes(2);
    } finally {
      loads.mockRestore();
      closePdf(doc);
    }
  });

  it('extractPagesText reads only the first `pages` pages when asked', () => {
    const doc = openPdf(SAMPLE);
    try {
      expect(extractPagesText(doc, undefined, { pages: 2 })).toEqual(GOLDEN_PAGES.slice(0, 2));
      expect(extractPagesText(doc, undefined, { pages: 99 })).toEqual(GOLDEN_PAGES);
    } finally {
      closePdf(doc);
    }
  });
});

describe('per-page character cap', () => {
  it('defaults to DEFAULT_MAX_PAGE_CHARS and leaves the golden output unchanged', () => {
    expect(DEFAULT_MAX_PAGE_CHARS).toBe(200_000);
    const doc = openPdf(SAMPLE, { maxPageChars: 2000 });
    try {
      expect(extractTextMarkdown(doc)).toBe(GOLDEN_MD);
      expect(extractPagesText(doc)).toEqual(GOLDEN_PAGES);
    } finally {
      closePdf(doc);
    }
  });

  it('a page at the cap is read; one character over it fails both walks with a PdfLimitError', () => {
    const at = openPdf(glyphPages([10, 3000]), { maxPageChars: 3000 });
    try {
      expect(extractPagesText(at)[1]!.replace(/\n/g, '')).toBe('a'.repeat(3000));
      expect(extractTextMarkdown(at)).toContain('a'.repeat(1000));
    } finally {
      closePdf(at);
    }
    const over = openPdf(glyphPages([10, 3000]), { maxPageChars: 2999 });
    try {
      expect(() => extractTextMarkdown(over)).toThrow(PdfLimitError);
      expect(() => extractTextMarkdown(over)).toThrow('page 2 has more than 2999 characters');
      expect(() => extractPagesText(over)).toThrow(PdfLimitError);
    } finally {
      closePdf(over);
    }
  });

  it('stops the walk at the cap, before the page text is copied out', () => {
    const doc = openPdf(glyphPages([5000]), { maxPageChars: 100 });
    const asText = vi.spyOn(mupdf.StructuredText.prototype, 'asText');
    try {
      expect(() => extractTextMarkdown(doc)).toThrow(PdfLimitError);
      expect(asText).not.toHaveBeenCalled();
    } finally {
      asText.mockRestore();
      closePdf(doc);
    }
  });

  it('counts glyphs a form draws many times (a small file cannot hide a huge page)', () => {
    // 10^4 draws of a 2-glyph form: 20,000 chars from about 2 KB.
    const doc = openPdf(formBomb(4, 10, 'BT /F1 1 Tf 10 10 Td (ab) Tj ET'), { maxPageChars: 10_000 });
    try {
      expect(() => extractPagesText(doc)).toThrow(PdfLimitError);
    } finally {
      closePdf(doc);
    }
  });
});
