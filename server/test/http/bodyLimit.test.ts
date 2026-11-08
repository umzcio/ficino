import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { CSRF_TEST_TOKEN, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const MIB = 1024 * 1024;
const USER = { id: USER_A_ID, email: 'a@example.com', display_name: null };
/** auth none (the config default) acting as a seeded user. */
const app = (config: Partial<Config> = {}) => testApp({ user: USER, config });
const TOO_LARGE = { detail: 'Request body too large' };

const csrfHeaders = (extra: Record<string, string> = {}) => ({
  cookie: `ficino_csrf=${CSRF_TEST_TOKEN}`,
  'x-csrf-token': CSRF_TEST_TOKEN,
  ...extra,
});

/** A JSON settings body of exactly `bytes` bytes (an unknown key, which PUT /settings drops). */
function settingsBody(bytes: number): string {
  const shell = JSON.stringify({ settings: { pad: '' } });
  return JSON.stringify({ settings: { pad: 'a'.repeat(bytes - shell.length) } });
}

/** A chunked body of `total` 64 KiB chunks with no Content-Length; `pulled()` reports how much was read. */
function chunkedBody(total: number) {
  const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total * chunk.length) return controller.close();
      pulled += chunk.length;
      controller.enqueue(chunk);
    },
  });
  return { stream, pulled: () => pulled, size: total * chunk.length };
}

function put(a: ReturnType<typeof testApp>, path: string, payload: string, headers: Record<string, string> = {}) {
  return a.request(path, {
    method: 'PUT',
    body: payload,
    headers: csrfHeaders({
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      ...headers,
    }),
  });
}

describe('MAX_JSON_BODY_KB config', () => {
  it('defaults to 1024 KiB', () => {
    expect(loadConfig({}).maxJsonBodyKb).toBe(1024);
  });
  it('reads the env override', () => {
    expect(loadConfig({ MAX_JSON_BODY_KB: '64' }).maxJsonBodyKb).toBe(64);
  });
  it('rejects a cap below 1', () => {
    expect(() => loadConfig({ MAX_JSON_BODY_KB: '0' })).toThrow('MAX_JSON_BODY_KB must be at least 1');
  });
});

