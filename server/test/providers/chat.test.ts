import { describe, it, expect } from 'vitest';
import { generateChat } from '../../src/providers/llm.js';
import { providerConfig } from '../../src/providers/config.js';
import { HttpStatusError } from '../../src/providers/http.js';
import { loadConfig } from '../../src/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const ollama = providerConfig({ llm_provider: 'ollama', ollama_llm_model: 'm1' }, {}, config);
const req = {
  system: 'sys',
  messages: [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'yo' },
    { role: 'user' as const, content: 'again' },
  ],
  temperature: 0.4,
  maxTokens: 256,
};

type Step = Response | Error;
function fakeDeps(steps: Step[], extra: Partial<ProviderDeps> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const deps: ProviderDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const s = steps.shift();
      if (!s) throw new Error('no more fake responses');
      if (s instanceof Error) throw s;
      return s;
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected anthropic');
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  };
  return { deps, calls, sleeps };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const ok = (content: string) => json({ message: { content } });

describe('generateChat: ollama (port of test_llm_retry.py)', () => {
  it('two 503s then a 200 returns the content and sleeps 2s, 6s', async () => {
    const { deps, calls, sleeps } = fakeDeps([json({}, 503), json({}, 503), ok('hello')]);
    expect(await generateChat(ollama, deps, req)).toBe('hello');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
  });

  it('three 503s throw the HttpStatusError', async () => {
    const { deps, calls } = fakeDeps([json({}, 503), json({}, 503), json({}, 503)]);
    const err = await generateChat(ollama, deps, req).catch((e) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it('a 404 is not retried', async () => {
    const { deps, calls, sleeps } = fakeDeps([json({}, 404)]);
    await expect(generateChat(ollama, deps, req)).rejects.toBeInstanceOf(HttpStatusError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('a rejected fetch is retried once', async () => {
    const { deps, calls } = fakeDeps([new TypeError('fetch failed'), ok('back')]);
    expect(await generateChat(ollama, deps, req)).toBe('back');
    expect(calls).toHaveLength(2);
  });

  it('whitespace content raises', async () => {
    const { deps } = fakeDeps([ok('  ')]);
    await expect(generateChat(ollama, deps, req)).rejects.toThrow('LLM returned empty response');
  });

  it('falls back to thinking when content is empty', async () => {
    const { deps } = fakeDeps([json({ message: { content: '', thinking: 'pondering' } })]);
    expect(await generateChat(ollama, deps, req)).toBe('pondering');
  });

  it('sends the documented payload with the system message first', async () => {
    const { deps, calls } = fakeDeps([ok('x')]);
    await generateChat(ollama, deps, req);
    expect(calls[0].url).toBe('http://fake-ollama:11434/api/chat');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'm1',
      messages: [{ role: 'system', content: 'sys' }, ...req.messages],
      stream: false,
      think: false,
      options: { temperature: 0.4, num_predict: 256 },
    });
  });
});

describe('generateChat: anthropic', () => {
  function anthropicDeps() {
    const seen: Array<{
      key: string;
      opts: unknown;
      params: Record<string, unknown>;
    }> = [];
    const { deps } = fakeDeps([], {
      anthropic: (key, opts) => ({
        messages: {
          async create(params) {
            seen.push({ key, opts, params });
            return { content: [{ type: 'text', text: 'claude says' }] };
          },
        },
      }),
    });
    return { deps, seen };
  }

  it('provider api calls Anthropic with maxRetries 0, 120s timeout and temperature', async () => {
    const p = providerConfig({ llm_provider: 'api', anthropic_api_key: 'k1', claude_model: 'cm' }, {}, config);
    const { deps, seen } = anthropicDeps();
    expect(await generateChat(p, deps, req)).toBe('claude says');
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe('k1');
    expect(seen[0].opts).toEqual({ maxRetries: 0, timeoutMs: 120000 });
    expect(seen[0].params).toEqual({
      model: 'cm',
      max_tokens: 256,
      system: 'sys',
      messages: req.messages,
      temperature: 0.4,
    });
  });

  it('an unknown provider also goes to Anthropic', async () => {
    const p = providerConfig({ llm_provider: 'banana', anthropic_api_key: 'k2' }, {}, config);
    const { deps, seen } = anthropicDeps();
    expect(await generateChat(p, deps, req)).toBe('claude says');
    expect(seen[0].key).toBe('k2');
  });

  it('a response without text throws', async () => {
    const p = providerConfig({ llm_provider: 'api', anthropic_api_key: 'k' }, {}, config);
    const { deps } = fakeDeps([], {
      anthropic: () => ({
        messages: { create: async () => ({ content: [] }) },
      }),
    });
    await expect(generateChat(p, deps, req)).rejects.toThrow('Anthropic response has no text content');
  });
});
