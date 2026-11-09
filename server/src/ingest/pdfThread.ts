/**
 * The worker-thread side of `pdfIsolated.ts`: it opens one PDF with `pdf.ts` and answers that session's requests
 * in order, and chunks the paper's text (`chunker.ts`). The thread is terminated, never asked to stop, so nothing
 * here needs a cleanup path; the document and its rendered pages go with the thread.
 */
import { parentPort } from 'node:worker_threads';
import { chunkMarkdown } from './chunker.js';
import {
  extractPagesText,
  extractTextMarkdown,
  openPdf,
  openRenderedPage,
  pageCount,
  renderPage,
  type PdfDoc,
  type RenderedPage,
} from './pdf.js';
import type { ThreadReady, ThreadReply, ThreadRequest, ThreadWarning } from './pdfIsolated.js';

const port = parentPort!;
let doc: PdfDoc | undefined;
const rendered = new Map<number, RenderedPage>();
let nextHandle = 1;

const opened = (): PdfDoc => {
  if (!doc) throw new Error('no PDF is open');
  return doc;
};

/** `png` with a buffer of its own, which can be transferred instead of copied. */
function own(png: Uint8Array): Uint8Array<ArrayBuffer> {
  return png.byteOffset === 0 && png.byteLength === png.buffer.byteLength && png.buffer instanceof ArrayBuffer
    ? (png as Uint8Array<ArrayBuffer>)
    : png.slice();
}

function handle(req: ThreadRequest, log: { warn(obj: Record<string, unknown>, msg: string): void }) {
  switch (req.op) {
    case 'open': {
      const { maxPages, maxPageChars, maxPaperChars } = req;
      doc = openPdf(req.bytes, { maxPages, maxPageChars, maxPaperChars });
      return { value: { pages: pageCount(doc) } };
    }
    case 'markdown':
      return { value: extractTextMarkdown(opened(), log) };
    case 'pagesText':
      return { value: extractPagesText(opened(), log, { pages: req.pages }) };
    case 'render': {
      const r = renderPage(opened(), req.index, req.dpi);
      const png = own(r.png);
      return { value: { png, width: r.width, height: r.height }, transfer: [png.buffer] };
    }
    case 'openRendered': {
      const page = openRenderedPage(opened(), req.index, req.dpi);
      const id = nextHandle++;
      rendered.set(id, page);
      const png = own(page.png);
      return { value: { handle: id, png, width: page.width, height: page.height }, transfer: [png.buffer] };
    }
    case 'crop': {
      const page = rendered.get(req.handle);
      if (!page) throw new Error('rendered page already disposed');
      const c = page.crop(req.box);
      const png = own(c.png);
      return { value: { png, width: c.width, height: c.height }, transfer: [png.buffer] };
    }
    case 'dispose':
      rendered.get(req.handle)?.dispose();
      rendered.delete(req.handle);
      return { value: null };
    case 'chunk':
      return { value: chunkMarkdown(req.markdown, req.maxTokens) };
  }
}

port.on('message', (req: ThreadRequest) => {
  const warnings: ThreadWarning[] = [];
  const log = { warn: (obj: Record<string, unknown>, msg: string) => void warnings.push({ obj, msg }) };
  let reply: ThreadReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const out = handle(req, log);
    reply = { id: req.id, ok: true, value: out.value, warnings };
    transfer = out.transfer ?? [];
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    reply = { id: req.id, ok: false, error: { name: e.name, message: e.message }, warnings };
  }
  port.postMessage(reply, transfer);
});

// Announce readiness from a later task, once this module's (async) evaluation has fully settled.
setImmediate(() => port.postMessage({ ready: true } satisfies ThreadReady));
