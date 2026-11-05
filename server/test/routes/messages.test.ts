import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import type { JobQueue } from '../../src/jobs/queue.js';
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
const limited = (summary: number) =>
  as(USER_A_ID, { authProvider: 'basic', rateLimits: { ...base.rateLimits, summary } });

const progressRow = async (id: string) => (await sql`SELECT queue FROM job_progress WHERE job_id = ${id}`)[0];
const summaryRow = async (paperId: string) =>
  (await sql`SELECT status, task_id, messages FROM paper_summaries WHERE paper_id = ${paperId}`)[0];
/** pg-boss only completes or fails an active job; a test has no worker, so mark it active directly, with its retries spent so a fail is final. */
const activate = (id: string) => sql`UPDATE pgboss.job SET state = 'active', started_on = now(), retry_count = retry_limit WHERE id = ${id}`;
const bubbles = [{ role: 'paper', type: 'summary', content: 'hello world' }];

async function newPaper(userId = USER_A_ID, status = 'complete', extra: { title?: string; corpus?: string } = {}) {
  const id = randomUUID();
  await sql`INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status, title)
            VALUES (${id}, ${userId}, ${extra.corpus ?? null}, 'f.pdf', '/tmp/f.pdf', ${status}, ${extra.title ?? null})`;
  return id;
}

