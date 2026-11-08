/**
 * MuPDF in a worker thread the job can kill. One page can make MuPDF run for as long as its content stream says
 * (nested forms, repeated content streams) and nothing inside a page call can be interrupted, so the worker runs
 * each paper's PDF work in its own `node:worker_threads` thread, the same `pdf.ts` code over messages:
 * - the job's `signal` (pg-boss abort or soft limit) terminates the thread mid-page and every pending and later
 *   call rejects with `signal.reason`, so the job's own abort handling applies;
 * - the thread's V8 heap is capped (`heapMb`); passing it ends the thread, not this process, and every call
 *   rejects with a `PdfLimitError`, as a page over `maxPageChars` does;
 * - this thread's event loop keeps running meanwhile (other queues, pg-boss, timers).
 */
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_MAX_PAGE_CHARS,
  DEFAULT_MAX_PDF_PAGES,
  PdfLimitError,
  PdfOpenError,
  type OpenPdfOptions,
  type PdfWarnLogger,
} from './pdf.js';
import type { PageImage, PdfSession, SessionRenderedPage } from './pdfSession.js';

/** The default for `openIsolatedPdf`'s `heapMb` (the worker passes `PDF_THREAD_HEAP_MB`). */
export const DEFAULT_PDF_THREAD_HEAP_MB = 1024;

// --- Protocol (pdfThread.ts is the other side) --------------------------------------------------------------

type Box = [number, number, number, number];
export type ThreadOp =
  | { op: 'open'; bytes: Uint8Array; maxPages: number; maxPageChars: number }
  | { op: 'markdown' }
  | { op: 'pagesText'; pages?: number }
  | { op: 'render'; index: number; dpi: number }
  | { op: 'openRendered'; index: number; dpi: number }
  | { op: 'crop'; handle: number; box: Box }
  | { op: 'dispose'; handle: number };
export type ThreadRequest = ThreadOp & { id: number };
export type ThreadWarning = { obj: Record<string, unknown>; msg: string };
export type ThreadReply = { id: number; warnings: ThreadWarning[] } & (
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } }
);
/** Posted once the thread's modules have loaded; the thread is never terminated before it (see `terminate`). */
export type ThreadReady = { ready: true };

// Under tsx (tests, dev) this file is TypeScript source and so is the thread's; the build emits both as .js.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const THREAD_URL = new URL(FROM_SOURCE ? './pdfThread.ts' : './pdfThread.js', import.meta.url);
const EXEC_ARGV = FROM_SOURCE ? ['--import', 'tsx'] : [];

/** The thread's error as the class `pdf.ts` threw, so callers can tell open and limit errors apart. */
function rebuild({ name, message }: { name: string; message: string }): Error {
  if (name === 'PdfOpenError') return new PdfOpenError(message);
  if (name === 'PdfLimitError') return new PdfLimitError(message);
  if (name === 'RangeError') return new RangeError(message);
  const err = new Error(message);
  err.name = name;
  return err;
}

type Pending = { resolve(value: unknown): void; reject(error: unknown): void; log?: PdfWarnLogger };

class IsolatedPdf implements PdfSession {
  pages = 0;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: { error: unknown } | undefined;
  /** Settles when the thread has loaded (or exited before that); it never rejects. */
  private readonly loaded: Promise<void>;
  private terminating: Promise<void> | undefined;
  private readonly onAbort: () => void;

