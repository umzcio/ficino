import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { allowedHostSet } from '../../src/http/allowedHosts.js';
import { normalizeHost } from '../../src/shared/host.js';
import { client, testApp } from '../helpers/client.js';

const FOREIGN = 'attacker.example:8080';

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x)) });
  return { lines, logger };
}

async function expectUnknownHost(r: { status: number; headers: Headers; text(): Promise<string> }) {
  expect(r.status).toBe(421);
  expect(await r.text()).toBe('{"detail":"Unknown host"}');
  expect(r.headers.get('content-type')).toBe('application/json');
  // Rejected before csrf runs, so no ficino_csrf cookie is minted for the foreign name.
  expect(r.headers.get('set-cookie')).toBeNull();
}

describe('host allow-list (DNS rebinding)', () => {
  it('a foreign Host gets 421 on every method and path, before csrf and routing', async () => {
    const c = client(testApp(), { csrf: false });
    const host = { headers: { host: FOREIGN } };
    await expectUnknownHost(await c.get('/settings', host));
    await expectUnknownHost(await c.get('/health', host));
    await expectUnknownHost(await c.get('/nope', host));
    await expectUnknownHost(await c.send('OPTIONS', '/settings', undefined, host));
    const head = await c.send('HEAD', '/health', undefined, host);
    expect(head.status).toBe(421);
    expect(head.headers.get('set-cookie')).toBeNull();

    // A page served from the rebound name can plant its own matching cookie and header pair.
    const forged = client(testApp(), { csrf: false });
    forged.cookies.set('ficino_csrf', 'x');
    for (const r of [
      await forged.post('/feed/generate', {}, { headers: { host: FOREIGN, 'X-CSRF-Token': 'x' } }),
      await forged.put('/settings', {}, { headers: { host: FOREIGN, 'X-CSRF-Token': 'x' } }),
      await forged.post('/settings/clear-everything', {}, { headers: { host: FOREIGN, 'X-CSRF-Token': 'x' } }),
    ]) {
      await expectUnknownHost(r);
    }
  });

  it('the request URL host is checked too (absolute-form request target)', async () => {
    const r = await testApp().request('http://attacker.example/health');
    expect(r.status).toBe(421);
  });

  it.each(['localhost', 'localhost:8080', 'LOCALHOST:8080', 'localhost.', '127.0.0.1', '127.0.0.1:8000', '[::1]', '[::1]:8000'])(
    'loopback Host %s is allowed by default',
    async (host) => {
      const r = await client(testApp()).get('/health', { headers: { host } });
      expect(r.status).toBe(200);
    },
  );

  it('no Host header falls back to the request URL host (localhost in app.request)', async () => {
    expect((await client(testApp()).get('/health')).status).toBe(200);
  });

  it.each(['', 'evil@localhost', 'localhost/x', 'localhost:abc', 'localhost:', '[::1', '::1', 'local host', '127.0.0.1.attacker.example'])(
    'malformed or foreign Host %j is rejected',
    async (host) => {
      expect((await client(testApp()).get('/health', { headers: { host } })).status).toBe(421);
    },
  );

  it('the hostnames of CORS_ORIGINS are allowed, with or without a port', async () => {
    const app = testApp({ config: { environment: 'production', corsOrigins: ['https://ficino.example', 'http://other.example:8443'] } });
    const c = client(app);
    for (const host of ['ficino.example', 'ficino.example:443', 'FICINO.example', 'other.example:8443', 'localhost:8080']) {
      expect((await c.get('/health', { headers: { host } })).status, host).toBe(200);
    }
    expect((await c.get('/health', { headers: { host: 'not-ficino.example' } })).status).toBe(421);
  });

  it('ALLOWED_HOSTS adds names; loopback and CORS hosts stay allowed', async () => {
    const app = testApp({ config: { allowedHosts: ['api.example'], corsOrigins: ['https://web.example'] } });
    const c = client(app);
    for (const host of ['api.example', 'api.example:8000', 'web.example', 'localhost', '127.0.0.1:8000']) {
      expect((await c.get('/health', { headers: { host } })).status, host).toBe(200);
    }
    expect((await c.get('/health', { headers: { host: FOREIGN } })).status).toBe(421);
  });

  it('ALLOWED_HOSTS=* turns the check off', async () => {
    const c = client(testApp({ config: { allowedHosts: '*' } }));
    expect((await c.get('/health', { headers: { host: FOREIGN } })).status).toBe(200);
  });

  it('a rejection is logged as host_rejected with method, path and the (truncated) host', async () => {
    const { lines, logger } = capturingLogger();
    const long = `${'a'.repeat(400)}.example`;
    await client(testApp({ logger })).get('/settings', { headers: { host: long } });
    const line = lines.find((l) => l.msg === 'host_rejected');
    expect(line).toMatchObject({ method: 'GET', path: '/settings' });
    expect(String(line?.host).length).toBeLessThanOrEqual(255);
  });

  it('createApp refuses a CORS_ORIGINS entry that is not an origin', () => {
    expect(() => testApp({ config: { corsOrigins: ['ficino.example'] } })).toThrow(
      'CORS_ORIGINS entry is not an origin: ficino.example',
    );
  });
});

describe('allowedHostSet', () => {
  it('is loopback plus the CORS_ORIGINS hosts plus ALLOWED_HOSTS', () => {
    const set = allowedHostSet({ allowedHosts: ['extra.example'], corsOrigins: ['https://web.example:8443'], environment: 'production' });
    expect([...(set ?? [])].sort()).toEqual(['127.0.0.1', '::1', 'extra.example', 'localhost', 'web.example']);
  });

  it('adds the dev origins in development', () => {
    const set = allowedHostSet({ allowedHosts: [], corsOrigins: [], environment: 'development' });
    expect(set?.has('localhost')).toBe(true);
  });

  it('is null (no check) for *', () => {
    expect(allowedHostSet({ allowedHosts: '*', corsOrigins: [], environment: 'production' })).toBeNull();
  });
});

describe('normalizeHost', () => {
  it.each([
    ['localhost', 'localhost'],
    ['LocalHost:80', 'localhost'],
    ['example.com.', 'example.com'],
    ['[::1]:8000', '::1'],
    ['[0:0:0:0:0:0:0:1]', '::1'],
    ['127.0.0.1:8000', '127.0.0.1'],
  ])('%s -> %s', (raw, want) => {
    expect(normalizeHost(raw)).toBe(want);
  });

  it.each(['', '.', 'a@b', 'a/b', 'a b', 'a:', 'a:123456', '[::1', '[::1]x', '::1', '[g::1]', 'ünï.example'])(
    '%j is not a host',
    (raw) => {
      expect(normalizeHost(raw)).toBeNull();
    },
  );
});
