import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../src/ingest/chunker.js';
import { closePdf, cropPage, openPdf, PdfLimitError, PdfOpenError, renderPage } from '../../src/ingest/pdf.js';
import { openIsolatedPdf } from '../../src/ingest/pdfIsolated.js';
import { formBomb, glyphPages } from '../helpers/pdfBombs.js';

const fixture = (name: string): string => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const SAMPLE = new Uint8Array(readFileSync(fixture('sample.pdf')));
const GOLDEN_MD = readFileSync(fixture('goldens/sample.pymupdf.md'), 'utf8');
const GOLDEN_PAGES = JSON.parse(readFileSync(fixture('goldens/sample.pages.json'), 'utf8')) as string[];
const STUCK = new URL('../fixtures/pdf-threads/stuck.mjs', import.meta.url);
const HOG = new URL('../fixtures/pdf-threads/hog.mjs', import.meta.url);

/** Counts event-loop turns while `work` runs: a blocked main thread would count none. */
async function ticking<T>(work: Promise<T>): Promise<{ ticks: number; ms: number; result: PromiseSettledResult<T> }> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const t0 = Date.now();
  try {
    const [result] = await Promise.allSettled([work]);
    return { ticks, ms: Date.now() - t0, result: result! };
  } finally {
    clearInterval(timer);
  }
}

