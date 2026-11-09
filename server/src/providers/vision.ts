import Anthropic from '@anthropic-ai/sdk';
import type { ProviderConfig } from './config.js';
import type { ProviderDeps } from './deps.js';
import { logger } from '../logger.js';
import { PdfLimitError, type PdfDoc } from '../ingest/pdf.js';
import { asPdfSession, type PdfSession } from '../ingest/pdfSession.js';
import { pyStrip } from '../shared/pystr.js';
import { fetchJson, isTransient, withRetry } from './http.js';

// Port of worker/lib/vision_extractor.py.

/** Between pages of the vision markdown. */
const SEPARATOR = '\n\n---\n\n';

const VISION_SYSTEM_PROMPT = `You are an academic paper text extractor. Convert the page image into clean, structured markdown.

Rules:
- Preserve section headings as markdown headings (# for main, ## for sub)
- Preserve paragraph breaks
- Convert tables to markdown tables
- Describe figures/diagrams in [Figure N: description] brackets
- Preserve footnotes at the bottom with [^N] markers
- Do NOT add commentary — output only the text content of the page
- If the page is blank or contains only a figure, say [blank page] or [Figure only: description]`;

export function isVisionAvailable(p: ProviderConfig): boolean {
  const v = p.vision;
  if (v.provider === 'api' && v.anthropicKey) return true;
  if (v.provider === 'ollama' && v.ollamaModel) return true;
  return false;
}

const RETRY = { attempts: 3, delaysMs: [2000, 6000] } as const;
const userText = (page: number): string => `Extract all text from page ${page} as structured markdown.`;
const b64 = (png: Uint8Array): string => Buffer.from(png).toString('base64');

/** Anthropic connection errors (incl. timeouts), 429 and 5xx; matched by shape so SDK subclasses and test fakes both count. */
function isTransientAnthropic(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || typeof e !== 'object' || e === null) return false;
  const { name, status } = e as { name?: unknown; status?: unknown };
  if (e instanceof Anthropic.APIConnectionError) return true; // incl. APIConnectionTimeoutError
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

async function extractPageClaude(
  p: ProviderConfig,
  deps: ProviderDeps,
  png: Uint8Array,
  pageNum: number,
  signal?: AbortSignal,
): Promise<string> {
  // maxRetries 0: the 3-attempt loop below owns retries (SDK defaults would stack to 9 requests per page).
  const client = deps.anthropic(p.vision.anthropicKey, { maxRetries: 0 });
  const image = b64(png);
  return withRetry(
    async () => {
      const response = await client.messages.create(
        {
          model: p.vision.claudeModel,
          max_tokens: 2048,
          system: VISION_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
                { type: 'text', text: userText(pageNum) },
              ],
            },
          ],
        },
        { signal },
      );
      const text = response.content[0]?.text;
      if (text === undefined) throw new Error('Anthropic response has no text content');
      return text;
    },
    { ...RETRY, delaysMs: [...RETRY.delaysMs], retryable: (e) => isTransientAnthropic(e, signal), sleep: deps.sleep, signal },
  );
}

async function extractPageOllama(
  p: ProviderConfig,
  deps: ProviderDeps,
  png: Uint8Array,
  pageNum: number,
  signal?: AbortSignal,
): Promise<string> {
  const payload = {
    model: p.vision.ollamaModel,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content: userText(pageNum), images: [b64(png)] },
    ],
    stream: false,
  };
  return withRetry(
    async () => {
      const data = (await fetchJson(deps, `${p.ollamaBaseUrl}/api/chat`, {
        body: payload,
        timeoutMs: 300_000,
        signal,
      })) as { message: { content?: string } };
      const content = data.message.content;
      // A 200 with empty content means a misconfigured model; not transient, so not retried.
      if (!content || !pyStrip(content))
        throw new Error(`ollama vision model '${p.vision.ollamaModel}' returned empty content for page ${pageNum}`);
      return content;
    },
    { ...RETRY, delaysMs: [...RETRY.delaysMs], retryable: (e) => isTransient(e, signal), sleep: deps.sleep, signal },
  );
}

async function extractPage(
  p: ProviderConfig,
  deps: ProviderDeps,
  png: Uint8Array,
  pageNum: number,
  signal?: AbortSignal,
): Promise<string> {
  if (p.vision.provider === 'api' && p.vision.anthropicKey) return extractPageClaude(p, deps, png, pageNum, signal);
  if (p.vision.provider === 'ollama' && p.vision.ollamaModel) return extractPageOllama(p, deps, png, pageNum, signal);
  throw new Error('No vision provider available');
}

/**
 * Extract a whole PDF page by page with a vision model, serially, at 200 dpi. Pages past `maxPages`
 * are dropped so a crafted PDF cannot burn unbounded paid-API spend. Once the joined text would be longer than
 * `maxChars` UTF-16 units (the worker passes `MAX_PAPER_CHARS`) it throws a `PdfLimitError` and reads no further
 * page: a model's reply to one page has no length bound of its own.
 */
export async function extractWithVision(
  doc: PdfDoc | PdfSession,
  p: ProviderConfig,
  deps: ProviderDeps,
  maxPages: number,
  signal?: AbortSignal,
  maxChars = Infinity,
): Promise<string> {
  if (!isVisionAvailable(p)) throw new Error('No vision provider available (set OLLAMA_VISION_MODEL or ANTHROPIC_API_KEY)');
  const pdf = asPdfSession(doc);
  const total = pdf.pages;
  const pages = Math.min(total, maxPages);
  if (total > maxPages) logger.warn({ totalPages: total, maxPages }, 'vision_extract_truncated');
  logger.info({ pages, total, provider: p.vision.provider }, 'vision_extract_start');

  const out: string[] = [];
  let length = 0; // of out.join(SEPARATOR) so far
  for (let i = 0; i < pages; i++) {
    signal?.throwIfAborted();
    logger.info({ page: i + 1, total: pages }, 'vision_extract_page');
    const { png } = await pdf.renderPage(i, 200);
    const text = await extractPage(p, deps, png, i + 1, signal);
    length += (i > 0 ? SEPARATOR.length : 0) + text.length;
    if (length > maxChars)
      throw new PdfLimitError(
        `vision text has more than ${maxChars} characters by page ${i + 1} (the per-paper limit)`,
      );
    out.push(text);
  }
  const markdown = out.join(SEPARATOR);
  logger.info({ length: markdown.length }, 'vision_extract_complete');
  return markdown;
}
