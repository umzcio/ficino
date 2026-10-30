import { describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';

// Ports of api/tests/test_csrf.py (Round 4: enforced under every auth provider).
describe('csrf', () => {
  it('enforced in auth=none: POST without the pair is 403', async () => {
    const r = await client(testApp(), { csrf: false }).post('/feed/generate', {});
    expect(r.status).toBe(403);
  });

  it('GETs are never protected; /health stays reachable', async () => {
    expect((await client(testApp(), { csrf: false }).get('/health')).status).toBe(200);
  });

  it('required when auth=basic', async () => {
    const app = testApp({ config: { authProvider: 'basic' } });
    expect((await client(app, { csrf: false }).post('/feed/generate', {})).status).toBe(403);
  });

  it('/auth/login is exempt (reaches routing, not 403)', async () => {
    const app = testApp({ config: { authProvider: 'basic' } });
    const r = await client(app, { csrf: false }).post('/auth/login', { email: 'x', password: 'y' });
    expect(r.status).not.toBe(403);
  });

  it('accepts a matching cookie and header', async () => {
    const app = testApp({ config: { authProvider: 'basic' } });
    const c = client(app, { csrf: false });
    c.cookies.set('ficino_csrf', 'test-csrf-token-123');
    const r = await c.post('/feed/generate', {}, { headers: { 'X-CSRF-Token': 'test-csrf-token-123' } });
    expect(r.status).not.toBe(403);
  });

  // Beyond the Python tests: pin the contract details.
  it('mismatched, cookie-only and header-only all 403 with the exact body', async () => {
    const app = testApp();
    const a = client(app, { csrf: false });
    a.cookies.set('ficino_csrf', 'one');
    const mismatch = await a.post('/x', {}, { headers: { 'X-CSRF-Token': 'two' } });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.text()).toBe('{"detail":"CSRF validation failed"}');
    expect(mismatch.headers.get('content-type')).toBe('application/json');

    const cookieOnly = client(app, { csrf: false });
    cookieOnly.cookies.set('ficino_csrf', 'one');
    expect((await cookieOnly.post('/x', {})).status).toBe(403);

    const headerOnly = await client(app, { csrf: false }).post('/x', {}, { headers: { 'X-CSRF-Token': 'one' } });
    expect(headerOnly.status).toBe(403);
  });

  it.each(['put', 'delete', 'patch'] as const)('%s is protected too', async (m) => {
    const c = client(testApp(), { csrf: false });
    expect((await c[m]('/health')).status).toBe(403);
  });

  it('check runs before routing: a valid pair on an unknown path reaches 404', async () => {
    expect((await client(testApp()).post('/nope', {})).status).toBe(404);
    expect((await client(testApp(), { csrf: false }).post('/nope', {})).status).toBe(403);
  });

  it('exemption is exact-path: /auth/login/ and /auth/logout are not exempt', async () => {
    const c = client(testApp({ config: { authProvider: 'basic' } }), { csrf: false });
    expect((await c.post('/auth/logout', {})).status).toBe(403);
    expect((await c.post('/auth/login/', {})).status).toBe(403);
    expect((await c.post('/auth/register', {})).status).not.toBe(403);
  });

  it('first GET without cookie mints ficino_csrf even on 404', async () => {
    const r = await client(testApp(), { csrf: false }).get('/nope');
    expect(r.status).toBe(404);
    expect(r.headers.get('set-cookie')).toMatch(/ficino_csrf=[\w-]{43}; Max-Age=604800; Path=\/; SameSite=Lax/);
  });

  it('the cookie is not HttpOnly and is not re-minted while present', async () => {
    const c = client(testApp(), { csrf: false });
    const first = await c.get('/health');
    expect(first.headers.get('set-cookie')).not.toMatch(/HttpOnly/i);
    const second = await c.get('/health');
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('cookie flags: Secure outside development, not in development; Domain from config', async () => {
    const prod = await client(testApp({ config: { environment: 'production', cookieDomain: '.ficino.app' } }), {
      csrf: false,
    }).get('/health');
    expect(prod.headers.get('set-cookie')).toMatch(/Domain=\.ficino\.app/);
    expect(prod.headers.get('set-cookie')).toMatch(/; Secure/);
    const dev = await client(testApp({ config: { environment: 'development' } }), { csrf: false }).get('/health');
    expect(dev.headers.get('set-cookie')).not.toMatch(/Secure/);
    expect(dev.headers.get('set-cookie')).not.toMatch(/Domain/);
  });

  it('CSRF 403 body is exact and still carries CORS headers', async () => {
    const app = testApp({ config: { environment: 'development' } });
    const r = await client(app, { csrf: false }).post('/feed/generate', {}, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"detail":"CSRF validation failed"}');
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(r.headers.get('access-control-allow-credentials')).toBe('true');
    // SecurityHeaders is inner to CSRF, so rejections skip it.
    expect(r.headers.get('x-frame-options')).toBeNull();
  });
});