describe('openIsolatedPdf (PDF work in a worker thread)', () => {
  it('gives the same markdown, page texts, renders and crops as the in-process functions', async () => {
    const pdf = await openIsolatedPdf(SAMPLE);
    const local = openPdf(SAMPLE);
    try {
      expect(pdf.pages).toBe(3);
      expect(await pdf.extractTextMarkdown()).toBe(GOLDEN_MD);
      expect(await pdf.extractPagesText()).toEqual(GOLDEN_PAGES);
      expect(await pdf.extractPagesText(undefined, { pages: 2 })).toEqual(GOLDEN_PAGES.slice(0, 2));

      const render = await pdf.renderPage(1, 150);
      const want = renderPage(local, 1, 150);
      expect([render.width, render.height]).toEqual([want.width, want.height]);
      expect(Buffer.from(render.png).equals(Buffer.from(want.png))).toBe(true);

      const page = await pdf.openRenderedPage(1, 150);
      try {
        expect(Buffer.from(page.png).equals(Buffer.from(want.png))).toBe(true);
        const box: [number, number, number, number] = [100, 200, 700, 900];
        const crop = await page.crop(box);
        expect(Buffer.from(crop.png).equals(Buffer.from(cropPage(local, 1, 150, box).png))).toBe(true);
        await expect(page.crop([0, 0, 0, 0])).rejects.toThrow(RangeError);
      } finally {
        page.dispose();
      }
    } finally {
      closePdf(local);
      await pdf.close();
    }
  });

  it('rejects an unreadable or over-long PDF with a PdfOpenError', async () => {
    const junk = new TextEncoder().encode('%PDF-1.7\n\u0000\u0001garbage not a pdf at all');
    await expect(openIsolatedPdf(junk)).rejects.toThrow(PdfOpenError);
    const err = await openIsolatedPdf(SAMPLE, { maxPages: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfOpenError);
    expect((err as Error).message).toBe('PDF has 3 pages; the limit is 2');
  });

  it('fails a page over maxPageChars with a PdfLimitError', async () => {
    const pdf = await openIsolatedPdf(glyphPages([10, 3000]), { maxPageChars: 2999 });
    try {
      await expect(pdf.extractTextMarkdown()).rejects.toThrow(PdfLimitError);
      await expect(pdf.extractTextMarkdown()).rejects.toThrow('page 2 has more than 2999 characters');
    } finally {
      await pdf.close();
    }
  });

  it('fails markdown over maxPaperChars with a PdfLimitError', async () => {
    const pdf = await openIsolatedPdf(SAMPLE, { maxPaperChars: GOLDEN_MD.length - 1 });
    try {
      await expect(pdf.extractTextMarkdown()).rejects.toThrow(PdfLimitError);
      await expect(pdf.extractTextMarkdown()).rejects.toThrow(`more than ${GOLDEN_MD.length - 1} characters`);
    } finally {
      await pdf.close();
    }
    const at = await openIsolatedPdf(SAMPLE, { maxPaperChars: GOLDEN_MD.length });
    try {
      expect(await at.extractTextMarkdown()).toBe(GOLDEN_MD);
    } finally {
      await at.close();
    }
  });

  // Security review: chunking and token counting a paper's text takes seconds at the per-paper cap, so it runs in
  // the paper's thread, where it neither blocks the other queues nor outlives the job's signal.
  it('chunks in the thread, with the same chunks as chunkMarkdown, while this thread keeps running', async () => {
    const pdf = await openIsolatedPdf(SAMPLE);
    try {
      expect(await pdf.chunkMarkdown(GOLDEN_MD, 800)).toEqual(chunkMarkdown(GOLDEN_MD, 800));
      expect(await pdf.chunkMarkdown(GOLDEN_MD, 120)).toEqual(chunkMarkdown(GOLDEN_MD, 120));
      // About 1.5 MB of word-like paragraphs: a second or so of token counting.
      let x = 1;
      const words: string[] = [];
      for (let i = 0; i < 250_000; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const end = i % 150 === 149 ? '.\n\n' : '';
        words.push('abcdefgh'.slice(0, 2 + (x % 6)) + String.fromCharCode(97 + (x % 26)) + end);
      }
      const big = words.join(' ');
      const { ticks, ms, result } = await ticking(pdf.chunkMarkdown(big, 800));
      expect(result.status).toBe('fulfilled');
      expect((result as PromiseFulfilledResult<unknown[]>).value.length).toBeGreaterThan(100);
      expect(ticks).toBeGreaterThanOrEqual(Math.min(5, Math.floor(ms / 100)));
      expect(ticks).toBeGreaterThan(0);
    } finally {
      await pdf.close();
    }
  });

  it('terminates a page that never finishes when the signal aborts, without blocking this thread', async () => {
    const ac = new AbortController();
    const pdf = await openIsolatedPdf(SAMPLE, { signal: ac.signal, threadUrl: STUCK });
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    setTimeout(() => ac.abort(reason), 300);
    const { ticks, ms, result } = await ticking(pdf.extractTextMarkdown());
    expect(result).toEqual({ status: 'rejected', reason });
    expect(ms).toBeLessThan(2000);
    expect(ticks).toBeGreaterThanOrEqual(5);
    // The thread is gone: later calls fail the same way, and close() settles.
    await expect(pdf.renderPage(0, 150)).rejects.toBe(reason);
    await pdf.close();
  });

  it('close() ends a thread stuck on a page and rejects what was pending', async () => {
    const pdf = await openIsolatedPdf(SAMPLE, { threadUrl: STUCK });
    const pending = pdf.extractPagesText();
    setTimeout(() => void pdf.close(), 100);
    const { ms, result } = await ticking(pending);
    expect(result.status).toBe('rejected');
    expect(ms).toBeLessThan(2000);
  });

  it('a real page of nested forms that runs for many seconds is stopped at the deadline', async () => {
    // 10^8 runs of `q Q` from a file of about 2 KB: MuPDF interprets it for far longer than the deadline.
    const signal = AbortSignal.timeout(400);
    const pdf = await openIsolatedPdf(formBomb(8, 10, 'q Q'), { signal });
    const { ticks, ms, result } = await ticking(pdf.extractTextMarkdown());
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBe(signal.reason);
    expect((result as PromiseRejectedResult).reason.name).toBe('TimeoutError');
    expect(ms).toBeLessThan(3000);
    expect(ticks).toBeGreaterThanOrEqual(5);
    await pdf.close();
  });

  it('a thread that passes its heap limit fails with a PdfLimitError and this process carries on', async () => {
    const pdf = await openIsolatedPdf(SAMPLE, { threadUrl: HOG, heapMb: 32 });
    const { ticks, result } = await ticking(pdf.extractTextMarkdown());
    expect(result.status).toBe('rejected');
    const reason = (result as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(PdfLimitError);
    expect(reason.message).toMatch(/memory limit/);
    expect(ticks).toBeGreaterThan(0);
    await expect(pdf.extractPagesText()).rejects.toBe(reason);
    await pdf.close();
  });

  it('an already aborted signal rejects with its reason before any thread starts', async () => {
    const reason = new Error('stopping');
    await expect(openIsolatedPdf(SAMPLE, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  });
});
