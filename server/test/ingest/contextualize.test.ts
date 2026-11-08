import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateContexts } from '../../src/ingest/contextualize.js';
import { providerConfig } from '../../src/providers/config.js';
import { loadConfig } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import type { ProviderDeps } from '../../src/providers/deps.js';
import type { Chunk } from '../../src/ingest/chunker.js';

const prompts = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/contextualizer-prompts.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const cfg = (provider: string, key = 'sk', c = config) =>
  providerConfig({ context_provider: provider, anthropic_api_key: key }, {}, c);
const mk = (content: string, i = 0): Chunk => ({ section: 's', content, chunk_index: i, token_count: 1 });

function ollamaDeps(replies: Array<string | Error>) {
  const bodies: Array<Record<string, any>> = [];
  const deps: ProviderDeps = {
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const r = replies.shift()!;
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify({ message: { content: r } }), { status: 200 });
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected');
    },
    sleep: async () => {},
  };
  return { deps, bodies };
}

describe('generateContexts', () => {
  it('none: empty strings, no calls', async () => {
    const { deps, bodies } = ollamaDeps([]);
    expect(await generateContexts(cfg('none'), deps, 'paper', [mk('a'), mk('b', 1)])).toEqual(['', '']);
    expect(bodies).toHaveLength(0);
    expect(await generateContexts(cfg('ollama'), deps, 'paper', [])).toEqual([]);
  });

  it('ollama: serial, verbatim prompts, per-chunk failure gives empty string', async () => {
    const { deps, bodies } = ollamaDeps([' a ', new Error('down'), 'c']);
    const chunks = [mk('x'), mk('y', 1), mk('z', 2)];
    expect(await generateContexts(cfg('ollama'), deps, 'paper', chunks)).toEqual(['a', '', 'c']);
    expect(bodies[0]!.options).toEqual({ temperature: 0.2, num_predict: 150 });
    expect(bodies[0]!.think).toBe(false);
    expect(bodies[0]!.messages[0]).toEqual({ role: 'system', content: prompts.system });
  });

  it('ollama user prompt matches the Python render', async () => {
    const { deps, bodies } = ollamaDeps(['ok']);
    await generateContexts(cfg('ollama'), deps, prompts.paper!, [mk(prompts.chunk!)]);
    expect(bodies[0]!.messages[1].content).toBe(prompts.ollama_user);
  });

  it('ollama: falls back to thinking when content is empty', async () => {
    const deps: ProviderDeps = {
      ...ollamaDeps([]).deps,
      fetch: (async () =>
        new Response(JSON.stringify({ message: { content: '', thinking: ' thought ' } }))) as typeof fetch,
    };
    expect(await generateContexts(cfg('ollama'), deps, 'p', [mk('a')])).toEqual(['thought']);
  });

  it('ollama: abort rejects', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    const { deps } = ollamaDeps(['a']);
    await expect(generateContexts(cfg('ollama'), deps, 'p', [mk('a')], ac.signal)).rejects.toThrow();
  });

  function anthropicDeps(handler: (params: Record<string, any>) => Promise<string>) {
    const calls: Array<Record<string, any>> = [];
    let inflight = 0;
    let peak = 0;
    const deps: ProviderDeps = {
      fetch: (() => {
        throw new Error('unexpected');
      }) as typeof fetch,
      anthropic: () => ({
        messages: {
          async create(params) {
            calls.push(params);
            inflight++;
            peak = Math.max(peak, inflight);
            try {
              return { content: [{ type: 'text', text: await handler(params) }] };
            } finally {
              inflight--;
            }
          },
        },
      }),
      sleep: async () => {},
    };
    return { deps, calls, peak: () => peak };
  }

  it('anthropic: cache_control on the second system block, Python prompts, params', async () => {
    const { deps, calls } = anthropicDeps(async () => ' pre ');
    const out = await generateContexts(cfg('anthropic'), deps, prompts.paper!, [mk(prompts.chunk!)]);
    expect(out).toEqual(['pre']);
    const c = calls[0]!;
    expect(c.system).toEqual([
      { type: 'text', text: prompts.system },
      { type: 'text', text: prompts.anthropic_paper_block, cache_control: { type: 'ephemeral' } },
    ]);
    expect(c.messages).toEqual([{ role: 'user', content: prompts.anthropic_user }]);
    expect(c.temperature).toBe(0.2);
    expect(c.max_tokens).toBe(150);
    expect(c.model).toBe(cfg('anthropic').context.anthropicModel);
  });

  it('anthropic: at most 8 calls in flight, order kept, failures give empty string', async () => {
    const { deps, peak } = anthropicDeps(async (params) => {
      await new Promise((r) => setTimeout(r, 5));
      const text = params.messages[0].content as string;
      if (text.includes('bad')) throw new Error('nope');
      return text.includes('<excerpt>\nc7\n') ? 'seven' : 'x';
    });
    const chunks = Array.from({ length: 20 }, (_, i) => mk(i === 3 ? 'bad' : `c${i}`, i));
    const out = await generateContexts(cfg('anthropic'), deps, 'paper', chunks);
    expect(out).toHaveLength(20);
    expect(out[3]).toBe('');
    expect(out[7]).toBe('seven');
    expect(peak()).toBe(8);
  });

  it('anthropic without a key makes no calls; abort rejects', async () => {
    const { deps, calls } = anthropicDeps(async () => 'x');
    expect(await generateContexts(cfg('anthropic', ''), deps, 'p', [mk('a')])).toEqual(['']);
    expect(calls).toHaveLength(0);
    const ac = new AbortController();
    const d2 = anthropicDeps(async () => {
      ac.abort(new Error('cancelled'));
      throw new Error('aborted');
    });
    await expect(generateContexts(cfg('anthropic'), d2.deps, 'p', [mk('a')], ac.signal)).rejects.toThrow();
  });

  describe('CONTEXT_MAX_CHUNKS', () => {
    afterEach(() => vi.restoreAllMocks());
    const capped = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434', CONTEXT_MAX_CHUNKS: '5' });
    const many = (n: number) => Array.from({ length: n }, (_, i) => mk(`c${i}`, i));

    it('defaults to 200 and reaches the provider config', () => {
      expect(cfg('ollama').context.maxChunks).toBe(200);
      expect(cfg('ollama', 'sk', capped).context.maxChunks).toBe(5);
    });

    it('ollama: a paper over the cap gets no prefixes and no calls, length kept, cap hit logged', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const { deps, bodies } = ollamaDeps([]);
      const out = await generateContexts(cfg('ollama', 'sk', capped), deps, 'paper', many(6));
      expect(out).toEqual(['', '', '', '', '', '']);
      expect(bodies).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        { chunks: 6, max_chunks: 5, provider: 'ollama' },
        'contextualizer_chunk_cap_hit',
      );
    });

    it('anthropic: 10,000 chunks over the default cap of 200 make no calls', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const { deps, calls } = anthropicDeps(async () => 'x');
      const out = await generateContexts(cfg('anthropic'), deps, 'paper', many(10_000));
      expect(out).toHaveLength(10_000);
      expect(out.every((x) => x === '')).toBe(true);
      expect(calls).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        { chunks: 10_000, max_chunks: 200, provider: 'anthropic' },
        'contextualizer_chunk_cap_hit',
      );
    });

    it('a paper exactly at the cap is contextualized in full', async () => {
      const { deps, bodies } = ollamaDeps(['a', 'b', 'c', 'd', 'e']);
      expect(await generateContexts(cfg('ollama', 'sk', capped), deps, 'paper', many(5))).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(bodies).toHaveLength(5);
      const a = anthropicDeps(async () => 'x');
      expect(await generateContexts(cfg('anthropic', 'sk', capped), a.deps, 'paper', many(5))).toHaveLength(5);
      expect(a.calls).toHaveLength(5);
    });

    it('provider none or no key over the cap: no cap-hit log (nothing would have been called)', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const { deps } = ollamaDeps([]);
      expect(await generateContexts(cfg('none', 'sk', capped), deps, 'p', many(6))).toHaveLength(6);
      expect(await generateContexts(cfg('anthropic', '', capped), deps, 'p', many(6))).toHaveLength(6);
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), 'contextualizer_chunk_cap_hit');
    });
  });
});
