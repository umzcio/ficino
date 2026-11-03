import { describe, it, expect } from 'vitest';
import { embedTexts, embedModelId, EmbeddingUnavailableError } from '../../src/providers/embed.js';
import { providerConfig, type ProviderConfig } from '../../src/providers/config.js';
import { loadConfig } from '../../src/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const base = providerConfig({}, {}, config);
const withEmbed = (e: Partial<ProviderConfig['embed']>): ProviderConfig => ({ ...base, embed: { ...base.embed, ...e } });
const ollama = withEmbed({ provider: 'ollama', dim: 1024 });
const voyage = withEmbed({ provider: 'voyage', voyageKey: 'vk', dim: 1024 });
const openai = withEmbed({ provider: 'openai', openaiKey: 'ok', dim: 1024 });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const vec = (v: number, dim = 1024) => new Array<number>(dim).fill(v);

type Call = { url: string; init: RequestInit; body: any };
function fakeDeps(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const deps: ProviderDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? 'null')) };
      calls.push(call);
      return handler(call, calls.length - 1);
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected anthropic');
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, calls, sleeps };
}
const doc = { inputType: 'document' as const };
// Encodes each text's number into the vector so order can be checked.
const ollamaEcho = (call: Call) => json({ embeddings: call.body.input.map((t: string) => vec(Number(t))) });
const texts = (n: number) => Array.from({ length: n }, (_, i) => String(i));