  constructor(
    url: URL,
    heapMb: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    let loaded!: () => void;
    this.loaded = new Promise<void>((resolve) => (loaded = resolve));
    this.worker = new Worker(url, { execArgv: EXEC_ARGV, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    this.worker.on('message', (msg: ThreadReply | ThreadReady) => {
      if ('ready' in msg) loaded();
      else this.settle(msg);
    });
    this.worker.on('error', (err: Error & { code?: string }) => {
      this.fail(
        err.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new PdfLimitError(`PDF processing passed the ${heapMb} MB memory limit`, { cause: err })
          : new Error(`PDF thread failed: ${err.message}`, { cause: err }),
      );
    });
    this.worker.on('exit', (code) => {
      this.fail(new Error(`PDF thread exited (code ${code})`));
      loaded();
    });
    this.onAbort = () => {
      this.fail(signal!.reason);
      void this.terminate();
    };
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  async start(bytes: Uint8Array, maxPages: number, maxPageChars: number): Promise<void> {
    await this.loaded;
    const copy = bytes.slice();
    const { pages } = await this.call<{ pages: number }>({ op: 'open', bytes: copy, maxPages, maxPageChars }, undefined, [
      copy.buffer,
    ]);
    this.pages = pages;
  }

  extractTextMarkdown(log?: PdfWarnLogger): Promise<string> {
    return this.call({ op: 'markdown' }, log);
  }

  extractPagesText(log?: PdfWarnLogger, { pages }: { pages?: number } = {}): Promise<string[]> {
    return this.call({ op: 'pagesText', pages }, log);
  }

  renderPage(index: number, dpi: number): Promise<PageImage> {
    return this.call({ op: 'render', index, dpi });
  }

  async openRenderedPage(index: number, dpi: number): Promise<SessionRenderedPage> {
    const { handle, ...image } = await this.call<PageImage & { handle: number }>({ op: 'openRendered', index, dpi });
    let disposed = false;
    return {
      ...image,
      crop: (box) =>
        disposed ? Promise.reject(new Error('rendered page already disposed')) : this.call({ op: 'crop', handle, box }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Nothing to free once the thread is gone.
        if (!this.failure) this.call({ op: 'dispose', handle }).catch(() => undefined);
      },
    };
  }

  async close(): Promise<void> {
    this.signal?.removeEventListener('abort', this.onAbort);
    this.fail(new Error('PDF session closed'));
    await this.terminate();
  }

  private call<T>(op: ThreadOp, log?: PdfWarnLogger, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure.error);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, log });
      this.worker.postMessage({ ...op, id } satisfies ThreadRequest, transfer);
    });
  }

  private settle(reply: ThreadReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    for (const w of reply.warnings) pending.log?.warn(w.obj, w.msg);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(rebuild(reply.error));
  }

  /** The first failure wins; it rejects every pending call and every later one. */
  private fail(error: unknown): void {
    this.failure ??= { error };
    for (const p of this.pending.values()) p.reject(this.failure.error);
    this.pending.clear();
  }

  /**
   * Ends the thread. It waits until the thread's modules have loaded: terminating a thread while its top-level
   * module evaluation is still settling can abort the whole process (seen on Node 22), and loading reads no input.
   */
  private terminate(): Promise<void> {
    this.terminating ??= this.loaded.then(() => this.worker.terminate()).then(() => undefined);
    return this.terminating;
  }
}

export type IsolatedPdfOptions = OpenPdfOptions & {
  /** The thread's V8 heap cap (`resourceLimits.maxOldGenerationSizeMb`). */
  heapMb?: number;
  /** Aborting it terminates the thread; every call then rejects with its reason. */
  signal?: AbortSignal;
  /** The thread script (tests only). */
  threadUrl?: URL;
};

/**
 * `openPdf` in a new worker thread: rejects as `openPdf` throws (a `PdfOpenError`), or with `signal.reason`. The
 * caller must `close()` the session, which terminates the thread.
 */
export async function openIsolatedPdf(bytes: Uint8Array, opts: IsolatedPdfOptions = {}): Promise<PdfSession> {
  const {
    maxPages = DEFAULT_MAX_PDF_PAGES,
    maxPageChars = DEFAULT_MAX_PAGE_CHARS,
    heapMb = DEFAULT_PDF_THREAD_HEAP_MB,
    signal,
    threadUrl = THREAD_URL,
  } = opts;
  signal?.throwIfAborted();
  const pdf = new IsolatedPdf(threadUrl, heapMb, signal);
  try {
    await pdf.start(bytes, maxPages, maxPageChars);
    return pdf;
  } catch (e) {
    await pdf.close();
    throw e;
  }
}
