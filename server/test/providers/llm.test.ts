import { describe, it, expect, vi } from 'vitest';
import { generateText } from '../../src/providers/llm.js';
import { providerConfig } from '../../src/providers/config.js';
import { loadConfig } from '../../src/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const ollama = providerConfig({}, {}, config);
const req = { system: 'system', user: 'user', temperature: 0.8, maxTokens: 1024 };

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
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('generateText: ollama (port of test_llm_hardening.py)', () => {
  it('empty content raises', async () => {
    const { deps } = fakeDeps([json({ message: { content: '', thinking: '' } })]);
    await expect(generateText(ollama, deps, req)).rejects.toThrow('LLM returned empty response');
  });
  it('whitespace-only content raises', async () => {
    const { deps } = fakeDeps([json({ message: { content: '   \n  ' } })]);
    await expect(generateText(ollama, deps, req)).rejects.toThrow('LLM returned empty response');
  });
  it('non-empty content is returned; payload matches the wire shape', async () => {
    const { deps, calls } = fakeDeps([json({ message: { content: 'a real answer' } })]);
    expect(await generateText(ollama, deps, req)).toBe('a real answer');
    expect(calls[0]!.url).toBe('http://fake-ollama:11434/api/chat');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'qwen3.8:27b',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.8, num_predict: 1024 },
    });
  });
  it('empty content with thinking falls back to thinking', async () => {
    const { deps } = fakeDeps([json({ message: { content: '', thinking: 'reasoned answer' } })]);
    expect(await generateText(ollama, deps, req)).toBe('reasoned answer');
  });
  it('4xx is not retried', async () => {
    const { deps, calls, sleeps } = fakeDeps([json({ error: 'model not found' }, 404)]);
    await expect(generateText(ollama, deps, req)).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
  it('503, 503, 200 succeeds on the third attempt after sleeps [2000, 6000]', async () => {
    const { deps, calls, sleeps } = fakeDeps([json({}, 503), json({}, 503), json({ message: { content: 'ok' } })]);
    expect(await generateText(ollama, deps, req)).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
  });
  it('three 5xx exhaust the retries and rethrow', async () => {
    const { deps, calls, sleeps } = fakeDeps([json({}, 500), json({}, 502), json({}, 503)]);
    await expect(generateText(ollama, deps, req)).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
  });
  it('a network failure (TypeError) is retried', async () => {
    const { deps, sleeps } = fakeDeps([new TypeError('fetch failed'), json({ message: { content: 'ok' } })]);
    expect(await generateText(ollama, deps, req)).toBe('ok');
    expect(sleeps).toEqual([2000]);
  });
  it('a per-request timeout is retried', async () => {
    const t = new DOMException('timed out', 'TimeoutError');
    const { deps } = fakeDeps([t, json({ message: { content: 'ok' } })]);
    expect(await generateText(ollama, deps, req)).toBe('ok');
  });
  it('an already-aborted job signal rejects with its reason, no call, no retry', async () => {
    const ac = new AbortController();
    ac.abort(new Error('job cancelled'));
    const { deps, calls, sleeps } = fakeDeps([json({ message: { content: 'x' } })]);
    await expect(generateText(ollama, deps, { ...req, signal: ac.signal })).rejects.toBe(ac.signal.reason);
    expect(calls).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });
  it('a 200 with a malformed body fails once, without retry', async () => {
    const { deps, calls, sleeps } = fakeDeps([json({}), json({ message: { content: 'ok' } })]);
    await expect(generateText(ollama, deps, req)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
  it('a job abort during a request is not retried', async () => {
    const ac = new AbortController();
    const reason = new Error('job cancelled');
    const { deps, calls, sleeps } = fakeDeps([], {
      fetch: (async (_u: unknown, init?: RequestInit) => {
        calls.push({ url: '', init: init ?? {} });
        ac.abort(reason);
        throw init!.signal!.reason;
      }) as typeof fetch,
    });
    await expect(generateText(ollama, deps, { ...req, signal: ac.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
  it('a job abort during the backoff sleep stops the retry', async () => {
    const ac = new AbortController();
    const reason = new Error('job cancelled');
    const { deps, calls } = fakeDeps([json({}, 503), json({ message: { content: 'ok' } })], {
      sleep: async () => {
        ac.abort(reason);
        throw reason;
      },
    });
    await expect(generateText(ollama, deps, { ...req, signal: ac.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });
  it('uses a 300000 ms per-request timeout', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { deps, calls } = fakeDeps([json({ message: { content: 'ok' } })]);
      await generateText(ollama, deps, req);
      expect(spy).toHaveBeenCalledWith(300_000);
      expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('generateText: anthropic and routing', () => {
  const api = (key: string) => providerConfig({ llm_provider: 'api', anthropic_api_key: key, claude_model: 'claude-x' }, {}, config);

  it('uses the per-job key and model, returns content[0].text', async () => {
    const seen: Array<{ key: string; opts: unknown; params: Record<string, unknown>; callOpts: unknown }> = [];
    const { deps } = fakeDeps([], {
      anthropic: (key, opts) => ({
        messages: {
          create: async (params, callOpts) => {
            seen.push({ key, opts, params, callOpts });
            return { content: [{ type: 'text', text: 'hello' }] };
          },
        },
      }),
    });
    const ac = new AbortController();
    expect(await generateText(api('sk-1'), deps, { ...req, signal: ac.signal })).toBe('hello');
    expect(seen[0]!.key).toBe('sk-1');
    expect(seen[0]!.opts).not.toHaveProperty('maxRetries'); // SDK default retries
    expect(seen[0]!.params).toEqual({
      model: 'claude-x',
      max_tokens: 1024,
      temperature: 0.8,
      system: 'system',
      messages: [{ role: 'user', content: 'user' }],
    });
    expect(seen[0]!.callOpts).toEqual({ signal: ac.signal });
  });

  it('api without a key throws the no-provider error', async () => {
    const { deps } = fakeDeps([]);
    await expect(generateText(api(''), deps, req)).rejects.toThrow('No LLM provider available (LLM_PROVIDER=api)');
  });

  it('unknown provider throws the no-provider error', async () => {
    const p = providerConfig({ llm_provider: 'bogus' }, {}, config);
    const { deps } = fakeDeps([]);
    await expect(generateText(p, deps, req)).rejects.toThrow('No LLM provider available (LLM_PROVIDER=bogus)');
  });
});
