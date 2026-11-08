import { beforeEach, describe, expect, it } from 'vitest';
import { requireUser } from '../../src/auth/currentUser.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql } from '../helpers/db.js';

const sql = testSql();
beforeEach(() => resetDb(sql));

const PW = 'correct horse battery';
// python3 -c "import bcrypt;print(bcrypt.hashpw(b'correct horse battery', bcrypt.gensalt(12)).decode())"
const PYTHON_HASH = '$2b$12$bU7Om8eA7GCA7gahHt.7PenRP9ed4V0N2FT2CTugrxk7QfBfA1NTi';

function basicApp(config: NonNullable<Parameters<typeof testApp>[0]>['config'] = {}) {
  const a = testApp({ config: { authProvider: 'basic', ...config } });
  // Stands in for the gated routers (ports test_auth_gates.py: /personas, /settings/ollama-models).
  a.get('/_protected', requireUser, (c) => c.json({ id: c.var.user.id }));
  return a;
}

// `ip` varies X-Real-IP so tests that register more than 3 times don't hit the per-IP limit.
async function register(c: ReturnType<typeof client>, email = 'a@x.dev', password = PW, ip?: string) {
  return c.post('/auth/register', { email, password }, ip ? { headers: { 'x-real-ip': ip }, peer: '172.18.0.5' } : undefined);
}

describe('requireUser gate (ports test_auth_gates.py)', () => {
  it('unauthenticated request to a gated route is 401', async () => {
    const r = await client(basicApp()).get('/_protected');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Not authenticated' });
  });

  it('authenticated session still reaches a gated route', async () => {
    const c = client(basicApp());
    const reg = await (await register(c)).json();
    const r = await c.get('/_protected');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: reg.user_id });
  });

  it('userOverride (the dependency_overrides equivalent) bypasses the provider', async () => {
    const a = testApp({ config: { authProvider: 'basic' }, user: { id: 'u', email: 'e', display_name: null } });
    a.get('/_protected', requireUser, (c) => c.json({ id: c.var.user.id }));
    expect((await client(a).get('/_protected')).status).toBe(200);
  });
});

describe('register', () => {
  it('201 {status,user_id} + HttpOnly ficino_session cookie; stores a $2b$12$ hash and a Default workspace', async () => {
    const c = client(basicApp());
    const r = await register(c);
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toEqual({ status: 'registered', user_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const cookie = r.headers.getSetCookie().find((l) => l.startsWith('ficino_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=604800/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // development
    expect(cookie).not.toMatch(/Domain=/i);
    const [u] = await sql`SELECT password_hash FROM users WHERE id = ${j.user_id}`;
    expect(u.password_hash).toMatch(/^\$2b\$12\$/);
    const ws = await sql`SELECT name FROM corpora WHERE user_id = ${j.user_id}`;
    expect(ws.map((w) => w.name)).toEqual(['Default']);
  });

  it('cookie is Secure outside development and ignores COOKIE_DOMAIN', async () => {
    const c = client(basicApp({ environment: 'production', cookieDomain: '.example.com' }));
    const r = await register(c);
    const cookie = r.headers.getSetCookie().find((l) => l.startsWith('ficino_session='))!;
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('403 "Registration is disabled" when users exist and !ALLOW_REGISTRATION; first user always allowed', async () => {
    const c = client(basicApp());
    expect((await register(c, 'first@x.dev')).status).toBe(201);
    const r = await register(client(basicApp()), 'second@x.dev');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: 'Registration is disabled' });
  });

  it('allowRegistration lets later users register', async () => {
    const a = basicApp({ allowRegistration: true });
    expect((await register(client(a), 'one@x.dev')).status).toBe(201);
    expect((await register(client(a), 'two@x.dev')).status).toBe(201);
  });

  it('a seeded (e.g. stub) user counts toward "users exist"', async () => {
    await seedUsers(sql);
    expect((await register(client(basicApp()))).status).toBe(403);
  });

  it('duplicate email → 409 "Email already registered"', async () => {
    const a = basicApp({ allowRegistration: true });
    await register(client(a));
    const r = await register(client(a));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ detail: 'Email already registered' });
  });

  it('password <12 or >72 chars → 422; exactly 12 and 72 are accepted', async () => {
    const a = basicApp({ allowRegistration: true });
    expect((await register(client(a), 'a@x.dev', 'a'.repeat(11), '10.0.0.1')).status).toBe(422);
    expect((await register(client(a), 'b@x.dev', 'a'.repeat(73), '10.0.0.2')).status).toBe(422);
    expect((await register(client(a), 'c@x.dev', 'a'.repeat(12), '10.0.0.3')).status).toBe(201);
    expect((await register(client(a), 'd@x.dev', 'a'.repeat(72), '10.0.0.4')).status).toBe(201);
  });

  it('a password within 72 chars but over 72 bytes → 422 (would be un-loginable)', async () => {
    const r = await register(client(basicApp()), 'e@x.dev', 'é'.repeat(40));
    expect(r.status).toBe(422);
  });

  it('works without a CSRF token (exempt)', async () => {
    expect((await register(client(basicApp(), { csrf: false }))).status).toBe(201);
  });
});

describe('login', () => {
  async function seed(hash: string | null = PYTHON_HASH) {
    await sql`INSERT INTO users (email, password_hash) VALUES ('l@x.dev', ${hash})`;
  }
  const login = (c: ReturnType<typeof client>, email: string, password: string) =>
    c.post('/auth/login', { email, password });

  it('correct password (Python-generated hash) → 200 + session cookie that authenticates', async () => {
    await seed();
    const c = client(basicApp(), { csrf: false });
    const r = await login(c, 'l@x.dev', PW);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'logged_in', user_id: expect.any(String) });
    expect(r.headers.getSetCookie().find((l) => l.startsWith('ficino_session='))).toMatch(/HttpOnly/i);
    expect((await c.get('/auth/me')).status).toBe(200);
  });

  it.each([
    ['wrong password', 'l@x.dev', 'nope nope nope nope'],
    ['unknown email', 'zz@x.dev', PW],
    ['>72-byte password', 'l@x.dev', 'a'.repeat(100)],
  ])('%s → 401 "Invalid email or password"', async (_n, email, pw) => {
    await seed();
    const r = await login(client(basicApp()), email, pw);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Invalid email or password' });
  });

  it('NULL password_hash → 401 "Invalid email or password"', async () => {
    await seed(null);
    const r = await login(client(basicApp()), 'l@x.dev', PW);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Invalid email or password' });
  });
});

