import { describe, expect, it } from 'vitest';
import { fetchBytes, fetchJson, HttpStatusError, NetworkError } from '../../src/providers/http.js';

type Seen = { url: string; init: RequestInit };
function deps(handler: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  return {
    seen,
    deps: {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const s = { url: String(url), init: init ?? {} };
        seen.push(s);
        return handler(s);
      }) as typeof fetch,
    },
  };
}

/** A fetch that only settles when its signal aborts, rejecting with the signal's reason. */
const hang = (s: Seen) =>
  new Promise<Response>((_, reject) => {
    const signal = s.init.signal!;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('fetchBytes', () => {
  it('returns the body bytes and posts a JSON body', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x00, 0xff]);
    const { deps: d, seen } = deps(() => new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }));
    const out = await fetchBytes(d, 'https://example.test/x', {
      headers: { accept: 'audio/mpeg' },
      body: { text: 'é' },
      timeoutMs: 1000,
    });
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([...bytes]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.headers).toEqual({ 'content-type': 'application/json', accept: 'audio/mpeg' });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ text: 'é' });
  });

  it('a non-2xx throws HttpStatusError with the status and body text', async () => {
    const { deps: d } = deps(() => new Response('{"detail":"invalid api key"}', { status: 401 }));
    const err = await fetchBytes(d, 'https://example.test/x', { body: {}, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.status).toBe(401);
    expect(err.body).toBe('{"detail":"invalid api key"}');
    expect(err.message).toBe('HTTP 401: {"detail":"invalid api key"}');
  });

  it('a rejected fetch throws NetworkError', async () => {
    const { deps: d } = deps(() => Promise.reject(new TypeError('fetch failed')));
    const err = await fetchBytes(d, 'https://example.test/x', { timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toBe('network error: fetch failed');
  });

  it('a timeout keeps its TimeoutError name (not a NetworkError)', async () => {
    const { deps: d } = deps(hang);
    const err = await fetchBytes(d, 'https://example.test/x', { timeoutMs: 20 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err.name).toBe('TimeoutError');
  });

  it("the caller's abort rejects with the caller's reason", async () => {
    const { deps: d } = deps(hang);
    const ac = new AbortController();
    const p = fetchBytes(d, 'https://example.test/x', { timeoutMs: 60_000, signal: ac.signal }).catch((e) => e);
    const reason = new Error('job aborted');
    ac.abort(reason);
    expect(await p).toBe(reason);
  });
});

describe('fetchJson (shares the request helper)', () => {
  it('parses the JSON body; a GET has no body or content-type', async () => {
    const { deps: d, seen } = deps(() => Response.json({ ok: 1 }));
    expect(await fetchJson(d, 'https://example.test/j', { timeoutMs: 1000 })).toEqual({ ok: 1 });
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.body).toBeUndefined();
    expect(seen[0]!.init.headers).toEqual({});
  });

  it('a non-2xx throws HttpStatusError; a rejected fetch throws NetworkError', async () => {
    const bad = deps(() => new Response('nope', { status: 503 }));
    const e1 = (await fetchJson(bad.deps, 'https://example.test/j', { timeoutMs: 1000 }).catch(
      (e) => e,
    )) as HttpStatusError;
    expect(e1).toBeInstanceOf(HttpStatusError);
    expect([e1.status, e1.body]).toEqual([503, 'nope']);
    const down = deps(() => Promise.reject(new Error('ECONNREFUSED')));
    const e2 = await fetchJson(down.deps, 'https://example.test/j', { timeoutMs: 1000 }).catch((e) => e);
    expect(e2).toBeInstanceOf(NetworkError);
  });
});