describe('embedTexts: ollama /api/embed', () => {
  it('empty input makes no request', async () => {
    const { deps, calls } = fakeDeps(ollamaEcho);
    expect(await embedTexts(ollama, deps, [], doc)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('40 texts -> batches of 16,16,8 with dimensions; order kept when batches finish out of order', async () => {
    const { deps, calls } = fakeDeps(async (call, n) => {
      // First batch answers last.
      if (n === 0) await new Promise((r) => setTimeout(r, 30));
      return ollamaEcho(call);
    });
    const out = await embedTexts(ollama, deps, texts(40), doc);
    expect(calls.map((c) => c.body.input.length).sort((a, b) => b - a)).toEqual([16, 16, 8]);
    expect(calls[0]!.url).toBe('http://fake-ollama:11434/api/embed');
    for (const c of calls) {
      expect(c.body.dimensions).toBe(1024);
      expect(c.body.model).toBe(ollama.embed.ollamaModel);
    }
    expect(out.map((v) => v[0])).toEqual(texts(40).map(Number));
  });

  it('retries a 500 then succeeds (2s delay)', async () => {
    const { deps, calls, sleeps } = fakeDeps((c, n) => (n === 0 ? json({ error: 'boom' }, 500) : ollamaEcho(c)));
    expect(await embedTexts(ollama, deps, ['1'], doc)).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('compensating per-batch count errors (15 then 9 for 16+8) throw', async () => {
    const { deps } = fakeDeps((c) => json({ embeddings: new Array(c.body.input.length === 16 ? 15 : 9).fill(vec(0)) }));
    const err = await embedTexts(ollama, deps, texts(24), doc).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect(err.message).toMatch(/ollama returned \d+ embeddings for \d+ inputs/);
  });

  it('job abort is not retried', async () => {
    const ac = new AbortController();
    const { deps, calls, sleeps } = fakeDeps(() => {
      ac.abort(new Error('job cancelled'));
      throw ac.signal.reason; // what real fetch does when its signal aborts
    });
    await expect(embedTexts(ollama, deps, ['1'], { ...doc, signal: ac.signal })).rejects.toThrow('job cancelled');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('does not retry a 400', async () => {
    const { deps, calls } = fakeDeps(() => json({ error: 'bad' }, 400));
    await expect(embedTexts(ollama, deps, ['1'], doc)).rejects.toThrow('HTTP 400');
    expect(calls).toHaveLength(1);
  });
});

describe('embedTexts: voyage', () => {
  const okData = (call: Call) => ({
    data: call.body.input.map((t: string, index: number) => ({ index, embedding: vec(Number(t)) })).reverse(),
  });

  it('429 waits 20s then 40s', async () => {
    const { deps, calls, sleeps } = fakeDeps((c, n) => (n < 2 ? json({}, 429) : json(okData(c))));
    await embedTexts(voyage, deps, ['1'], doc);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([20000, 40000]);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer vk' });
    expect(calls[0]!.body).toMatchObject({ input_type: 'document', output_dimension: 1024 });
  });

  it('does not retry a 500', async () => {
    const { deps, calls } = fakeDeps(() => json({}, 500));
    await expect(embedTexts(voyage, deps, ['1'], doc)).rejects.toThrow('HTTP 500');
    expect(calls).toHaveLength(1);
  });

  it('re-sorts shuffled indices; sleeps 0.5s between batches', async () => {
    const { deps, sleeps } = fakeDeps((c) => json(okData(c)));
    const out = await embedTexts(voyage, deps, texts(130), { inputType: 'query' });
    expect(out.map((v) => v[0])).toEqual(texts(130).map(Number));
    expect(sleeps).toEqual([500]);
  });
});

describe('embedTexts: openai', () => {
  it('sends dimensions, bearer auth; 1s between batches', async () => {
    const { deps, calls, sleeps } = fakeDeps((c) =>
      json({ data: c.body.input.map((t: string, index: number) => ({ index, embedding: vec(Number(t)) })) }),
    );
    const out = await embedTexts(openai, deps, texts(101), doc);
    expect(out).toHaveLength(101);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]!.body.dimensions).toBe(1024);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer ok' });
    expect(sleeps).toEqual([1000]);
  });
});

describe('embedTexts: openai retry', () => {
  it('429 then 200 succeeds after one 2000 ms sleep', async () => {
    const { deps, calls, sleeps } = fakeDeps((c, n) =>
      n === 0 ? json({}, 429) : json({ data: [{ index: 0, embedding: vec(1) }] }),
    );
    expect(await embedTexts(openai, deps, ['1'], doc)).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });
});

describe('embedTexts: post-checks and unavailable providers', () => {
  it('768-d response throws EmbeddingUnavailableError mentioning the dimension', async () => {
    const { deps } = fakeDeps((c) => json({ embeddings: c.body.input.map(() => vec(0, 768)) }));
    const err = await embedTexts(ollama, deps, ['a', 'b'], doc).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect(err.message).toContain('dim=768');
    expect(err.message).toContain('expected 1024');
  });

  it('short count throws', async () => {
    const { deps } = fakeDeps(() => json({ embeddings: [vec(0)] }));
    await expect(embedTexts(ollama, deps, ['a', 'b'], doc)).rejects.toThrow(/ollama returned 1 embeddings for 2 inputs/);
  });

  it('unknown provider throws with the Python message', async () => {
    const { deps, calls } = fakeDeps(ollamaEcho);
    const err = await embedTexts(withEmbed({ provider: 'nope' }), deps, ['a'], doc).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect(err.message).toMatch(/^No embedding provider reachable: provider='nope', openai_key=/);
    expect(calls).toHaveLength(0);
  });

  it('voyage/openai without a key throw', async () => {
    const { deps } = fakeDeps(ollamaEcho);
    await expect(embedTexts(withEmbed({ provider: 'voyage', voyageKey: '' }), deps, ['a'], doc)).rejects.toThrow(
      'voyage_key=missing',
    );
    await expect(embedTexts(withEmbed({ provider: 'openai', openaiKey: '' }), deps, ['a'], doc)).rejects.toThrow(
      'openai_key=missing',
    );
  });
});

describe('embedModelId', () => {
  it('formats provider:model@dim', () => {
    expect(embedModelId(withEmbed({ provider: 'ollama', ollamaModel: 'qwen3-embedding:latest', dim: 1024 }))).toBe(
      'ollama:qwen3-embedding:latest@1024',
    );
    expect(embedModelId(voyage)).toBe(`voyage:${voyage.embed.voyageModel}@1024`);
    expect(embedModelId(openai)).toBe(`openai:${openai.embed.openaiModel}@1024`);
  });
});
