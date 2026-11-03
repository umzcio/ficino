import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultProviderDeps } from '../../src/providers/deps.js';

const ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_LOG',
  'ANTHROPIC_API_KEY',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('defaultProviderDeps().anthropic', () => {
  it('ignores the ANTHROPIC_* env: only the given key, the public API host, no env headers', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-bearer-token';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/evil';
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Env-Injected: yes\nAuthorization: Bearer injected';
    process.env.ANTHROPIC_LOG = 'debug';
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    const seen: { url: string; headers: Headers }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) });
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const client = defaultProviderDeps().anthropic('sk-x', { maxRetries: 0 });
      const res = await client.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      expect(res.content[0]?.text).toBe('ok');
      expect(debug).not.toHaveBeenCalled(); // ANTHROPIC_LOG=debug was not picked up
    } finally {
      debug.mockRestore();
    }
    expect(seen).toHaveLength(1);
    const { url, headers } = seen[0]!;
    expect(new URL(url).origin).toBe('https://api.anthropic.com');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-env-injected')).toBeNull();
    expect(headers.get('x-api-key')).toBe('sk-x');
  });
});
