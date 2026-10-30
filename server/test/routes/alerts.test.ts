import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID } from '../helpers/db.js';

const sql = testSql();
beforeEach(async () => {
  await resetDb(sql);
  await seedUsers(sql);
});

const asA = () => client(testApp({ user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' } }));

async function alert(user: string, over: { read?: boolean; dismissed?: boolean; title?: string; created?: string } = {}) {
  const id = randomUUID();
  await sql`INSERT INTO alerts (id, user_id, alert_type, title, body, metadata, read, dismissed, created_at)
    VALUES (${id}, ${user}, 'test', ${over.title ?? 'Test alert'}, 'body', ${sql.json({ k: 'v' })},
            ${over.read ?? false}, ${over.dismissed ?? false}, ${over.created ?? '2026-01-01T01:02:03.000005Z'})`;
  return id;
}

describe('alerts', () => {
  it('lists non-dismissed own alerts newest first with the contract shape and Z timestamps', async () => {
    const old = await alert(USER_A_ID, { title: 'old', created: '2026-01-01T00:00:00Z' });
    const neu = await alert(USER_A_ID, { title: 'new', created: '2026-01-02T00:00:00.5Z' });
    await alert(USER_A_ID, { title: 'dismissed', dismissed: true });
    await alert(USER_B_ID, { title: 'theirs' });
    const r = await asA().get('/alerts');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.map((x: { id: string }) => x.id)).toEqual([neu, old]);
    expect(Object.keys(j[0])).toEqual(['id', 'type', 'title', 'body', 'metadata', 'read', 'created_at']);
    expect(j[0]).toMatchObject({ type: 'test', metadata: { k: 'v' }, read: false, created_at: '2026-01-02T00:00:00.500000Z' });
    expect(j[1].created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('caps the list at 50', async () => {
    for (let i = 0; i < 52; i++) await alert(USER_A_ID);
    expect(await (await asA().get('/alerts')).json()).toHaveLength(50);
  });

  it('unread-count counts own unread, non-dismissed alerts', async () => {
    await alert(USER_A_ID);
    await alert(USER_A_ID);
    await alert(USER_A_ID, { read: true });
    await alert(USER_A_ID, { dismissed: true });
    await alert(USER_B_ID);
    const r = await asA().get('/alerts/unread-count');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ count: 2 });
  });

  it('PUT /alerts/read-all is not captured by /:alert_id/read and marks only own non-dismissed', async () => {
    const a1 = await alert(USER_A_ID);
    const dis = await alert(USER_A_ID, { dismissed: true });
    const b1 = await alert(USER_B_ID);
    const r = await asA().put('/alerts/read-all');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
    const read = async (id: string) => (await sql`SELECT read FROM alerts WHERE id = ${id}`)[0]!.read;
    expect(await read(a1)).toBe(true);
    expect(await read(dis)).toBe(false);
    expect(await read(b1)).toBe(false);
  });

  it('PUT /alerts/:id/read marks own alert read', async () => {
    const id = await alert(USER_A_ID);
    const r = await asA().put(`/alerts/${id}/read`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
    expect((await sql`SELECT read FROM alerts WHERE id = ${id}`)[0]!.read).toBe(true);
  });

  it('PUT /alerts/:id/read never 404s and cannot touch another user alert', async () => {
    const theirs = await alert(USER_B_ID);
    const c = asA();
    expect((await c.put(`/alerts/${theirs}/read`)).status).toBe(200);
    expect((await sql`SELECT read FROM alerts WHERE id = ${theirs}`)[0]!.read).toBe(false);
    expect((await c.put(`/alerts/${randomUUID()}/read`)).status).toBe(200);
  });

  it('test_dismiss_alert_returns_204_then_404_on_second_dismiss', async () => {
    const id = await alert(USER_A_ID);
    const c = asA();
    const r1 = await c.delete(`/alerts/${id}`);
    expect(r1.status).toBe(204);
    expect(await r1.text()).toBe('');
    const r2 = await c.delete(`/alerts/${id}`);
    expect(r2.status).toBe(404);
    expect(await r2.json()).toEqual({ detail: 'Alert not found' });
    expect((await sql`SELECT dismissed FROM alerts WHERE id = ${id}`)[0]!.dismissed).toBe(true);
  });

  it('test_dismiss_alert_missing_id_is_404', async () => {
    const r = await asA().delete(`/alerts/${randomUUID()}`);
    expect(r.status).toBe(404);
  });

  it("DELETE /alerts/not-a-uuid is a 404 JSON via the 22P02 handler (Review Focus 5)", async () => {
    const r = await asA().delete('/alerts/not-a-uuid');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(await r.json()).toEqual({ detail: 'Not Found' });
  });

  it('cannot dismiss another user alert', async () => {
    const id = await alert(USER_B_ID);
    const r = await asA().delete(`/alerts/${id}`);
    expect(r.status).toBe(404);
    expect((await sql`SELECT dismissed FROM alerts WHERE id = ${id}`)[0]!.dismissed).toBe(false);
  });

  it('requires auth', async () => {
    expect((await client(testApp({ config: { authProvider: 'basic' } })).get('/alerts')).status).toBe(401);
  });
});
