import type { ProviderConfig } from './config.js';
import type { ProviderDeps } from './deps.js';
import { logger } from '../logger.js';
import { pySlice, pyStr, pyStrip } from '../shared/pystr.js';
import { fetchJson } from './http.js';

// Port of worker/lib/figure_detector.py.

/** Authoritative figure_type values; a detector returning anything else is coerced to "other". */
export const FIGURE_TYPES = [
  'chart_bar', 'chart_line', 'chart_scatter', 'chart_other',
  'diagram', 'schematic', 'flowchart', 'algorithm',
  'photograph', 'map', 'micrograph', 'anatomical',
  'table_image', 'other',
] as const;

export type Detection = {
  bbox: [number, number, number, number];
  type: string;
  caption: string;
  figure_number: string;
  data_claim: string;
  referenced_paragraph: string;
  confidence: number;
};

const SYSTEM_PROMPT =
  'You identify the scientific figures on one page of an academic ' +
  'paper. A scientific figure is something the paper treats as data or ' +
  'evidence: charts, plots, diagrams, schematics, flowcharts, ' +
  'algorithm blocks, photographs of study subjects or field sites, ' +
  'maps, micrographs, anatomical illustrations, or table-as-image. ' +
  'You IGNORE anything that is NOT a scientific figure: UI glyphs, ' +
  'publisher logos, running-header icons, page-number badges, ' +
  'branding marks, decorative drop-caps, Creative Commons / license ' +
  'badges, QR codes, navigation arrows, social-media icons, and ' +
  'institutional wordmarks. If a page contains no scientific figures, ' +
  'return an empty list. ' +
  'You return strict JSON only — no prose, no code fences, no commentary.';

function buildUserPrompt(pageNumber: number, pageText: string): string {
  const truncatedText = pySlice(pageText, 0, 8000);
  return (
    `This is page ${pageNumber} of a scientific paper. ` +
    `The page's text layer, for your reference:\n\n` +
    `<page_text>\n${truncatedText}\n</page_text>\n\n` +
    'Return a JSON object of the form:\n' +
    '{\n' +
    '  "figures": [\n' +
    '    {\n' +
    '      "bbox": [x0, y0, x1, y1],   // normalized 0.0-1.0, relative to the page image\n' +
    '      "type": "chart_bar" | "chart_line" | "chart_scatter" | "chart_other" |\n' +
    '              "diagram" | "schematic" | "flowchart" | "algorithm" |\n' +
    '              "photograph" | "map" | "micrograph" | "anatomical" |\n' +
    '              "table_image" | "other",\n' +
    '      "caption": "Exact caption text, e.g. \\"Fig. 5. ...\\"",\n' +
    '      "figure_number": "5" | "5a" | "S3" | "" (if caption carries no number),\n' +
    '      "data_claim": "One sentence, taken from caption or surrounding text, describing what this figure is evidence of",\n' +
    '      "referenced_paragraph": "The first paragraph on this page that cites this figure by number, or empty string",\n' +
    '      "confidence": 0.0-1.0\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Rules:\n' +
    '- Do not return icons, logos, UI glyphs, or branding marks.\n' +
    '- bbox tightly frames the figure AND its caption if the caption is adjacent.\n' +
    '- If a single figure has multiple panels labeled (a), (b), (c), return ONE entry whose bbox covers all panels.\n' +
    '- Empty list is correct when the page has no scientific figures.\n' +
    '- Output strict JSON, no markdown, no prose.'
  );
}

const ALIASES: Record<string, string> = {
  chart: 'chart_other', plot: 'chart_other', graph: 'chart_other',
  bar_chart: 'chart_bar', line_chart: 'chart_line', scatter_plot: 'chart_scatter',
  scatterplot: 'chart_scatter', histogram: 'chart_bar',
  flow_chart: 'flowchart', block_diagram: 'diagram',
  pseudocode: 'algorithm', pseudo_code: 'algorithm',
  picture: 'photograph', image: 'photograph',
  table: 'table_image',
};

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Python `float(v)` for a JSON value, or null where it would raise (None, list, dict, junk string). */
function pyFloat(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = pyStrip(v).replace(/(?<=\d)_(?=\d)/g, '');
    return FLOAT_RE.test(s) ? Number(s) : null;
  }
  return null;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function coerceType(raw: unknown): string {
  const s = pyStrip(pyStr(raw)).toLowerCase();
  if ((FIGURE_TYPES as readonly string[]).includes(s)) return s;
  if (Object.hasOwn(ALIASES, s)) return ALIASES[s]!;
  logger.warn({ got: pySlice(s, 0, 40) }, 'figure_detect_unknown_type_coerced_to_other');
  return 'other';
}

