import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { testBoss, testQueue } from '../helpers/queue.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const as = (id = USER_A_ID, config: Record<string, unknown> = {}) => client(testApp({ user: user(id), config }));
const base = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' });
const failingQueue = () => {
  const q = Object.create(testQueue()) as JobQueue;
  q.send = async () => {
    throw new Error('broker down');
  };
  return q;
};
const progressRow = async (id: string) => (await sql`SELECT queue FROM job_progress WHERE job_id = ${id}`)[0];
const postRow = async (id: string) =>
  (await sql`SELECT status, task_id, replies, corpus_id FROM user_posts WHERE id = ${id}`)[0];

async function newPost(userId = USER_A_ID, status = 'complete', replies: unknown[] = []) {
  const id = randomUUID();
  await sql`INSERT INTO user_posts (id, user_id, content, status, replies)
            VALUES (${id}, ${userId}, 'hello', ${status}, ${sql.json(replies as never)})`;
  return id;
}

describe('POST /user-posts', () => {
  it('201, dispatches respond_to_user_post, stores task_id', async () => {
    const r = await as().post('/user-posts', { content: 'q?', corpus_id: seeded.workspace_a });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toEqual({ id: expect.any(String), task_id: expect.any(String), status: 'pending' });
    expect((await progressRow(j.task_id))!.queue).toBe('respond_to_user_post');
    const b = await testBoss();
    expect((await b.getJobById('respond_to_user_post', j.task_id))!.data).toEqual({
      user_post_id: j.id,
      corpus_id: seeded.workspace_a,
    });
    expect(await postRow(j.id)).toMatchObject({ status: 'pending', task_id: j.task_id });
  });

  it('no corpus_id sends null', async () => {
    const j = await (await as().post('/user-posts', { content: 'q?' })).json();
    const b = await testBoss();
    expect((await b.getJobById('respond_to_user_post', j.task_id))!.data).toEqual({ user_post_id: j.id, corpus_id: null });
  });

  it("another user's workspace is 404 and creates nothing", async () => {
    const r = await as().post('/user-posts', { content: 'q', corpus_id: seeded.workspace_b });
    expect([r.status, (await r.json()).detail]).toEqual([404, 'Workspace not found']);
    expect((await sql`SELECT count(*)::int AS n FROM user_posts`)[0]!.n).toBe(0);
  });

  it('malformed corpus_id is 404 Workspace not found', async () => {
    const r = await as().post('/user-posts', { content: 'q', corpus_id: 'nope' });
    expect([r.status, (await r.json()).detail]).toEqual([404, 'Workspace not found']);
  });

  it('content over 4000 code points is 422', async () => {
    expect((await as().post('/user-posts', { content: 'a'.repeat(4001) })).status).toBe(422);
    expect((await as().post('/user-posts', { content: '😀'.repeat(4000) })).status).toBe(201);
  });

  it('dispatch failure: 503 and the row is error', async () => {
    const app = client(testApp({ user: user(USER_A_ID), queue: failingQueue() }));
    const r = await app.post('/user-posts', { content: 'q' });
    expect([r.status, (await r.json()).detail]).toEqual([503, 'Failed to dispatch Archivist response. Try again.']);
    const [row] = await sql`SELECT status, task_id FROM user_posts`;
    expect(row).toMatchObject({ status: 'error', task_id: null });
  });
});