describe('GET /messages/papers/:paper_id', () => {
  it('first GET dispatches: job_progress row, generating row, no generated_at', async () => {
    const r = await as().get(`/messages/papers/${seeded.paper_a}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({
      paper_id: seeded.paper_a,
      title: 'a.pdf',
      authors: [],
      messages: [],
      status: 'generating',
      task_id: expect.any(String),
    });
    expect('generated_at' in j).toBe(false);
    expect((await progressRow(j.task_id))!.queue).toBe('generate_paper_summary');
    const b = await testBoss();
    expect((await b.getJobById('generate_paper_summary', j.task_id))!.data).toEqual({ paper_id: seeded.paper_a });
    expect(await summaryRow(seeded.paper_a)).toMatchObject({ status: 'generating', task_id: j.task_id, messages: [] });
  });

  it('second GET returns the cached generating row and does not dispatch again', async () => {
    const first = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    const second = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    expect(second.task_id).toBe(first.task_id);
    expect(second.status).toBe('generating');
    expect('generated_at' in second).toBe(true);
    expect((await sql`SELECT count(*)::int AS n FROM job_progress`)[0]!.n).toBe(1);
  });

  it.each(['fail', 'cancel'] as const)('re-dispatches when the job was %s-ed', async (op) => {
    const first = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    const b = await testBoss();
    await activate(first.task_id);
    await b[op]('generate_paper_summary', first.task_id);
    const again = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    expect(again.status).toBe('generating');
    expect(again.task_id).not.toBe(first.task_id);
    expect((await summaryRow(seeded.paper_a))!.task_id).toBe(again.task_id);
  });

  it('re-dispatches a legacy Celery task id (missing)', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status, task_id)
              VALUES (${seeded.paper_a}, '[]', 'generating', 'celery-abc')`;
    const j = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    expect(j.task_id).not.toBe('celery-abc');
    expect(j.task_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await summaryRow(seeded.paper_a))!.task_id).toBe(j.task_id);
  });

  it('re-dispatches a generating row stranded on its own completed job', async () => {
    const first = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    await activate(first.task_id);
    await (await testBoss()).complete('generate_paper_summary', first.task_id);
    const again = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    expect(again.status).toBe('generating');
    expect(again.task_id).not.toBe(first.task_id);
    expect((await sql`SELECT count(*)::int AS n FROM job_progress`)[0]!.n).toBe(2);
    expect((await summaryRow(seeded.paper_a))!.task_id).toBe(again.task_id);
  });

  it('re-dispatches when getJobState throws', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status, task_id)
              VALUES (${seeded.paper_a}, '[]', 'generating', ${randomUUID()})`;
    const real = testQueue();
    const queue = Object.create(real) as JobQueue;
    queue.getJobState = async () => {
      throw new Error('db down');
    };
    const app = client(testApp({ user: user(USER_A_ID), queue }));
    const j = await (await app.get(`/messages/papers/${seeded.paper_a}`)).json();
    expect(j.status).toBe('generating');
    expect((await summaryRow(seeded.paper_a))!.task_id).toBe(j.task_id);
    expect((await progressRow(j.task_id))!.queue).toBe('generate_paper_summary');
  });

  it('an error row is re-dispatched', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status, task_id)
              VALUES (${seeded.paper_a}, '[]', 'error', NULL)`;
    const j = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    expect(j.status).toBe('generating');
    expect(await summaryRow(seeded.paper_a)).toMatchObject({ status: 'generating', task_id: j.task_id });
  });

  it('a complete row is returned with generated_at and no task_id', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status) VALUES (${seeded.paper_a}, ${sql.json(bubbles as never)}, 'complete')`;
    const j = await (await as().get(`/messages/papers/${seeded.paper_a}`)).json();
    expect(j.status).toBe('complete');
    expect(j.messages).toEqual(bubbles);
    expect(j.generated_at).toMatch(/Z$/);
    expect('task_id' in j).toBe(false);
  });

  it('404 for another users, unprocessed, unknown and malformed ids', async () => {
    const pending = await newPaper(USER_A_ID, 'pending');
    for (const id of [seeded.paper_b, pending, randomUUID(), 'nope']) {
      const r = await as().get(`/messages/papers/${id}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: 'Paper not found or not processed' });
    }
    expect(await summaryRow(seeded.paper_b)).toBeUndefined();
  });

  it('a complete row read 3 times under summary:1 is never 429; the second dispatch is', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status) VALUES (${seeded.paper_a}, ${sql.json(bubbles as never)}, 'complete')`;
    const app = limited(1);
    for (let i = 0; i < 3; i++) expect((await app.get(`/messages/papers/${seeded.paper_a}`)).status).toBe(200);
    const p2 = await newPaper();
    const p3 = await newPaper();
    expect((await app.get(`/messages/papers/${p2}`)).status).toBe(200);
    const r = await app.get(`/messages/papers/${p3}`);
    expect(r.status).toBe(429);
    expect((await r.json()).detail).toMatch(/^Rate limit exceeded: 1 summary per 24h/);
    expect(await summaryRow(p3)).toBeUndefined();
  });

  it('a stuck redispatch charges the summary bucket once', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status, task_id)
              VALUES (${seeded.paper_a}, '[]', 'generating', 'celery-abc')`;
    const app = limited(1);
    expect((await app.get(`/messages/papers/${seeded.paper_a}`)).status).toBe(200);
    const p2 = await newPaper();
    expect((await app.get(`/messages/papers/${p2}`)).status).toBe(429);
  });
});

describe('GET /messages/papers/:paper_id/status/:task_id', () => {
  const dispatch = async () => (await (await as().get(`/messages/papers/${seeded.paper_a}`)).json()).task_id as string;
  const poll = async (id: string) => (await as().get(`/messages/papers/${seeded.paper_a}/status/${id}`)).json();

  it('a fresh job is generating', async () => {
    expect(await poll(await dispatch())).toEqual({ status: 'generating' });
  });
  it('a completed job is complete', async () => {
    const id = await dispatch();
    await activate(id);
    await (await testBoss()).complete('generate_paper_summary', id);
    expect(await poll(id)).toEqual({ status: 'complete', paper_id: seeded.paper_a });
  });
  it('a failed job is error with the message only', async () => {
    const id = await dispatch();
    await activate(id);
    await (await testBoss()).fail('generate_paper_summary', id, { message: 'boom', stack: 'secret' });
    expect(await poll(id)).toEqual({ status: 'error', error: 'boom' });
  });
  it('an unknown or malformed task id is generating', async () => {
    expect(await poll(randomUUID())).toEqual({ status: 'generating' });
    expect(await poll('celery-abc')).toEqual({ status: 'generating' });
  });
});

