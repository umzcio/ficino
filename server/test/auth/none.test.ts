import { beforeEach, describe, expect, it } from 'vitest';
import { ensureStubUser } from '../../src/auth/bootstrap.js';
import { requireUser } from '../../src/auth/currentUser.js';
import { DEFAULT_WORKSPACE_ID, STUB_USER_ID } from '../../src/shared/constants.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, testSql } from '../helpers/db.js';

const sql = testSql();
beforeEach(() => resetDb(sql));

function app(opts: Parameters<typeof testApp>[0] = {}) {
  const a = testApp(opts);
  a.get('/_protected', requireUser, (c) => c.json(c.var.user));
  return a;
}

describe('provider none', () => {
  it('every protected route sees the stub user; no 401', async () => {
    const c = client(app());
    for (let i = 0; i < 10; i++) {
      const r = await c.get('/_protected');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ id: STUB_USER_ID, email: 'stub@ficino.dev', display_name: 'You' });
    }
  });

  it('/auth/login|register|logout|me are 404', async () => {
    const c = client(app());
    for (const [m, p] of [['POST', '/auth/login'], ['POST', '/auth/register'], ['POST', '/auth/logout'], ['GET', '/auth/me']]) {
      const r = await c.send(m, p, m === 'POST' ? {} : undefined);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(await r.json()).toEqual({ detail: 'Not Found' });
    }
  });

  it('ensureStubUser is idempotent and creates workspace …0001 named Default', async () => {
    await ensureStubUser(sql);
    await ensureStubUser(sql);
    const users = await sql`SELECT id, clerk_id, email FROM users`;
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: STUB_USER_ID, clerk_id: 'stub', email: 'stub@ficino.dev' });
    const ws = await sql`SELECT id, user_id, name FROM corpora`;
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ id: DEFAULT_WORKSPACE_ID, user_id: STUB_USER_ID, name: 'Default' });
  });

  it('userOverride wins over the provider', async () => {
    const user = { id: 'u1', email: 'o@x.dev', display_name: null };
    const r = await client(app({ user })).get('/_protected');
    expect(await r.json()).toEqual(user);
  });
});
