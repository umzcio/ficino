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
const count = async (user: string, feed: string, idx: number) =>
  Number((await sql`SELECT COUNT(*) AS n FROM annotations WHERE user_id = ${user} AND feed_id = ${feed} AND post_index = ${idx}`)[0]!.n);

describe('annotations', () => {
  it('test_upsert_annotation_creates_row', async () => {
    const r = await asA().put(`/annotations/${seeded.feed_a}/0`, { body: 'interesting insight' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ body: 'interesting insight', feed_id: seeded.feed_a, post_index: 0 });
    const [row] = await sql`SELECT body FROM annotations WHERE user_id = ${USER_A_ID} AND feed_id = ${seeded.feed_a} AND post_index = 0`;
    expect(row!.body).toBe('interesting insight');
  });

  it('test_upsert_annotation_overwrites_existing_body', async () => {
    const c = asA();
    await c.put(`/annotations/${seeded.feed_a}/4`, { body: 'first' });
    const r = await c.put(`/annotations/${seeded.feed_a}/4`, { body: 'second' });
    expect(r.status).toBe(200);
    expect((await r.json()).body).toBe('second');
    expect(await count(USER_A_ID, seeded.feed_a, 4)).toBe(1);
  });

  it('test_upsert_annotation_rejects_empty_body', async () => {
    const r = await asA().put(`/annotations/${seeded.feed_a}/0`, { body: '   ' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: 'Annotation body cannot be empty' });
  });

  it('trims the stored body', async () => {
    const r = await asA().put(`/annotations/${seeded.feed_a}/0`, { body: '  hi  ' });
    expect((await r.json()).body).toBe('hi');
  });

  it('non-integer post_index is 422', async () => {
    const r = await asA().get(`/annotations/${seeded.feed_a}/abc`);
    expect(r.status).toBe(422);
  });

  it('test_get_annotation_returns_body', async () => {
    const c = asA();
    await c.put(`/annotations/${seeded.feed_a}/1`, { body: 'my note' });
    const r = await c.get(`/annotations/${seeded.feed_a}/1`);
    expect(r.status).toBe(200);
    expect((await r.json()).body).toBe('my note');
  });

  it('test_get_missing_annotation_returns_404', async () => {
    const r = await asA().get(`/annotations/${seeded.feed_a}/999`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'No annotation' });
  });

  it('test_delete_annotation_returns_204 (and audits)', async () => {
    const c = asA();
    await c.put(`/annotations/${seeded.feed_a}/0`, { body: 'gone soon' });
    const r = await c.delete(`/annotations/${seeded.feed_a}/0`);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(await count(USER_A_ID, seeded.feed_a, 0)).toBe(0);
    const [a] = await sql`SELECT resource_type, resource_id, metadata, status_code FROM audit_log WHERE user_id = ${USER_A_ID} AND action = 'annotation.delete'`;
    expect(a).toMatchObject({ resource_type: 'annotation', resource_id: seeded.feed_a, metadata: { post_index: 0 }, status_code: 204 });
  });

  it('test_delete_missing_annotation_returns_404', async () => {
    const r = await asA().delete(`/annotations/${seeded.feed_a}/123`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Annotation not found' });
  });

  it('test_list_annotations_scoped_to_caller', async () => {
    const c = asA();
    await c.put(`/annotations/${seeded.feed_a}/0`, { body: 'A note' });
    await sql`INSERT INTO annotations (user_id, feed_id, post_index, body) VALUES (${USER_B_ID}, ${seeded.feed_b}, 0, 'B note')`;
    const r = await c.get('/annotations');
    expect(r.status).toBe(200);
    const bodies = (await r.json()).map((a: { body: string }) => a.body);
    expect(bodies).toContain('A note');
    expect(bodies).not.toContain('B note');
  });

  it('test_get_cross_user_annotation_returns_404', async () => {
    await sql`INSERT INTO annotations (user_id, feed_id, post_index, body) VALUES (${USER_B_ID}, ${seeded.feed_b}, 0, 'B secret note')`;
    const r = await asA().get(`/annotations/${seeded.feed_b}/0`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('B secret note');
  });

  it('test_delete_cross_user_annotation_returns_404', async () => {
    await sql`INSERT INTO annotations (user_id, feed_id, post_index, body) VALUES (${USER_B_ID}, ${seeded.feed_b}, 0, 'B keeps')`;
    const r = await asA().delete(`/annotations/${seeded.feed_b}/0`);
    expect(r.status).toBe(404);
    expect(await count(USER_B_ID, seeded.feed_b, 0)).toBe(1);
  });

  it('timestamps use isoformat (+00:00), not Z (C 1.3)', async () => {
    const c = asA();
    const put = await (await c.put(`/annotations/${seeded.feed_a}/0`, { body: 'x' })).json();
    const get = await (await c.get(`/annotations/${seeded.feed_a}/0`)).json();
    const list = (await (await c.get('/annotations')).json())[0];
    for (const o of [put, get, list]) {
      expect(o.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?\+00:00$/);
      expect(o.updated_at).toMatch(/\+00:00$/);
    }
    expect(Object.keys(list)).toEqual(['id', 'feed_id', 'post_index', 'body', 'created_at', 'updated_at']);
  });

  it('requires auth', async () => {
    const r = await client(testApp({ config: { authProvider: 'basic' } })).get('/annotations');
    expect(r.status).toBe(401);
  });
});
