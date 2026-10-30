import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const asA = () => client(testApp({ user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' } }));
const auditCount = async (action: string) =>
  Number((await sql`SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ${USER_A_ID} AND action = ${action}`)[0]!.n);

describe('bookmarks', () => {
  it('test_create_bookmark_returns_id_and_persists', async () => {
    const r = await asA().post('/bookmarks', {
      feed_id: seeded.feed_a, post_index: 0, message_index: -1, post_snapshot: { title: 'hello', body: 'world' },
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.status).toBe('created');
    const [row] = await sql`SELECT user_id, feed_id, post_index, message_index, post_snapshot FROM bookmarks WHERE id = ${j.id}`;
    expect(row).toMatchObject({ user_id: USER_A_ID, feed_id: seeded.feed_a, post_index: 0, message_index: -1 });
    expect(row!.post_snapshot).toEqual({ title: 'hello', body: 'world' });
  });

  it('test_create_bookmark_duplicate_is_idempotent (201 both times)', async () => {
    const c = asA();
    const payload = { feed_id: seeded.feed_a, post_index: 2, message_index: -1, post_snapshot: { t: 'x' } };
    const r1 = await c.post('/bookmarks', payload);
    expect(r1.status).toBe(201);
    const first = (await r1.json()).id;
    const r2 = await c.post('/bookmarks', payload);
    expect(r2.status).toBe(201);
    expect(await r2.json()).toEqual({ id: first, status: 'already_bookmarked' });
  });

  it('create 404s on a feed the caller does not own', async () => {
    const r = await asA().post('/bookmarks', { feed_id: seeded.feed_b, post_index: 0, post_snapshot: { t: 'x' } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Feed not found' });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM bookmarks`)[0]!.n)).toBe(0);
  });

  it('snapshot round-trips nested JSON through list as "post"', async () => {
    const snap = { title: 't', n: 3, nested: { a: [1, 2, { b: null }] } };
    const c = asA();
    await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 1, post_snapshot: snap });
    const list = await (await c.get('/bookmarks')).json();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0])).toEqual(['id', 'feed_id', 'post_index', 'message_index', 'post', 'bookmarked_at']);
    expect(list[0].post).toEqual(snap);
    expect(list[0].message_index).toBe(-1);
    expect(list[0].bookmarked_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it('missing post_snapshot is 422', async () => {
    const r = await asA().post('/bookmarks', { feed_id: seeded.feed_a, post_index: 1 });
    expect(r.status).toBe(422);
  });

  it('test_list_bookmarks_scoped_to_caller', async () => {
    const c = asA();
    const a = (await (await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 0, post_snapshot: { t: 'a' } })).json()).id;
    const [b] = await sql`INSERT INTO bookmarks (user_id, feed_id, post_index, message_index, post_snapshot)
      VALUES (${USER_B_ID}, ${seeded.feed_b}, 0, -1, '{"t":"b"}'::jsonb) RETURNING id`;
    const ids = (await (await c.get('/bookmarks')).json()).map((x: { id: string }) => x.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(String(b!.id));
  });

  it('test_delete_bookmark_rejects_cross_user', async () => {
    const [b] = await sql`INSERT INTO bookmarks (user_id, feed_id, post_index, message_index, post_snapshot)
      VALUES (${USER_B_ID}, ${seeded.feed_b}, 0, -1, '{"t":"b"}'::jsonb) RETURNING id`;
    const r = await asA().delete(`/bookmarks/${b!.id}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Bookmark not found' });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM bookmarks WHERE id = ${b!.id}`)[0]!.n)).toBe(1);
  });

  it('test_delete_own_bookmark_returns_204 (and audits with resource_id)', async () => {
    const c = asA();
    const id = (await (await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 5, post_snapshot: { t: 'a' } })).json()).id;
    const r = await c.delete(`/bookmarks/${id}`);
    expect(r.status).toBe(204);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM bookmarks WHERE id = ${id}`)[0]!.n)).toBe(0);
    const [a] = await sql`SELECT resource_type, resource_id, status_code FROM audit_log WHERE action = 'bookmark.delete'`;
    expect(a).toMatchObject({ resource_type: 'bookmark', resource_id: id, status_code: 204 });
  });

  it('test_post_and_reply_bookmarks_coexist', async () => {
    const c = asA();
    const rp = await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 3, message_index: -1, post_snapshot: { t: 'post' } });
    const rm = await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 3, message_index: 0, post_snapshot: { t: 'msg' } });
    expect(rp.status).toBe(201);
    expect(rm.status).toBe(201);
    expect((await rp.json()).id).not.toBe((await rm.json()).id);
    const list = await (await c.get('/bookmarks')).json();
    const idx = new Set(list.filter((b: { post_index: number }) => b.post_index === 3).map((b: { message_index: number }) => b.message_index));
    expect(idx).toEqual(new Set([-1, 0]));
  });

  it('test_delete_bookmark_by_post_removes_exact_row', async () => {
    const c = asA();
    await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 7, message_index: -1, post_snapshot: { t: 'post' } });
    await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 7, message_index: 2, post_snapshot: { t: 'reply' } });
    const r = await c.delete(`/bookmarks/post/${seeded.feed_a}/7`);
    expect(r.status).toBe(204);
    const rem = await sql`SELECT message_index FROM bookmarks WHERE user_id = ${USER_A_ID} AND feed_id = ${seeded.feed_a} AND post_index = 7`;
    expect(rem.map((x) => x.message_index)).toEqual([2]);
    // explicit message_index query param
    const r2 = await c.delete(`/bookmarks/post/${seeded.feed_a}/7?message_index=2`);
    expect(r2.status).toBe(204);
    expect(await sql`SELECT 1 FROM bookmarks WHERE user_id = ${USER_A_ID}`).toHaveLength(0);
  });

  it('DELETE /bookmarks/post/... never 404s (absent bookmark, 204 and audited)', async () => {
    const r = await asA().delete(`/bookmarks/post/${seeded.feed_a}/42`);
    expect(r.status).toBe(204);
    expect(await auditCount('bookmark.delete')).toBe(1);
  });

  it('route order: /post/:feed/:idx is not captured by /:bookmark_id', async () => {
    // If captured, the id param would be "post" with extra segments -> 404; and a by-id route would give "Bookmark not found".
    const r = await asA().delete(`/bookmarks/post/${seeded.feed_a}/1`);
    expect(r.status).toBe(204);
    const byId = await asA().delete('/bookmarks/post');
    expect(byId.status).toBe(404);
    expect(await byId.json()).toEqual({ detail: 'Not Found' }); // 22P02 on "post" as uuid
  });

  it('test_delete_bookmark_by_post_writes_audit_row', async () => {
    const c = asA();
    const r0 = await c.post('/bookmarks', { feed_id: seeded.feed_a, post_index: 9, message_index: -1, post_snapshot: { t: 'post' } });
    expect(r0.status).toBe(201);
    const r = await c.delete(`/bookmarks/post/${seeded.feed_a}/9`);
    expect(r.status).toBe(204);
    expect(await auditCount('bookmark.delete')).toBe(1);
    const [a] = await sql`SELECT resource_id, metadata FROM audit_log WHERE action = 'bookmark.delete'`;
    expect(a!.resource_id).toBeNull();
    expect(a!.metadata).toEqual({ feed_id: seeded.feed_a, post_index: 9, message_index: -1 });
  });

  it('test_list_bookmarks_empty_for_new_user', async () => {
    const r = await asA().get('/bookmarks');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('test_concurrent_create_bookmark_both_2xx_only_one_row', async () => {
    const c = asA();
    const payload = { feed_id: seeded.feed_a, post_index: 7, message_index: -1, post_snapshot: { t: 'race' } };
    const [r1, r2] = await Promise.all([c.post('/bookmarks', payload), c.post('/bookmarks', payload)]);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    const rows = await sql`SELECT id FROM bookmarks WHERE user_id = ${USER_A_ID} AND feed_id = ${seeded.feed_a} AND post_index = 7 AND message_index = -1`;
    expect(rows).toHaveLength(1);
  });
});