/** Validate one raw figure from the model; null when too malformed to salvage. */
function sanitizeFigure(raw: Record<string, unknown>): Detection | null {
  const b = raw.bbox;
  if (!Array.isArray(b) || b.length !== 4) return null;
  const nums = b.map(pyFloat);
  if (nums.some((n) => n === null || Number.isNaN(n))) return null;
  const [x0, y0, x1, y1] = (nums as number[]).map(clamp01) as [number, number, number, number];
  if (x1 <= x0 || y1 <= y0) return null;
  // Below ~0.5% of the page area is almost always a misfire (e.g. a page-number badge).
  if ((x1 - x0) * (y1 - y0) < 0.005) return null;

  let confidence = raw.confidence === undefined ? 0.5 : (pyFloat(raw.confidence) ?? 0.5);
  if (Number.isNaN(confidence)) confidence = 0.5;
  return {
    bbox: [x0, y0, x1, y1],
    type: coerceType(raw.type),
    caption: pySlice(pyStr(raw.caption === undefined ? '' : raw.caption), 0, 2000),
    figure_number: pySlice(pyStr(raw.figure_number === undefined ? '' : raw.figure_number), 0, 40),
    data_claim: pySlice(pyStr(raw.data_claim === undefined ? '' : raw.data_claim), 0, 1000),
    referenced_paragraph: pySlice(pyStr(raw.referenced_paragraph === undefined ? '' : raw.referenced_paragraph), 0, 2000),
    confidence: clamp01(confidence),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Pull a {"figures": [...]} object out of the model's reply. Strict JSON preferred, markdown-fenced
 * JSON tolerated, anything else gives []: no regex scraping.
 */
export function parseDetectorResponse(text: string): Detection[] {
  const candidates = [pyStrip(text)];
  const fence = /```(?:json)?\s*(.*?)```/s.exec(text);
  if (fence) candidates.push(pyStrip(fence[1]!));

  for (const candidate of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    const figs = isObject(data) ? data.figures : undefined;
    if (!Array.isArray(figs)) continue;
    const out: Detection[] = [];
    for (const raw of figs) {
      if (!isObject(raw)) continue;
      const clean = sanitizeFigure(raw);
      if (clean) out.push(clean);
    }
    return out;
  }
  logger.warn({ preview: pySlice(text, 0, 160) }, 'figure_detect_response_unparseable');
  return [];
}

const b64 = (png: Uint8Array): string => Buffer.from(png).toString('base64');

async function detectAnthropic(
  p: ProviderConfig,
  deps: ProviderDeps,
  png: Uint8Array,
  pageNumber: number,
  pageText: string,
  signal?: AbortSignal,
): Promise<Detection[]> {
  const client = deps.anthropic(p.figureDetect.anthropicKey, {});
  const resp = await client.messages.create(
    {
      model: p.figureDetect.anthropicModel,
      max_tokens: 2048,
      temperature: 0.0,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(png) } },
            { type: 'text', text: buildUserPrompt(pageNumber, pageText) },
          ],
        },
      ],
    },
    { signal },
  );
  return parseDetectorResponse(
    resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
  );
}

async function detectOllama(
  p: ProviderConfig,
  deps: ProviderDeps,
  png: Uint8Array,
  pageNumber: number,
  pageText: string,
  signal?: AbortSignal,
): Promise<Detection[]> {
  const data = (await fetchJson(deps, `${p.ollamaBaseUrl}/api/chat`, {
    body: {
      model: p.figureDetect.ollamaModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(pageNumber, pageText), images: [b64(png)] },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.0 },
    },
    timeoutMs: 300_000,
    signal,
  })) as { message: { content?: string; thinking?: string } };
  const msg = data.message;
  return parseDetectorResponse(msg.content || msg.thinking || '');
}

/**
 * Detect figures on one page image. Never throws on provider error (logs and returns []): failing one
 * page must not tank a 200-page paper. A job-signal abort is the exception and rethrows.
 */
export async function detectFiguresOnPage(
  p: ProviderConfig,
  deps: ProviderDeps,
  png: Uint8Array,
  pageNumber: number,
  pageText: string,
  signal?: AbortSignal,
): Promise<Detection[]> {
  const provider = p.figureDetect.provider;
  if (provider === 'none') return [];
  try {
    if (provider === 'anthropic') {
      if (!p.figureDetect.anthropicKey) {
        logger.error('figure_detect_no_anthropic_key');
        return [];
      }
      return await detectAnthropic(p, deps, png, pageNumber, pageText, signal);
    }
    if (provider === 'ollama') return await detectOllama(p, deps, png, pageNumber, pageText, signal);
    logger.warn({ provider }, 'figure_detect_unknown_provider');
    return [];
  } catch (e) {
    if (signal?.aborted) throw e;
    const error = pySlice(e instanceof Error ? e.message : String(e), 0, 200);
    logger.warn({ page: pageNumber, provider, error }, 'figure_detect_page_failed');
    return [];
  }
}

export function isFigureDetectAvailable(p: ProviderConfig): boolean {
  const f = p.figureDetect;
  if (f.provider === 'anthropic' && f.anthropicKey) return true;
  if (f.provider === 'ollama' && f.ollamaModel) return true;
  return false;
}
