import { describe, it, expect, vi } from 'vitest';
import { rerank } from '../../src/providers/rerank.js';
import { providerConfig, type ProviderConfig } from '../../src/providers/config.js';
import { loadConfig } from '../../src/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';
import type { Chunk } from '../../src/feed/types.js';

const base = providerConfig({}, {}, loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' }));
const withRerank = (r: Partial<ProviderConfig['rerank']>): ProviderConfig => ({ ...base, rerank: { ...base.rerank, ...r } });
const voyage = withRerank({ provider: 'voyage', voyageKey: 'vk', voyageModel: 'rerank-2-lite' });
const cohere = withRerank({ provider: 'cohere', cohereKey: 'ck', cohereModel: 'rerank-v3.5' });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mk = (n: number): Chunk[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, content: `text ${i}` }) as unknown as Chunk);
const ids = (cs: Chunk[]) => cs.map((c) => c.id);

type Call = { url: string; init: RequestInit; body: any };
function fakeDeps(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const deps: ProviderDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? 'null')) };
      calls.push(call);
      return handler(call);
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected anthropic');
    },
    sleep: async () => {},
  };
  return { deps, calls };
}
const mkLogger = () => ({ warn: vi.fn() }) as any;

describe('rerank', () => {
  it('empty input is returned as is', async () => {
    const { deps, calls } = fakeDeps(() => json({}));
    const input: Chunk[] = [];
    expect(await rerank(voyage, deps, 'q', input, 3, { logger: mkLogger() })).toBe(input);
    expect(calls).toHaveLength(0);
  });

  it('none and single-chunk inputs slice without a request', async () => {
    const { deps, calls } = fakeDeps(() => json({}));
    const l = mkLogger();
    expect(ids(await rerank(withRerank({ provider: 'none' }), deps, 'q', mk(4), 2, { logger: l }))).toEqual(['c0', 'c1']);
    expect(ids(await rerank(voyage, deps, 'q', mk(1), 5, { logger: l }))).toEqual(['c0']);
    expect(calls).toHaveLength(0);
  });

  it('voyage: exact request, reordered by score, sliced to topK', async () => {
    const { deps, calls } = fakeDeps(() =>
      json({ data: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }, { index: 2, relevance_score: 0.5 }] }),
    );
    const out = await rerank(voyage, deps, 'the query', mk(3), 2, { logger: mkLogger() });
    expect(ids(out)).toEqual(['c1', 'c2']);
    expect(out[0]!.rerank_score).toBe(0.9);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer vk');
    expect(calls[0]!.body).toEqual({
      query: 'the query',
      documents: ['text 0', 'text 1', 'text 2'],
      model: 'rerank-2-lite',
      top_k: 3,
    });
  });

  it('cohere: exact request, results[] reordered', async () => {
    const { deps, calls } = fakeDeps(() =>
      json({ results: [{ index: 2, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }, { index: 1, relevance_score: 0.2 }] }),
    );
    const out = await rerank(cohere, deps, 'q', mk(3), 3, { logger: mkLogger() });
    expect(ids(out)).toEqual(['c2', 'c0', 'c1']);
    expect(calls[0]!.url).toBe('https://api.cohere.com/v2/rerank');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer ck');
    expect(calls[0]!.body).toEqual({
      query: 'q',
      documents: ['text 0', 'text 1', 'text 2'],
      model: 'rerank-v3.5',
      top_n: 3,
    });
  });

  it('an omitted index ends up last; out-of-range and negative indexes are skipped', async () => {
    const { deps } = fakeDeps(() =>
      json({
        data: [
          { index: 2, relevance_score: 0.2 },
          { index: 0, relevance_score: 0.7 },
          { index: 9, relevance_score: 5 },
          { index: -1, relevance_score: 6 },
        ],
      }),
    );
    expect(ids(await rerank(voyage, deps, 'q', mk(3), 3, { logger: mkLogger() }))).toEqual(['c0', 'c2', 'c1']);
  });

  it('a 500 returns the input slice and warns', async () => {
    const { deps } = fakeDeps(() => new Response('boom', { status: 500 }));
    const l = mkLogger();
    expect(ids(await rerank(voyage, deps, 'q', mk(4), 2, { logger: l }))).toEqual(['c0', 'c1']);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0][1]).toBe('rerank_failed_passthrough');
  });

  it('a network error also passes through', async () => {
    const { deps } = fakeDeps(() => {
      throw new TypeError('fetch failed');
    });
    const l = mkLogger();
    expect(ids(await rerank(cohere, deps, 'q', mk(3), 2, { logger: l }))).toEqual(['c0', 'c1']);
    expect(l.warn.mock.calls[0][1]).toBe('rerank_failed_passthrough');
  });

  it('no key: no fetch, order kept', async () => {
    const { deps, calls } = fakeDeps(() => json({}));
    expect(ids(await rerank(withRerank({ provider: 'voyage', voyageKey: '' }), deps, 'q', mk(3), 2, { logger: mkLogger() }))).toEqual(['c0', 'c1']);
    expect(ids(await rerank(withRerank({ provider: 'cohere', cohereKey: '' }), deps, 'q', mk(3), 3, { logger: mkLogger() }))).toEqual(['c0', 'c1', 'c2']);
    expect(calls).toHaveLength(0);
  });

  it('local: no fetch, warning, slice', async () => {
    const { deps, calls } = fakeDeps(() => json({}));
    const l = mkLogger();
    expect(ids(await rerank(withRerank({ provider: 'local' }), deps, 'q', mk(3), 2, { logger: l }))).toEqual(['c0', 'c1']);
    expect(calls).toHaveLength(0);
    expect(l.warn.mock.calls[0][1]).toBe('rerank_local_unavailable_passthrough');
  });

  it('unknown provider: warning, slice', async () => {
    const { deps } = fakeDeps(() => json({}));
    const l = mkLogger();
    expect(ids(await rerank(withRerank({ provider: 'bogus' }), deps, 'q', mk(3), 2, { logger: l }))).toEqual(['c0', 'c1']);
    expect(l.warn.mock.calls[0][1]).toBe('rerank_unknown_provider_passthrough');
  });

  it('an aborted signal rejects instead of passing through', async () => {
    const { deps } = fakeDeps((call) => {
      throw (call.init.signal as AbortSignal).reason;
    });
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(rerank(voyage, deps, 'q', mk(3), 2, { logger: mkLogger(), signal: ac.signal })).rejects.toThrow('cancelled');
  });

  it('a per-request timeout (not the caller) passes through', async () => {
    const { deps } = fakeDeps(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const l = mkLogger();
    expect(ids(await rerank(voyage, deps, 'q', mk(3), 2, { logger: l, signal: new AbortController().signal }))).toEqual(['c0', 'c1']);
    expect(l.warn.mock.calls[0][1]).toBe('rerank_failed_passthrough');
  });

  it('a result item without a numeric relevance_score passes through and leaves chunks unscored', async () => {
    const { deps } = fakeDeps(() => json({ data: [{ index: 1, relevance_score: 0.9 }, { index: 0 }] }));
    const l = mkLogger();
    const input = mk(3);
    expect(ids(await rerank(voyage, deps, 'q', input, 2, { logger: l }))).toEqual(['c0', 'c1']);
    expect(l.warn.mock.calls[0][1]).toBe('rerank_failed_passthrough');
    expect(input.every((c) => c.rerank_score === undefined)).toBe(true);
  });

  it('uses a 30 s per-request timeout', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { deps } = fakeDeps(() => json({ data: [] }));
      await rerank(voyage, deps, 'q', mk(2), 2, { logger: mkLogger() });
      expect(spy).toHaveBeenCalledWith(30_000);
    } finally {
      spy.mockRestore();
    }
  });
});