describe('POST /user-posts/:id/replies', () => {
  it('202, appends the user turn, dispatches the follow-up', async () => {
    const id = await newPost(USER_A_ID, 'complete', [{ role: 'archivist', content: 'a' }]);
    const r = await as().post(`/user-posts/${id}/replies`, { content: 'more' });
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j).toEqual({ id, task_id: expect.any(String), status: 'pending' });
    expect((await progressRow(j.task_id))!.queue).toBe('respond_to_user_post_followup');
    const b = await testBoss();
    expect((await b.getJobById('respond_to_user_post_followup', j.task_id))!.data).toEqual({ user_post_id: id });
    expect(await postRow(id)).toMatchObject({
      status: 'pending',
      task_id: j.task_id,
      replies: [{ role: 'archivist', content: 'a' }, { role: 'user', content: 'more' }],
    });
  });

  it('pending post is 409', async () => {
    const id = await newPost(USER_A_ID, 'pending');
    const r = await as().post(`/user-posts/${id}/replies`, { content: 'x' });
    expect([r.status, (await r.json()).detail]).toEqual([409, 'Previous reply not ready yet']);
  });

  it("someone else's, missing and malformed posts are 404", async () => {
    const id = await newPost(USER_B_ID);
    for (const p of [id, randomUUID(), 'nope']) {
      const r = await as().post(`/user-posts/${p}/replies`, { content: 'x' });
      expect([r.status, (await r.json()).detail]).toEqual([404, 'Post not found']);
    }
  });

  it('concurrent follow-ups: exactly one wins, one user turn appended', async () => {
    const id = await newPost(USER_A_ID, 'complete');
    const rs = await Promise.all([
      as().post(`/user-posts/${id}/replies`, { content: 'one' }),
      as().post(`/user-posts/${id}/replies`, { content: 'two' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409]);
    const row = await postRow(id);
    expect(row!.replies).toHaveLength(1);
    expect(row!.replies[0].role).toBe('user');
  });

  it('dispatch failure: 503 and status error (deliberate change 4)', async () => {
    const id = await newPost(USER_A_ID, 'complete');
    const app = client(testApp({ user: user(USER_A_ID), queue: failingQueue() }));
    const r = await app.post(`/user-posts/${id}/replies`, { content: 'x' });
    expect([r.status, (await r.json()).detail]).toEqual([503, 'Failed to dispatch Archivist response. Try again.']);
    expect((await postRow(id))!.status).toBe('error');
  });

  it('shares the user_post bucket with create (basic, limit 1)', async () => {
    const app = as(USER_A_ID, { authProvider: 'basic', rateLimits: { ...base.rateLimits, user_post: 1 } });
    const created = await app.post('/user-posts', { content: 'q' });
    expect(created.status).toBe(201);
    const id = (await created.json()).id;
    await sql`UPDATE user_posts SET status = 'complete' WHERE id = ${id}`;
    const r = await app.post(`/user-posts/${id}/replies`, { content: 'x' });
    expect(r.status).toBe(429);
  });
});

describe('GET /user-posts', () => {
  it('lists own posts newest first with the UserPost shape; workspace filter', async () => {
    const old = await newPost();
    await sql`UPDATE user_posts SET created_at = now() - interval '1 day', corpus_id = ${seeded.workspace_a} WHERE id = ${old}`;
    const fresh = await newPost();
    await newPost(USER_B_ID);
    const j = await (await as().get('/user-posts')).json();
    expect(j.map((p: { id: string }) => p.id)).toEqual([fresh, old]);
    expect(j[0]).toEqual({
      id: fresh,
      content: 'hello',
      replies: [],
      sources: [],
      status: 'complete',
      created_at: expect.stringMatching(/Z$/),
    });
    const f = await (await as().get(`/user-posts?workspace_id=${seeded.workspace_a}`)).json();
    expect(f.map((p: { id: string }) => p.id)).toEqual([old]);
    expect(await (await as().get('/user-posts?workspace_id=nope')).json()).toEqual([]);
  });

  it('GET /:id: owner 200, others and malformed 404', async () => {
    const id = await newPost();
    expect((await as().get(`/user-posts/${id}`)).status).toBe(200);
    for (const [u, p] of [[USER_B_ID, id], [USER_A_ID, 'nope'], [USER_A_ID, randomUUID()]] as const) {
      const r = await as(u).get(`/user-posts/${p}`);
      expect([r.status, (await r.json()).detail]).toEqual([404, 'Post not found']);
    }
  });
});

describe('GET /user-posts/:id/status', () => {
  it('returns status and task_id (empty when null)', async () => {
    const id = await newPost();
    expect(await (await as().get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'complete', task_id: '' });
    await sql`UPDATE user_posts SET task_id = 't1' WHERE id = ${id}`;
    expect(await (await as().get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'complete', task_id: 't1' });
  });

  it("another user's post is 404", async () => {
    const id = await newPost(USER_A_ID);
    const r = await as(USER_B_ID).get(`/user-posts/${id}/status`);
    expect([r.status, (await r.json()).detail]).toEqual([404, 'Post not found']);
  });
});

describe('DELETE /user-posts/:id', () => {
  it('other user 404 and the row stays; owner 204 + audit', async () => {
    const id = await newPost(USER_A_ID);
    const r = await as(USER_B_ID).delete(`/user-posts/${id}`);
    expect([r.status, (await r.json()).detail]).toEqual([404, 'Post not found']);
    expect(await postRow(id)).toBeTruthy();
    expect((await as().delete(`/user-posts/${id}`)).status).toBe(204);
    expect(await postRow(id)).toBeUndefined();
    const [a] = await sql`SELECT resource_type, resource_id, status_code FROM audit_log WHERE action = 'user_post.delete'`;
    expect(a).toMatchObject({ resource_type: 'user_post', resource_id: id, status_code: 204 });
    expect((await as().delete(`/user-posts/nope`)).status).toBe(404);
  });
});
