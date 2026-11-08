import { beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../src/audit.js';
import { client, testApp } from './helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID } from './helpers/db.js';

const sql = testSql();
beforeEach(() => resetDb(sql));

const USER = { id: USER_A_ID, email: 'a@x.dev', display_name: null };

describe('recordAudit', () => {
  it('writes ip from X-Real-IP, user_agent truncated to 500, metadata as jsonb', async () => {
    await seedUsers(sql);
    const app = testApp({ user: USER });
    app.post('/_a', async (c) => {
      c.set('user', USER);
      await recordAudit(c, { action: 'thing.delete', resourceType: 'thing', resourceId: 'r1', metadata: { n: 1, tags: ['a'] }, statusCode: 204 });
      return c.json({});
    });
    await client(app).post('/_a', undefined, { headers: { 'x-real-ip': ' 1.2.3.4 ', 'user-agent': 'u'.repeat(600) }, peer: '172.18.0.5' });
    const [row] = await sql`SELECT * FROM audit_log`;
    expect(row).toMatchObject({
      user_id: USER_A_ID, action: 'thing.delete', resource_type: 'thing', resource_id: 'r1',
      metadata: { n: 1, tags: ['a'] }, ip: '1.2.3.4', status_code: 204,
    });
    expect(row.user_agent).toHaveLength(500);
  });

  it('defaults: empty metadata, status 200, null resource_id, null ip without socket', async () => {
    await seedUsers(sql);
    const app = testApp({ user: USER });
    app.post('/_a', async (c) => {
      c.set('user', USER);
      await recordAudit(c, { action: 'a.b', resourceType: 'a' });
      return c.json({});
    });
    await client(app).post('/_a');
    const [row] = await sql`SELECT * FROM audit_log`;
    expect(row).toMatchObject({ metadata: {}, status_code: 200, resource_id: null, ip: null });
  });

  it('never throws on a DB error', async () => {
    const app = testApp();
    app.post('/_a', async (c) => {
      c.set('user', { ...USER, id: 'not-a-uuid' });
      await recordAudit(c, { action: 'a.b', resourceType: 'a' });
      return c.json({ survived: true });
    });
    const r = await client(app).post('/_a');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ survived: true });
    expect(await sql`SELECT 1 FROM audit_log`).toHaveLength(0);
  });

  it('basic auth routes audit user.register (201, email) and user.logout', async () => {
    const c = client(testApp({ config: { authProvider: 'basic' } }));
    const reg = await (await c.post('/auth/register', { email: 'n@x.dev', password: 'correct horse battery' })).json();
    expect((await c.post('/auth/logout')).status).toBe(200);
    const rows = await sql`SELECT * FROM audit_log ORDER BY created_at`;
    expect(rows.map((r) => r.action)).toEqual(['user.register', 'user.logout']);
    expect(rows[0]).toMatchObject({ user_id: reg.user_id, resource_type: 'user', resource_id: reg.user_id, metadata: { email: 'n@x.dev' }, status_code: 201 });
    expect(rows[1]).toMatchObject({ user_id: reg.user_id, resource_id: reg.user_id, status_code: 200 });
  });
});