describe('GET /messages/papers', () => {
  it('lists only the callers complete papers with summary fields and an 80 code point preview', async () => {
    const long = '😀'.repeat(100);
    await sql`INSERT INTO paper_summaries (paper_id, messages, status)
              VALUES (${seeded.paper_a}, ${sql.json([{ content: 'first' }, { content: long }] as never)}, 'complete')`;
    await newPaper(USER_A_ID, 'pending');
    const withTitle = await newPaper(USER_A_ID, 'complete', { title: 'Titled' });
    const rows = await (await as().get('/messages/papers')).json();
    expect(rows.map((x: any) => x.paper_id).sort()).toEqual([seeded.paper_a, withTitle].sort());
    const a = rows.find((x: any) => x.paper_id === seeded.paper_a);
    expect(a).toMatchObject({ title: 'a.pdf', authors: [], has_summary: true, message_count: 2 });
    expect(Array.from(a.last_message_preview)).toHaveLength(80);
    expect(a.summary_generated_at).toMatch(/Z$/);
    expect(a.uploaded_at).toMatch(/Z$/);
    const t = rows.find((x: any) => x.paper_id === withTitle);
    expect(t).toMatchObject({ title: 'Titled', has_summary: false, message_count: 0, last_message_preview: null, summary_generated_at: null });
  });

  it('filters by workspace_id', async () => {
    const rows = await (await as().get(`/messages/papers?workspace_id=${seeded.workspace_a}`)).json();
    expect(rows.map((x: any) => x.paper_id)).toEqual([seeded.paper_a]);
    expect(await (await as().get(`/messages/papers?workspace_id=${seeded.workspace_b}`)).json()).toEqual([]);
    expect(await (await as().get('/messages/papers?workspace_id=nope')).json()).toEqual([]);
  });

  it('is scoped to the caller', async () => {
    const rows = await (await as(USER_B_ID).get('/messages/papers')).json();
    expect(rows.map((x: any) => x.paper_id)).toEqual([seeded.paper_b]);
  });
});

