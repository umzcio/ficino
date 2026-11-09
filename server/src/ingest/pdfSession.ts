/**
 * The asynchronous face of an open PDF that ingestion, vision extraction and figure detection read from. The worker
 * gets one from `openIsolatedPdf` (MuPDF runs in a thread it can terminate); `localPdfSession` wraps a `PdfDoc`
 * opened in this thread (tests, and callers that pass a `PdfDoc`). Both give the same output as `pdf.ts`.
 */
import { chunkMarkdown, type Chunk } from './chunker.js';
import {
  extractPagesText,
  extractTextMarkdown,
  openRenderedPage,
  pageCount,
  renderPage,
  type PdfCheckpoint,
  type PdfDoc,
  type PdfWarnLogger,
} from './pdf.js';

export type PageImage = { png: Uint8Array; width: number; height: number };

/** One rendered page kept for cropping (`openRenderedPage`). */
export interface SessionRenderedPage extends PageImage {
  crop(box: [number, number, number, number]): Promise<PageImage>;
  /** Frees the page's raster. Idempotent; `crop` rejects afterwards. */
  dispose(): void;
}

export interface PdfSession {
  readonly pages: number;
  extractTextMarkdown(log?: PdfWarnLogger): Promise<string>;
  extractPagesText(log?: PdfWarnLogger, opts?: { pages?: number }): Promise<string[]>;
  renderPage(index: number, dpi: number): Promise<PageImage>;
  openRenderedPage(index: number, dpi: number): Promise<SessionRenderedPage>;
  /** `chunkMarkdown(markdown, maxTokens)`, in the session's thread (it token-counts the whole text). */
  chunkMarkdown(markdown: string, maxTokens: number): Promise<Chunk[]>;
  /** Frees the document. Idempotent; calls afterwards reject. */
  close(): Promise<void>;
}

/**
 * `doc` as a `PdfSession` in this thread. `checkpoint` runs before each page a text walk reads. `close()` leaves
 * `doc` open: its opener closes it.
 */
export function localPdfSession(doc: PdfDoc, { checkpoint }: { checkpoint?: PdfCheckpoint } = {}): PdfSession {
  return {
    pages: pageCount(doc),
    extractTextMarkdown: async (log) => extractTextMarkdown(doc, log, { checkpoint }),
    extractPagesText: async (log, { pages } = {}) => extractPagesText(doc, log, { pages, checkpoint }),
    renderPage: async (index, dpi) => renderPage(doc, index, dpi),
    async openRenderedPage(index, dpi) {
      const page = openRenderedPage(doc, index, dpi);
      return {
        png: page.png,
        width: page.width,
        height: page.height,
        crop: async (box) => page.crop(box),
        dispose: () => page.dispose(),
      };
    },
    chunkMarkdown: async (markdown, maxTokens) => chunkMarkdown(markdown, maxTokens),
    close: async () => {},
  };
}

/** A `PdfSession` as is, or a `PdfDoc` wrapped by `localPdfSession`. */
export function asPdfSession(pdf: PdfDoc | PdfSession, opts: { checkpoint?: PdfCheckpoint } = {}): PdfSession {
  return 'doc' in pdf ? localPdfSession(pdf, opts) : pdf;
}
