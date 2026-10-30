import { beforeEach, describe, expect, it } from 'vitest';
import { requireUser } from '../../src/auth/currentUser.js';
import { loadConfig, type Config } from '../../src/config.js';
import { hitRateLimit, userRateLimit } from '../../src/http/rateLimit.js';
import { body } from '../../src/http/validate.js';
import { z } from 'zod';
import { client, testApp } from '../helpers/client.js';
import { resetDb, testSql, USER_A_ID } from '../helpers/db.js';

const sql = testSql();
beforeEach(() => resetDb(sql));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = { id: USER_A_ID, email: 'a@x.dev', display_name: null };

describe('rate limit config (ports test_rate_limit_config.py)', () => {
  it('RATE_LIMIT_REPLIES_PER_DAY defaults to 60', () => {
    expect(loadConfig({}).rateLimits.reply).toBe(60);
  });
  it('RATE_LIMIT_PERSONA_DM_PER_DAY defaults to 60', () => {
    expect(loadConfig({}).rateLimits.persona_dm).toBe(60);
  });
  it('generation_limit_per_day was removed', () => {
    const cfg = loadConfig({}) as unknown as Record<string, unknown>;
    expect('generationLimitPerDay' in cfg).toBe(false);
    expect('generation_limit_per_day' in (cfg.rateLimits as object)).toBe(false);
  });
});

describe('hitRateLimit', () => {
  it('20 concurrent hits on one key count exactly 1..20', async () => {
    const counts = await Promise.all(Array.from({ length: 20 }, () => hitRateLimit(sql, 'k', 60)));
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('window is fixed from the first hit and resets after expiry', async () => {
    expect(await hitRateLimit(sql, 'w', 1)).toBe(1);
    await sleep(600);
    expect(await hitRateLimit(sql, 'w', 1)).toBe(2); // a later hit does not extend the window
    await sleep(600); // 1.2s since the first hit
    expect(await hitRateLimit(sql, 'w', 1)).toBe(1);
  });
});

function limitedApp(config: Partial<Config>) {
  const app = testApp({ user: USER, config });
  app.post('/_limited', requireUser, userRateLimit('feed_generation'), (c) => c.json({ ok: true }));
  return app;
}

describe('userRateLimit', () => {
  it('429 "Rate limit exceeded: 20 feed_generation per 24h. Try again later." on the 21st', async () => {
    const c = client(limitedApp({ authProvider: 'basic' }));
    for (let i = 0; i < 20; i++) expect((await c.post('/_limited')).status).toBe(200);
    const r = await c.post('/_limited');
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ detail: 'Rate limit exceeded: 20 feed_generation per 24h. Try again later.' });
    const [row] = await sql`SELECT count FROM rate_limits WHERE key = ${`ratelimit:feed_generation:${USER_A_ID}`}`;
    expect(row.count).toBe(21); // keeps counting while blocked
  });

  it('is skipped under AUTH_PROVIDER=none', async () => {
    const c = client(limitedApp({ authProvider: 'none' }));
    for (let i = 0; i < 25; i++) expect((await c.post('/_limited')).status).toBe(200);
    expect(await sql`SELECT 1 FROM rate_limits`).toHaveLength(0);
  });
});

describe('ipRateLimit', () => {
  const login = (c: ReturnType<typeof client>, ip: string) =>
    c.post('/auth/login', { email: 'nobody@x.dev', password: 'pw' }, { headers: { 'x-real-ip': ip } });

  it('keys on trimmed X-Real-IP; login 6th attempt in 900s is 429', async () => {
    const c = client(testApp({ config: { authProvider: 'basic' } }));
    for (let i = 0; i < 5; i++) expect((await login(c, ' 9.9.9.9 ')).status).toBe(401);
    const r = await login(c, '9.9.9.9');
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ detail: 'Too many login attempts. Try again later.' });
    expect((await login(c, '8.8.8.8')).status).toBe(401); // another IP is unaffected
    const [row] = await sql`SELECT count FROM rate_limits WHERE key = 'ratelimit:login:ip:9.9.9.9'`;
    expect(row.count).toBe(6);
  });

  it('falls back to "unknown" without a socket or X-Real-IP', async () => {
    const c = client(testApp({ config: { authProvider: 'basic' } }));
    await c.post('/auth/login', { email: 'n@x.dev', password: 'pw' });
    const [row] = await sql`SELECT key FROM rate_limits`;
    expect(row.key).toBe('ratelimit:login:ip:unknown');
  });

  it('is active under AUTH_PROVIDER=none (on a route using it)', async () => {
    const { ipRateLimit } = await import('../../src/http/rateLimit.js');
    const app = testApp({ config: { authProvider: 'none' } });
    app.post('/_ip', ipRateLimit('login', 1, 60), (c) => c.json({ ok: true }));
    const c = client(app);
    expect((await c.post('/_ip')).status).toBe(200);
    expect((await c.post('/_ip')).status).toBe(429);
  });

  it('a 422-invalid request still consumes a slot (rate limit runs before validation)', async () => {
    const c = client(testApp({ config: { authProvider: 'basic' } }));
    for (let i = 0; i < 3; i++) {
      const r = await c.post('/auth/register', { email: 'x@y.dev' }, { headers: { 'x-real-ip': '7.7.7.7' } });
      expect(r.status).toBe(422);
    }
    const r = await c.post('/auth/register', { email: 'x@y.dev', password: 'correct horse battery' }, { headers: { 'x-real-ip': '7.7.7.7' } });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ detail: 'Too many register attempts. Try again later.' });
  });

  it('user limit also runs before validators', async () => {
    const app = testApp({ user: USER, config: { authProvider: 'basic', rateLimits: { ...loadConfig({}).rateLimits, feed_generation: 1 } } });
    app.post('/_v', requireUser, userRateLimit('feed_generation'), body(z.object({ a: z.string() })), (c) => c.json({ ok: true }));
    const c = client(app);
    expect((await c.post('/_v', {})).status).toBe(422);
    expect((await c.post('/_v', { a: 'x' })).status).toBe(429);
  });
});
