import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
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

async function newPost(userId = USER_A_ID, status = 'complete', replies: unknown[] = [], taskId: string | null = null) {
  const id = randomUUID();
  await sql`INSERT INTO user_posts (id, user_id, content, status, replies, task_id)
            VALUES (${id}, ${userId}, 'hello', ${status}, ${sql.json(replies as never)}, ${taskId})`;
  return id;
}

type Line = Record<string, unknown> & { msg: string; level: number };
/** A client whose log lines are captured; `queue` overrides the test queue. */
function logged(queue?: JobQueue) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x) as Line) });
  return { c: client(testApp({ user: user(USER_A_ID), logger, ...(queue ? { queue } : {}) })), lines };
}
const jobCount = async () => (await sql`SELECT count(*)::int AS n FROM job_progress`)[0]!.n as number;
/** pg-boss only completes or fails an active job; a test has no worker, so mark it active directly. `final` spends its retries so a fail is final. */
const activate = (id: string, final = true) =>
  final
    ? sql`UPDATE pgboss.job SET state = 'active', started_on = now(), retry_count = retry_limit WHERE id = ${id}`
    : sql`UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = ${id}`;
/** A follow-up job in the given end state (`null` leaves it created; `retry` is a non-final fail). */
async function jobIn(op: 'complete' | 'fail' | 'cancel' | 'retry' | 'active' | null) {
  const id = await testQueue().send('respond_to_user_post_followup', { user_post_id: randomUUID() });
  if (op === 'active') await activate(id);
  else if (op === 'retry') {
    await activate(id, false);
    await (await testBoss()).fail('respond_to_user_post_followup', id);
  } else if (op) {
    await activate(id);
    await (await testBoss())[op]('respond_to_user_post_followup', id);
  }
  return id;
}
const answered = [{ role: 'archivist', persona: 'archivist', content: 'a' }];
const unanswered = [...answered, { role: 'user', content: 'lost' }];

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
    // The previous answer's job id is still on the row; the failed dispatch clears it.
    const id = await newPost(USER_A_ID, 'complete', answered, randomUUID());
    const { c, lines } = logged(failingQueue());
    const r = await c.post(`/user-posts/${id}/replies`, { content: 'x' });
    expect([r.status, (await r.json()).detail]).toEqual([503, 'Failed to dispatch Archivist response. Try again.']);
    const row = await postRow(id);
    expect(row).toMatchObject({ status: 'error', task_id: null });
    expect(row!.replies.at(-1)).toEqual({ role: 'user', content: 'x' });
    expect(lines.find((l) => l.msg === 'user_post_dispatch_failed')).toMatchObject({
      level: 50, post_id: id, error: 'broker down',
    });
  });

  it('deliberate change 11: after a dispatch failure a follow-up retries, replacing the trailing user turn', async () => {
    const id = await newPost(USER_A_ID, 'complete', answered);
    const failed = client(testApp({ user: user(USER_A_ID), queue: failingQueue() }));
    expect((await failed.post(`/user-posts/${id}/replies`, { content: 'x' })).status).toBe(503);
    const r = await as().post(`/user-posts/${id}/replies`, { content: 'y' });
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j).toEqual({ id, task_id: expect.any(String), status: 'pending' });
    const row = await postRow(id);
    expect(row).toMatchObject({ status: 'pending', task_id: j.task_id });
    expect(row!.replies).toEqual([...answered, { role: 'user', content: 'y' }]);
    expect((await progressRow(j.task_id))!.queue).toBe('respond_to_user_post_followup');
    expect((await (await testBoss()).getJobById('respond_to_user_post_followup', j.task_id))!.data).toEqual({
      user_post_id: id,
    });
  });

  it('an error row whose task_id is set is 409 (a pg-boss retry is pending)', async () => {
    const id = await newPost(USER_A_ID, 'error', unanswered, randomUUID());
    const r = await as().post(`/user-posts/${id}/replies`, { content: 'x' });
    expect([r.status, (await r.json()).detail]).toEqual([409, 'Previous reply not ready yet']);
    expect(await postRow(id)).toMatchObject({ status: 'error', replies: unanswered });
    expect(await jobCount()).toBe(0);
  });

  it('an error row whose last turn is archivist, or with no turns (a failed first answer), is 409', async () => {
    for (const replies of [answered, []]) {
      const id = await newPost(USER_A_ID, 'error', replies);
      const r = await as().post(`/user-posts/${id}/replies`, { content: 'x' });
      expect([r.status, (await r.json()).detail]).toEqual([409, 'Previous reply not ready yet']);
      expect(await postRow(id)).toMatchObject({ status: 'error', task_id: null, replies });
    }
    expect(await jobCount()).toBe(0);
  });

  it('two concurrent retries of a retryable row: exactly one 202', async () => {
    const id = await newPost(USER_A_ID, 'error', unanswered);
    const rs = await Promise.all([
      as().post(`/user-posts/${id}/replies`, { content: 'one' }),
      as().post(`/user-posts/${id}/replies`, { content: 'two' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409]);
    const row = await postRow(id);
    expect(row!.replies).toHaveLength(unanswered.length);
    expect(row!.replies.at(-2)).toEqual(answered[0]);
    expect(['one', 'two']).toContain(row!.replies.at(-1).content);
    expect(await jobCount()).toBe(1);
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

  it('Review Focus 3: a pending row on a lost job (legacy id, missing) becomes error and is logged', async () => {
    const id = await newPost(USER_A_ID, 'pending', unanswered, 'celery-abc');
    const { c, lines } = logged();
    expect(await (await c.get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'error', task_id: '' });
    expect(await postRow(id)).toMatchObject({ status: 'error', task_id: null, replies: unanswered });
    expect(lines.find((l) => l.msg === 'user_post_stuck_pending')).toMatchObject({
      level: 40, post_id: id, old_task_id: 'celery-abc', task_state: 'missing',
    });
    expect(await jobCount()).toBe(0);
    // ...and a follow-up on it can then be retried.
    expect((await as().post(`/user-posts/${id}/replies`, { content: 'again' })).status).toBe(202);
    expect((await postRow(id))!.replies).toEqual([...answered, { role: 'user', content: 'again' }]);
  });

  it.each(['fail', 'cancel'] as const)('a pending row on a %s-ed job becomes error', async (op) => {
    const old = await jobIn(op);
    const id = await newPost(USER_A_ID, 'pending', unanswered, old);
    expect(await (await as().get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'error', task_id: '' });
    expect(await postRow(id)).toMatchObject({ status: 'error', task_id: null });
  });

  it.each(['created', 'retry', 'active', 'complete'] as const)('a pending row on a %s job stays pending', async (op) => {
    const old = await jobIn(op === 'created' ? null : op);
    const id = await newPost(USER_A_ID, 'pending', unanswered, old);
    const { c, lines } = logged();
    expect(await (await c.get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'pending', task_id: old });
    expect(await postRow(id)).toMatchObject({ status: 'pending', task_id: old });
    expect(lines.some((l) => l.msg === 'user_post_stuck_pending')).toBe(false);
  });

  it('a pending row without a task_id stays pending', async () => {
    const id = await newPost(USER_A_ID, 'pending', unanswered);
    expect(await (await as().get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'pending', task_id: '' });
    expect(await postRow(id)).toMatchObject({ status: 'pending', task_id: null });
  });

  it('a throwing getJobState leaves a pending row pending', async () => {
    const queue = Object.create(testQueue()) as JobQueue;
    queue.getJobState = async () => {
      throw new Error('db down');
    };
    const old = randomUUID();
    const id = await newPost(USER_A_ID, 'pending', unanswered, old);
    const { c, lines } = logged(queue);
    expect(await (await c.get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'pending', task_id: old });
    expect(await postRow(id)).toMatchObject({ status: 'pending', task_id: old });
    expect(lines.find((l) => l.msg === 'user_post_status_check_failed')).toMatchObject({
      level: 40, post_id: id, task_id: old, err: 'db down',
    });
  });

  it('an error row on a lost job clears its task_id, and a follow-up then retries', async () => {
    const id = await newPost(USER_A_ID, 'error', unanswered, 'celery-abc');
    const { c, lines } = logged();
    expect(await (await c.get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'error', task_id: '' });
    expect(await postRow(id)).toMatchObject({ status: 'error', task_id: null, replies: unanswered });
    expect(lines.find((l) => l.msg === 'user_post_stuck_error')).toMatchObject({
      level: 40, post_id: id, old_task_id: 'celery-abc', task_state: 'missing',
    });
    expect((await as().post(`/user-posts/${id}/replies`, { content: 'y' })).status).toBe(202);
  });

  it.each(['fail', 'cancel'] as const)('an error row on a %s-ed job clears its task_id', async (op) => {
    const old = await jobIn(op);
    const id = await newPost(USER_A_ID, 'error', unanswered, old);
    expect(await (await as().get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'error', task_id: '' });
    expect(await postRow(id)).toMatchObject({ status: 'error', task_id: null });
  });

  it.each(['created', 'retry', 'active'] as const)('an error row on a %s job keeps its task_id; a follow-up is 409', async (op) => {
    const old = await jobIn(op === 'created' ? null : op);
    const id = await newPost(USER_A_ID, 'error', unanswered, old);
    const { c, lines } = logged();
    expect(await (await c.get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'error', task_id: old });
    expect(await postRow(id)).toMatchObject({ status: 'error', task_id: old });
    expect(lines.some((l) => l.msg === 'user_post_stuck_error')).toBe(false);
    const r = await as().post(`/user-posts/${id}/replies`, { content: 'x' });
    expect([r.status, (await r.json()).detail]).toEqual([409, 'Previous reply not ready yet']);
  });

  it('a complete row with a task_id is never checked', async () => {
    const queue = Object.create(testQueue()) as JobQueue;
    queue.getJobState = async () => {
      throw new Error('must not be called');
    };
    const id = await newPost(USER_A_ID, 'complete', answered, 'celery-abc');
    const { c } = logged(queue);
    expect(await (await c.get(`/user-posts/${id}/status`)).json()).toEqual({ status: 'complete', task_id: 'celery-abc' });
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
