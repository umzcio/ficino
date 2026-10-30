import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID } from '../helpers/db.js';

const sql = testSql();
beforeEach(async () => {
  await resetDb(sql);
  await seedUsers(sql);
});

const asA = () => client(testApp({ user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: null } }));

async function audit(userId: string, n: number, action = 'x.delete', meta: object = {}) {
  for (let i = 0; i < n; i++) {
    await sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, ip, status_code, created_at)
              VALUES (${userId}, ${action}, 'thing', ${String(i)}, ${sql.json(meta as never)}, '1.2.3.4', 204,
                      now() - ${i} * interval '1 minute')`;
  }
}

describe('GET /users/me', () => {
  it('returns the profile', async () => {
    const r = await asA().get('/users/me');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Object.keys(j)).toEqual(['id', 'email', 'display_name', 'created_at']);
    expect(j).toMatchObject({ id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: null });
    expect(j.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it('404 User not found when the row is gone', async () => {
    const c = client(testApp({ user: { id: '33333333-3333-3333-3333-333333333333', email: 'x@y', display_name: null } }));
    const r = await c.get('/users/me');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'User not found' });
  });
});

describe('GET /users/me/audit-log', () => {
  it('returns only own rows, newest first, metadata as a JSON string (C 6.18)', async () => {
    await audit(USER_A_ID, 3, 'workspace.delete', { moved_papers_to: 'abc' });
    await audit(USER_B_ID, 2);
    const r = await asA().get('/users/me/audit-log');
    expect(r.status).toBe(200);
    const rows = await r.json();
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0])).toEqual([
      'id', 'action', 'resource_type', 'resource_id', 'metadata', 'ip', 'status_code', 'created_at',
    ]);
    expect(rows.map((x: { resource_id: string }) => x.resource_id)).toEqual(['0', '1', '2']);
    expect(typeof rows[0].metadata).toBe('string');
    expect(rows[0].metadata).toBe('{"moved_papers_to": "abc"}');
    expect(JSON.parse(rows[0].metadata)).toEqual({ moved_papers_to: 'abc' });
    expect(rows[0]).toMatchObject({ ip: '1.2.3.4', status_code: 204, action: 'workspace.delete' });
    expect(rows[0].created_at).toMatch(/Z$/);
  });

  it('default limit is 100', async () => {
    await audit(USER_A_ID, 105);
    expect(await (await asA().get('/users/me/audit-log')).json()).toHaveLength(100);
  });

  it('limit is clamped to [1, 500]', async () => {
    await audit(USER_A_ID, 505);
    const c = asA();
    expect(await (await c.get('/users/me/audit-log?limit=0')).json()).toHaveLength(1);
    expect(await (await c.get('/users/me/audit-log?limit=-5')).json()).toHaveLength(1);
    expect(await (await c.get('/users/me/audit-log?limit=7')).json()).toHaveLength(7);
    expect(await (await c.get('/users/me/audit-log?limit=100000')).json()).toHaveLength(500);
  });

  it('non-integer limit is 422', async () => {
    expect((await asA().get('/users/me/audit-log?limit=abc')).status).toBe(422);
  });
});
