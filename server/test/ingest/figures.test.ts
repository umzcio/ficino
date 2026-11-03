import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { extractFigures } from '../../src/ingest/figures.js';
import { closePdf, openPdf, type PdfDoc } from '../../src/ingest/pdf.js';
import { providerConfig } from '../../src/providers/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const fx = (n: string) => new URL(`../fixtures/${n}`, import.meta.url).pathname;
const SAMPLE = new Uint8Array(readFileSync(fx('sample.pdf')));
const RASTER = JSON.parse(readFileSync(fx('goldens/sample.raster.json'), 'utf8')) as Array<{
  width: number;
  height: number;
}>;
let doc: PdfDoc;
beforeAll(() => {
  doc = openPdf(SAMPLE);
});
afterAll(() => closePdf(doc));

const ollama = (provider = 'ollama') =>
  providerConfig({ figure_detect_provider: provider, figure_detect_ollama_model: 'vl' }, {}, config);

/** A fake Ollama whose detections per page come from `perPage` (page number read from the prompt). */
function detector(perPage: (page: number) => unknown[]) {
  const pages: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: ProviderDeps = {
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const page = Number(/This is page (\d+) of/.exec(body.messages[1].content)![1]);
      pages.push(page);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ figures: perPage(page) }) } }));
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected');
    },
    sleep: async () => {},
  };
  return { deps, pages, maxInFlight: () => maxInFlight };
}

function pngSize(png: Uint8Array): { w: number; h: number } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