describe('global request body cap', () => {
  it('a declared Content-Length over the cap is 413 on PUT /settings (auth none)', async () => {
    const r = await put(app(), '/settings', settingsBody(MIB + 1));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual(TOO_LARGE);
  });

  it('a spoofed Content-Length over the cap is 413 before the body is read', async () => {
    const r = await put(app(), '/settings', settingsBody(100), { 'content-length': String(50 * MIB) });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual(TOO_LARGE);
  });

  it('a chunked body with no Content-Length is cut off at the cap, not read to the end', async () => {
    const body = chunkedBody(64); // 4 MiB
    const r = await app().request('/settings', {
      method: 'PUT',
      body: body.stream,
      duplex: 'half',
      headers: csrfHeaders({ 'content-type': 'application/json' }),
    } as RequestInit);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual(TOO_LARGE);
    expect(body.pulled()).toBeLessThan(body.size);
  });

  it('anonymous POST /auth/login under basic is capped too', async () => {
    const basic = testApp({ config: { authProvider: 'basic' } });
    const payload = JSON.stringify({ email: 'x@example.com', password: 'p'.repeat(2 * MIB) });
    const r = await basic.request('/auth/login', {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual(TOO_LARGE);
  });

  it('a normal body under the cap is unaffected', async () => {
    const r = await put(app(), '/settings', settingsBody(900 * 1024));
    expect(r.status).toBe(200);
  });

  it('a body of exactly the cap passes; one byte more is 413', async () => {
    const a = app({ maxJsonBodyKb: 1 });
    expect((await put(a, '/settings', settingsBody(1024))).status).toBe(200);
    const r = await put(a, '/settings', settingsBody(1025));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual(TOO_LARGE);
  });

  it('a chunked body under the cap still reaches the route', async () => {
    const a = app({ maxJsonBodyKb: 1 });
    const payload = new TextEncoder().encode(settingsBody(1000));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.subarray(0, 500));
        controller.enqueue(payload.subarray(500));
        controller.close();
      },
    });
    const r = await a.request('/settings', {
      method: 'PUT',
      body: stream,
      duplex: 'half',
      headers: csrfHeaders({ 'content-type': 'application/json' }),
    } as RequestInit);
    expect(r.status).toBe(200);
  });

  it('the 413 carries the security headers', async () => {
    const r = await put(app(), '/settings', settingsBody(MIB + 1));
    expect(r.status).toBe(413);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a PDF upload larger than the JSON cap is still accepted by POST /papers', async () => {
    const a = app({ maxJsonBodyKb: 1 });
    const pdf = new Uint8Array(2 * MIB);
    pdf.set(new TextEncoder().encode('%PDF-1.4 '));
    const form = new FormData();
    form.set('file', new File([pdf], 'big.pdf', { type: 'application/pdf' }));
    const r = await a.request(`/papers?workspace_id=${seeded.workspace_a}`, {
      method: 'POST',
      body: form,
      headers: csrfHeaders(),
    });
    expect(r.status).toBe(201);
  });

  it('POST /papers keeps its own upload cap', async () => {
    const a = app({ maxJsonBodyKb: 1 });
    const r = await a.request(`/papers?workspace_id=${seeded.workspace_a}`, {
      method: 'POST',
      body: 'x',
      headers: csrfHeaders({ 'content-type': 'multipart/form-data; boundary=xx', 'content-length': String(999 * MIB) }),
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ detail: 'File exceeds 50MB limit' });
  });

  it('the upload exemption is POST /papers only: another method on that path is capped', async () => {
    const r = await put(app({ maxJsonBodyKb: 1 }), '/papers', settingsBody(2048));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual(TOO_LARGE);
  });
});

describe('global request body cap over a real socket', () => {
  async function withServer(config: Partial<Config>, fn: (port: number) => Promise<void>) {
    const server = serve({ fetch: app(config).fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    try {
      await fn((server.address() as AddressInfo).port);
    } finally {
      server.close();
    }
  }

  function send(port: number, headers: Record<string, string>, write: (req: http.ClientRequest) => void) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'PUT', path: '/settings', headers: csrfHeaders(headers) },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', (e: NodeJS.ErrnoException) => {
        // The server may answer and close before the client finishes writing.
        if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') reject(e);
      });
      write(req);
    });
  }

  it('Content-Length over the cap: 413', async () => {
    await withServer({ maxJsonBodyKb: 4 }, async (port) => {
      const payload = settingsBody(8 * 1024);
      const r = await send(
        port,
        { 'content-type': 'application/json', 'content-length': String(payload.length) },
        (req) => req.end(payload),
      );
      expect(r.status).toBe(413);
      expect(JSON.parse(r.body)).toEqual(TOO_LARGE);
    });
  });

  it('chunked over the cap: 413', async () => {
    await withServer({ maxJsonBodyKb: 4 }, async (port) => {
      const payload = settingsBody(8 * 1024);
      const r = await send(port, { 'content-type': 'application/json' }, (req) => {
        req.write(payload.slice(0, 3000));
        req.write(payload.slice(3000, 6000));
        req.end(payload.slice(6000));
      });
      expect(r.status).toBe(413);
      expect(JSON.parse(r.body)).toEqual(TOO_LARGE);
    });
  });

  it('chunked under the cap: 200', async () => {
    await withServer({ maxJsonBodyKb: 4 }, async (port) => {
      const payload = settingsBody(3 * 1024);
      const r = await send(port, { 'content-type': 'application/json' }, (req) => {
        req.write(payload.slice(0, 1000));
        req.end(payload.slice(1000));
      });
      expect(r.status).toBe(200);
    });
  });
});
