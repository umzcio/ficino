import { describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';

describe('security headers (C §2.1)', () => {
  it('present on normal responses; HSTS+CSP only outside development', async () => {
    const dev = await client(testApp({ config: { environment: 'development' } })).get('/health');
    expect(dev.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dev.headers.get('x-frame-options')).toBe('DENY');
    expect(dev.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(dev.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(dev.headers.get('strict-transport-security')).toBeNull();
    expect(dev.headers.get('content-security-policy')).toBeNull();

    const prod = await client(testApp({ config: { environment: 'production' } })).get('/health');
    expect(prod.headers.get('x-frame-options')).toBe('DENY');
    expect(prod.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
    expect(prod.headers.get('content-security-policy')).toBeTruthy();
  });

  it('also on 404 responses', async () => {
    const r = await client(testApp()).get('/nope');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('CSP connect-src no longer lists supabase', async () => {
    const r = await client(testApp({ config: { environment: 'production' } })).get('/health');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/supabase/);
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'",
    );
  });
});

describe('CORS (C §2.1)', () => {
  it('development allows the three localhost origins with credentials', async () => {
    const app = testApp({ config: { environment: 'development' } });
    for (const origin of ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8000']) {
      const r = await client(app).get('/health', { headers: { Origin: origin } });
      expect(r.headers.get('access-control-allow-origin')).toBe(origin);
      expect(r.headers.get('access-control-allow-credentials')).toBe('true');
    }
  });

  it('production uses CORS_ORIGINS and rejects others', async () => {
    const app = testApp({ config: { environment: 'production', corsOrigins: ['https://ficino.ai'] } });
    const ok = await client(app).get('/health', { headers: { Origin: 'https://ficino.ai' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ficino.ai');
    const bad = await client(app).get('/health', { headers: { Origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('production preflight allows GET,POST,PUT,DELETE (no PATCH) and the listed headers', async () => {
    const app = testApp({ config: { environment: 'production', corsOrigins: ['https://ficino.ai'] } });
    const r = await app.request('/papers', {
      method: 'OPTIONS',
      headers: { Origin: 'https://ficino.ai', 'Access-Control-Request-Method': 'POST' },
    });
    expect(r.headers.get('access-control-allow-methods')).toBe('GET,POST,PUT,DELETE');
    expect(r.headers.get('access-control-allow-headers')).toBe(
      'Authorization,Content-Type,X-Requested-With,Accept,X-CSRF-Token',
    );
  });
});