describe('extractFigures', () => {
  it('crops a padded bbox from page 2 with the exact trunc geometry', async () => {
    const { deps } = detector((page) =>
      page === 2
        ? [
            {
              bbox: [0.1, 0.5, 0.6, 0.8],
              type: 'chart_line',
              caption: 'Fig. 1',
              figure_number: '1',
              data_claim: 'd',
              referenced_paragraph: 'r',
              confidence: 0.8,
            },
          ]
        : [],
    );
    const out = await extractFigures(doc, ollama(), deps);
    expect(out).toHaveLength(1);
    const f = out[0]!;
    const { width: W, height: H } = RASTER[1]!;
    // x1 = 0.6 + 0.04 padding = 0.64 (the brief's 0.66 looks like a typo; y1 = 0.8 + 0.04 = 0.84 matches).
    const w = Math.trunc(0.64 * W) - Math.trunc(0.06 * W);
    const h = Math.trunc(0.84 * H) - Math.trunc(0.46 * H);
    expect(f).toMatchObject({
      page: 2,
      filename: 'fig_p2_0.png',
      extraction_type: 'vlm_detected',
      width: w,
      height: h,
      figure_index: 0,
      figure_type: 'chart_line',
      caption: 'Fig. 1',
      figure_number: '1',
      data_claim: 'd',
      referenced_paragraph: 'r',
      bbox: { page: 2, x0: 0.1, y0: 0.5, x1: 0.6, y1: 0.8 },
      detector_confidence: 0.8,
    });
    expect(pngSize(f.image_bytes)).toEqual({ w, h });
  });

  it('clamps the padding to the page edges', async () => {
    const { deps } = detector((page) => (page === 1 ? [{ bbox: [0, 0, 1, 1] }] : []));
    const [f] = await extractFigures(doc, ollama(), deps);
    expect(f!.width).toBe(RASTER[0]!.width);
    expect(f!.height).toBe(RASTER[0]!.height);
  });

  it('caps at 50 figures; indices run 0..49 in page order', async () => {
    const per = [20, 20, 20];
    const { deps, pages, maxInFlight } = detector((page) =>
      Array.from({ length: per[page - 1]! }, () => ({ bbox: [0.1, 0.1, 0.5, 0.5] })),
    );
    const out = await extractFigures(doc, ollama(), deps);
    expect(pages.sort()).toEqual([1, 2, 3]);
    expect(maxInFlight()).toBeLessThanOrEqual(4);
    expect(out).toHaveLength(50);
    expect(out.map((f) => f.figure_index)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(out.map((f) => f.page)).toEqual([...Array(20).fill(1), ...Array(20).fill(2), ...Array(10).fill(3)]);
    expect(out[20]!.filename).toBe('fig_p2_20.png');
    expect(out[49]!.filename).toBe('fig_p3_49.png');
  });

  it('provider none: the detector is never called and the result is []', async () => {
    const { deps, pages } = detector(() => [{ bbox: [0.1, 0.1, 0.5, 0.5] }]);
    expect(await extractFigures(doc, ollama('none'), deps)).toEqual([]);
    expect(pages).toEqual([]);
  });

  it('a provider failure on one page costs only that page', async () => {
    const { deps } = detector((page) => (page === 3 ? [{ bbox: [0.1, 0.1, 0.5, 0.5] }] : []));
    const orig = deps.fetch;
    let n = 0;
    deps.fetch = (async (...a: Parameters<typeof fetch>) => {
      const body = JSON.parse(String(a[1]?.body));
      if (body.messages[1].content.includes('page 1 of')) {
        n++;
        return new Response('boom', { status: 500 });
      }
      return orig(...a);
    }) as typeof fetch;
    const out = await extractFigures(doc, ollama(), deps);
    expect(n).toBe(1);
    expect(out.map((f) => f.filename)).toEqual(['fig_p3_0.png']);
  });

  it('a job abort rejects', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    const { deps } = detector(() => []);
    await expect(extractFigures(doc, ollama(), deps, ac.signal)).rejects.toBeDefined();
  });

  it('renders each page once however many detections it has, and frees every render', async () => {
    const orig = mupdf.Pixmap.prototype.clear;
    const origDestroy = mupdf.Pixmap.prototype.destroy;
    const rendered: mupdf.Pixmap[] = [];
    const freed = new Set<mupdf.Pixmap>();
    const c = vi.spyOn(mupdf.Pixmap.prototype, 'clear').mockImplementation(function (this: mupdf.Pixmap, v?: number) {
      rendered.push(this);
      return orig.call(this, v);
    });
    const d = vi.spyOn(mupdf.Pixmap.prototype, 'destroy').mockImplementation(function (this: mupdf.Pixmap) {
      freed.add(this);
      return origDestroy.call(this);
    });
    try {
      const { deps } = detector((page) =>
        Array.from({ length: page === 2 ? 5 : 3 }, (_, k) => ({ bbox: [0.1 + k * 0.01, 0.1, 0.5, 0.5] })),
      );
      const out = await extractFigures(doc, ollama(), deps);
      expect(out).toHaveLength(11);
      expect(rendered).toHaveLength(3); // the old per-detection cropPage rendered 3 + 11 times
      expect(rendered.every((px) => freed.has(px))).toBe(true);
    } finally {
      c.mockRestore();
      d.mockRestore();
    }
  });

  it('crops at most 50 detections from a page that returns 80', async () => {
    const { deps } = detector((page) =>
      page === 1 ? Array.from({ length: 80 }, () => ({ bbox: [0.1, 0.1, 0.5, 0.5] })) : [],
    );
    let crops = 0;
    const orig = mupdf.Pixmap.prototype.asPNG;
    const spy = vi.spyOn(mupdf.Pixmap.prototype, 'asPNG').mockImplementation(function (this: mupdf.Pixmap) {
      if (this.getWidth() !== RASTER[0]!.width) crops++;
      return orig.call(this);
    });
    try {
      const out = await extractFigures(doc, ollama(), deps);
      expect(out).toHaveLength(50);
      expect(crops).toBe(50);
    } finally {
      spy.mockRestore();
    }
  });

  it('a mid-flight abort rejects with the reason and frees every opened page render', async () => {
    const orig = mupdf.Pixmap.prototype.clear;
    const origDestroy = mupdf.Pixmap.prototype.destroy;
    const rendered: mupdf.Pixmap[] = [];
    const freed = new Set<mupdf.Pixmap>();
    const c = vi.spyOn(mupdf.Pixmap.prototype, 'clear').mockImplementation(function (this: mupdf.Pixmap, v?: number) {
      rendered.push(this);
      return orig.call(this, v);
    });
    const d = vi.spyOn(mupdf.Pixmap.prototype, 'destroy').mockImplementation(function (this: mupdf.Pixmap) {
      freed.add(this);
      return origDestroy.call(this);
    });
    try {
      const ac = new AbortController();
      const reason = new Error('job cancelled');
      const { deps } = detector(() => []);
      deps.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
        if (JSON.parse(String(init?.body)).messages[1].content.includes('page 2 of')) {
          ac.abort(reason);
          throw new DOMException('aborted', 'AbortError');
        }
        return new Response(JSON.stringify({ message: { content: '{"figures": []}' } }));
      }) as typeof fetch;
      await expect(extractFigures(doc, ollama(), deps, ac.signal)).rejects.toBe(reason);
      expect(rendered.length).toBeGreaterThanOrEqual(2);
      expect(rendered.every((px) => freed.has(px))).toBe(true);
    } finally {
      c.mockRestore();
      d.mockRestore();
    }
  });

  it('does not reject until every in-flight page has settled (the caller closes the doc right after)', async () => {
    const orig = mupdf.Pixmap.prototype.clear;
    const origDestroy = mupdf.Pixmap.prototype.destroy;
    const rendered: mupdf.Pixmap[] = [];
    const freed = new Set<mupdf.Pixmap>();
    const c = vi.spyOn(mupdf.Pixmap.prototype, 'clear').mockImplementation(function (this: mupdf.Pixmap, v?: number) {
      rendered.push(this);
      return orig.call(this, v);
    });
    const d = vi.spyOn(mupdf.Pixmap.prototype, 'destroy').mockImplementation(function (this: mupdf.Pixmap) {
      freed.add(this);
      return origDestroy.call(this);
    });
    try {
      const ac = new AbortController();
      const reason = new Error('job cancelled');
      let page1Cropped = false;
      const { deps } = detector(() => []);
      deps.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
        const content = JSON.parse(String(init?.body)).messages[1].content as string;
        if (content.includes('page 2 of')) {
          ac.abort(reason);
          throw new DOMException('aborted', 'AbortError');
        }
        if (content.includes('page 1 of')) {
          // A provider that ignores the abort: page 1 goes on to crop from the doc after page 2 rejected.
          await new Promise((r) => setTimeout(r, 60));
          return new Response(JSON.stringify({ message: { content: '{"figures": [{"bbox": [0.1, 0.1, 0.5, 0.5]}]}' } }));
        }
        return new Response(JSON.stringify({ message: { content: '{"figures": []}' } }));
      }) as typeof fetch;
      const asPng = mupdf.Pixmap.prototype.asPNG;
      const p = vi.spyOn(mupdf.Pixmap.prototype, 'asPNG').mockImplementation(function (this: mupdf.Pixmap) {
        if (this.getWidth() !== RASTER[0]!.width) page1Cropped = true;
        return asPng.call(this);
      });
      try {
        await expect(extractFigures(doc, ollama(), deps, ac.signal)).rejects.toBe(reason);
      } finally {
        p.mockRestore();
      }
      expect(page1Cropped).toBe(true);
      expect(rendered.length).toBeGreaterThanOrEqual(2);
      expect(rendered.every((px) => freed.has(px))).toBe(true);
    } finally {
      c.mockRestore();
      d.mockRestore();
    }
  });
});
