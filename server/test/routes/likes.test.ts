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
const likeCount = async (user: string, feed: string, idx: number) =>
  Number((await sql`SELECT COUNT(*) AS n FROM user_likes WHERE user_id = ${user} AND feed_id = ${feed} AND post_index = ${idx}`)[0]!.n);

describe('likes', () => {
  it('test_create_like_persists', async () => {
    const r = await asA().post('/likes', { feed_id: seeded.feed_a, post_index: 0, message_index: -1 });
    expect(r.status).toBe(201);
    expect((await r.json()).status).toBe('created');
    expect(await likeCount(USER_A_ID, seeded.feed_a, 0)).toBe(1);
  });

  it('stores persona_key/post_type/category', async () => {
    await asA().post('/likes', { feed_id: seeded.feed_a, post_index: 0, persona_key: 'p', post_type: 't', category: 'c' });
    const [row] = await sql`SELECT persona_key, post_type, category FROM user_likes`;
    expect(row).toMatchObject({ persona_key: 'p', post_type: 't', category: 'c' });
  });

  it('test_create_like_is_idempotent (201 both)', async () => {
    const c = asA();
    const payload = { feed_id: seeded.feed_a, post_index: 1, message_index: -1 };
    const r1 = await c.post('/likes', payload);
    expect(r1.status).toBe(201);
    const id1 = (await r1.json()).id;
    const r2 = await c.post('/likes', payload);
    expect(r2.status).toBe(201);
    expect(await r2.json()).toEqual({ id: id1, status: 'already_liked' });
  });

  it('create 404s on a feed the caller does not own', async () => {
    const r = await asA().post('/likes', { feed_id: seeded.feed_b, post_index: 0 });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Feed not found' });
  });

  it('test_delete_like_removes_row (and audits)', async () => {
    const c = asA();
    await c.post('/likes', { feed_id: seeded.feed_a, post_index: 2 });
    const r = await c.delete(`/likes/feed/${seeded.feed_a}/2`);
    expect(r.status).toBe(204);
    expect(await likeCount(USER_A_ID, seeded.feed_a, 2)).toBe(0);
    const [a] = await sql`SELECT resource_type, resource_id, metadata, status_code FROM audit_log WHERE action = 'like.delete'`;
    expect(a).toMatchObject({ resource_type: 'like', resource_id: null, status_code: 204 });
    expect(a!.metadata).toEqual({ feed_id: seeded.feed_a, post_index: 2, message_index: -1 });
  });

  it('delete honours the message_index query param', async () => {
    const c = asA();
    await c.post('/likes', { feed_id: seeded.feed_a, post_index: 2, message_index: -1 });
    await c.post('/likes', { feed_id: seeded.feed_a, post_index: 2, message_index: 3 });
    expect((await c.delete(`/likes/feed/${seeded.feed_a}/2?message_index=3`)).status).toBe(204);
    const rows = await sql`SELECT message_index FROM user_likes`;
    expect(rows.map((x) => x.message_index)).toEqual([-1]);
  });

  it('test_delete_like_that_doesnt_exist_returns_404', async () => {
    const r = await asA().delete(`/likes/feed/${seeded.feed_a}/999`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Like not found' });
  });

  it('test_list_likes_returns_posts_and_replies (message_index -1 counts as post-level)', async () => {
    const c = asA();
    await c.post('/likes', { feed_id: seeded.feed_a, post_index: 0, message_index: -1 });
    await c.post('/likes', { feed_id: seeded.feed_a, post_index: 0, message_index: 2 });
    await c.post('/likes', { feed_id: seeded.feed_a, post_index: 5, message_index: -1 });
    const r = await c.get(`/likes/feed/${seeded.feed_a}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect([...j.posts].sort()).toEqual([0, 5]);
    expect(j.replies).toEqual({ '0:2': true });
    expect(Object.keys(j)).toEqual(['posts', 'replies']);
  });

  it('test_list_likes_does_not_leak_other_users', async () => {
    const c = asA();
    await c.post('/likes', { feed_id: seeded.feed_a, post_index: 0, message_index: -1 });
    await sql`INSERT INTO user_likes (user_id, feed_id, post_index, message_index) VALUES (${USER_B_ID}, ${seeded.feed_a}, 42, -1)`;
    const { posts } = await (await c.get(`/likes/feed/${seeded.feed_a}`)).json();
    expect(posts).toContain(0);
    expect(posts).not.toContain(42);
  });

  it('test_delete_cross_user_like_returns_404', async () => {
    await sql`INSERT INTO user_likes (user_id, feed_id, post_index, message_index) VALUES (${USER_B_ID}, ${seeded.feed_b}, 0, -1)`;
    const r = await asA().delete(`/likes/feed/${seeded.feed_b}/0`);
    expect(r.status).toBe(404);
    expect(await likeCount(USER_B_ID, seeded.feed_b, 0)).toBe(1);
  });

  it('test_concurrent_create_like_both_2xx_only_one_row', async () => {
    const c = asA();
    const payload = { feed_id: seeded.feed_a, post_index: 5, message_index: -1 };
    const [r1, r2] = await Promise.all([c.post('/likes', payload), c.post('/likes', payload)]);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    expect(await likeCount(USER_A_ID, seeded.feed_a, 5)).toBe(1);
  });

  it('test_create_like_still_returns_created_and_already_liked', async () => {
    const c = asA();
    const payload = { feed_id: seeded.feed_a, post_index: 9, message_index: -1 };
    const r1 = await c.post('/likes', payload);
    expect(r1.status).toBe(201);
    expect((await r1.json()).status).toBe('created');
    const first = (await r1.json()).id;
    const r2 = await c.post('/likes', payload);
    expect([200, 201]).toContain(r2.status);
    expect(await r2.json()).toEqual({ id: first, status: 'already_liked' });
  });
});