describe('logout, me and session lifecycle', () => {
  it('/auth/me returns the user', async () => {
    const c = client(basicApp());
    const { user_id } = await (await register(c, 'me@x.dev')).json();
    expect(await (await c.get('/auth/me')).json()).toEqual({ id: user_id, email: 'me@x.dev', display_name: null });
  });

  it('logout requires CSRF, deletes the session, clears the cookie; then /auth/me → 401 "Session expired"', async () => {
    const c = client(basicApp(), { csrf: false });
    await register(c);
    const token = c.cookies.get('ficino_session')!;

    expect((await c.post('/auth/logout')).status).toBe(403); // no CSRF header/cookie

    const csrfC = client(basicApp());
    csrfC.cookies.set('ficino_session', token);
    const r = await csrfC.post('/auth/logout');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'logged_out' });
    const del = r.headers.getSetCookie().find((l) => l.startsWith('ficino_session='))!;
    expect(del).toMatch(/Path=\//i);
    expect(del).toMatch(/Max-Age=0/i);
    expect(csrfC.cookies.has('ficino_session')).toBe(false);
    expect(await sql`SELECT 1 FROM sessions`).toHaveLength(0);

    // Replaying the old token: row is gone.
    csrfC.cookies.set('ficino_session', token);
    const me = await csrfC.get('/auth/me');
    expect(me.status).toBe(401);
    expect(await me.json()).toEqual({ detail: 'Session expired' });
  });

  it('logout without a session → 401 "Not authenticated"', async () => {
    const r = await client(basicApp()).post('/auth/logout');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Not authenticated' });
  });

  it('missing cookie → 401 "Not authenticated"', async () => {
    const r = await client(basicApp()).get('/auth/me');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Not authenticated' });
  });

  it('garbage cookie → 401 "Session expired"', async () => {
    const c = client(basicApp());
    c.cookies.set('ficino_session', 'garbage');
    const r = await c.get('/auth/me');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Session expired' });
  });

  it('expired session → 401 "Session expired" and the row is deleted', async () => {
    const c = client(basicApp());
    await register(c);
    await sql`UPDATE sessions SET expires_at = now() - interval '1 minute'`;
    const r = await c.get('/auth/me');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Session expired' });
    expect(await sql`SELECT 1 FROM sessions`).toHaveLength(0);
  });

  it('session whose user was deleted → 401 (cascade removed the row)', async () => {
    const c = client(basicApp());
    const { user_id } = await (await register(c)).json();
    await sql`DELETE FROM users WHERE id = ${user_id}`;
    const r = await c.get('/auth/me');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: 'Session expired' });
  });

  it('an authenticated request slides expires_at forward', async () => {
    const c = client(basicApp());
    await register(c);
    await sql`UPDATE sessions SET expires_at = now() + interval '1 hour'`;
    expect((await c.get('/auth/me')).status).toBe(200);
    const [row] = await sql`SELECT expires_at > now() + interval '6 days 23 hours' AS ok FROM sessions`;
    expect(row.ok).toBe(true);
  });

  it('the token is not stored in the database', async () => {
    const c = client(basicApp());
    await register(c);
    const token = c.cookies.get('ficino_session')!;
    const [row] = await sql`SELECT count(*)::int AS n FROM sessions WHERE token_hash = ${token}`;
    expect(row.n).toBe(0);
  });
});