describe('GET /messages/papers/tldrs', () => {
  it('maps paper id to a 200 code point tldr, only for the caller and complete summaries', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status) VALUES
      (${seeded.paper_a}, ${sql.json([{ content: 'x'.repeat(300) }] as never)}, 'complete'),
      (${seeded.paper_b}, ${sql.json([{ content: 'theirs' }] as never)}, 'complete')`;
    const gen = await newPaper();
    await sql`INSERT INTO paper_summaries (paper_id, messages, status) VALUES (${gen}, '[]', 'generating')`;
    expect(await (await as().get('/messages/papers/tldrs')).json()).toEqual({ [seeded.paper_a]: 'x'.repeat(200) });
    expect(await (await as(USER_B_ID).get('/messages/papers/tldrs')).json()).toEqual({ [seeded.paper_b]: 'theirs' });
  });
});

describe('group chats', () => {
  const post = (id: string, b: unknown) => as(id).post('/messages/groups', b);
  const synth = async (userId: string, status: string, taskId: string | null, messages: unknown[] = []) => {
    const id = randomUUID();
    await sql`INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
              VALUES (${id}, ${userId}, 'S', ${[seeded.paper_a]}::uuid[], ${sql.json(messages as never)}, ${status}, ${taskId})`;
    return id;
  };

  it('POST with one id is 400', async () => {
    const r = await post(USER_A_ID, { name: 'g', paper_ids: [seeded.paper_a] });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: 'Need at least 2 papers for a group chat' });
  });

  it('POST 404s on a duplicate id, another users paper, and a malformed id', async () => {
    const p2 = await newPaper();
    for (const ids of [[p2, p2], [p2, seeded.paper_b], [p2, 'nope'], [p2, randomUUID()]]) {
      const r = await post(USER_A_ID, { name: 'g', paper_ids: ids });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: 'One or more papers not found' });
    }
    expect((await sql`SELECT count(*)::int AS n FROM corpus_syntheses`)[0]!.n).toBe(0);
  });

  it('POST 422 on a bad body', async () => {
    expect((await post(USER_A_ID, { name: 'g' })).status).toBe(422);
  });

  it('POST 202 inserts a generating placeholder; GET returns it with the task_id', async () => {
    const p2 = await newPaper(USER_A_ID, 'complete', { title: 'Two' });
    const r = await post(USER_A_ID, { name: 'Wave', paper_ids: [seeded.paper_a, p2] });
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j).toEqual({ synthesis_id: expect.any(String), task_id: expect.any(String), status: 'generating' });
    expect((await progressRow(j.task_id))!.queue).toBe('generate_corpus_synthesis');
    const b = await testBoss();
    expect((await b.getJobById('generate_corpus_synthesis', j.task_id))!.data).toEqual({
      synthesis_id: j.synthesis_id,
      paper_ids: [seeded.paper_a, p2],
      name: 'Wave',
      user_id: USER_A_ID,
    });
    const row = (await sql`SELECT status, task_id, messages, name FROM corpus_syntheses WHERE id = ${j.synthesis_id}`)[0];
    expect(row).toMatchObject({ status: 'generating', task_id: j.task_id, messages: [], name: 'Wave' });

    const g = await (await as().get(`/messages/groups/${j.synthesis_id}`)).json();
    expect(g).toMatchObject({
      id: j.synthesis_id,
      name: 'Wave',
      papers: { [seeded.paper_a]: 'a.pdf', [p2]: 'Two' },
      messages: [],
      status: 'generating',
      task_id: j.task_id,
    });
    expect(g.generated_at).toMatch(/Z$/);
  });

  it('POST is rate limited on the summary bucket before validation', async () => {
    const app = limited(1);
    expect((await app.post('/messages/groups', { bad: true })).status).toBe(422);
    const r = await app.post('/messages/groups', { name: 'g', paper_ids: [] });
    expect(r.status).toBe(429);
  });

  it('GET: error row is error without task_id; complete row is complete without task_id', async () => {
    const e = await (await as().get(`/messages/groups/${await synth(USER_A_ID, 'error', null)}`)).json();
    expect(e.status).toBe('error');
    expect('task_id' in e).toBe(false);
    const done = await synth(USER_A_ID, 'complete', 'old', [{ role: 'synthesis', content: 'done' }]);
    const c = await (await as().get(`/messages/groups/${done}`)).json();
    expect(c.status).toBe('complete');
    expect(c.messages).toHaveLength(1);
    expect('task_id' in c).toBe(false);
  });

  it('GET 404s on unknown, malformed and other users ids', async () => {
    const theirs = await synth(USER_B_ID, 'complete', null);
    for (const id of [randomUUID(), 'nope', theirs]) {
      const r = await as().get(`/messages/groups/${id}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: 'Group chat not found' });
    }
  });

  it('GET /groups lists only the callers, with counts and preview', async () => {
    const mine = await synth(USER_A_ID, 'complete', null, [{ content: 'a' }, { content: 'z'.repeat(100) }]);
    await synth(USER_B_ID, 'complete', null);
    const rows = await (await as().get('/messages/groups')).json();
    expect(rows).toEqual([
      {
        id: mine,
        name: 'S',
        paper_count: 1,
        message_count: 2,
        last_message_preview: 'z'.repeat(80),
        generated_at: expect.stringMatching(/Z$/),
      },
    ]);
    const empty = await synth(USER_A_ID, 'generating', 't');
    const all = await (await as().get('/messages/groups')).json();
    expect(all.find((x: any) => x.id === empty).last_message_preview).toBeNull();
  });
});
