import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
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

type Line = Record<string, unknown> & { msg: string; level: number };
/** A client whose log lines are captured; `queue` overrides the test queue. */
function logged(opts: { config?: Record<string, unknown>; queue?: JobQueue } = {}) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x) as Line) });
  return { c: client(testApp({ user: user(USER_A_ID), logger, ...opts })), lines };
}
/** A queue over the test queue whose getJobState throws. */
function throwingQueue(): JobQueue {
  const queue = Object.create(testQueue()) as JobQueue;
  queue.getJobState = async () => {
    throw new Error('db down');
  };
  return queue;
}
const jobCount = async () => (await sql`SELECT count(*)::int AS n FROM job_progress`)[0]!.n as number;

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

  it('logs paper_summary_stuck_generating with err only when the state read threw', async () => {
    await sql`INSERT INTO paper_summaries (paper_id, messages, status, task_id)
              VALUES (${seeded.paper_a}, '[]', 'generating', 'celery-abc')`;
    const missing = logged();
    await missing.c.get(`/messages/papers/${seeded.paper_a}`);
    const m = missing.lines.find((l) => l.msg === 'paper_summary_stuck_generating')!;
    expect(m).toMatchObject({ level: 40, paper_id: seeded.paper_a, old_task_id: 'celery-abc', task_state: 'missing' });
    expect('err' in m).toBe(false);

    const stuck = randomUUID();
    await sql`UPDATE paper_summaries SET task_id = ${stuck} WHERE paper_id = ${seeded.paper_a}`;
    const threw = logged({ queue: throwingQueue() });
    await threw.c.get(`/messages/papers/${seeded.paper_a}`);
    expect(threw.lines.find((l) => l.msg === 'paper_summary_stuck_generating')).toMatchObject({
      level: 40, paper_id: seeded.paper_a, old_task_id: stuck, task_state: 'unknown', err: 'db down',
    });
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
  describe('the stuck check (deliberate change 10)', () => {
    const synthRow = async (id: string) =>
      (await sql`SELECT status, task_id, messages FROM corpus_syntheses WHERE id = ${id}`)[0]!;
    const done = [{ role: 'synthesis', content: 'done' }];
    /** A real generate_corpus_synthesis job driven to a final state. */
    const jobIn = async (op: 'complete' | 'fail' | 'cancel' | null) => {
      const id = await testQueue().send('generate_corpus_synthesis', { synthesis_id: randomUUID() });
      if (op) {
        await activate(id);
        await (await testBoss())[op]('generate_corpus_synthesis', id);
      }
      return id;
    };
    const expectRedispatched = async (id: string, old: string, j: any) => {
      expect(j.status).toBe('generating');
      expect(j.task_id).not.toBe(old);
      expect(j.task_id).toMatch(/^[0-9a-f-]{36}$/);
      expect((await progressRow(j.task_id))!.queue).toBe('generate_corpus_synthesis');
      expect((await (await testBoss()).getJobById('generate_corpus_synthesis', j.task_id))!.data).toEqual({
        synthesis_id: id,
        paper_ids: [seeded.paper_a],
        name: 'S',
        user_id: USER_A_ID,
      });
      expect(await synthRow(id)).toMatchObject({ status: 'generating', task_id: j.task_id, messages: [] });
    };

    it('a generating row on a legacy Celery id (missing) re-dispatches and logs the stuck row', async () => {
      const id = await synth(USER_A_ID, 'generating', 'celery-abc');
      const { c, lines } = logged();
      const r = await c.get(`/messages/groups/${id}`);
      expect(r.status).toBe(200);
      const j = await r.json();
      await expectRedispatched(id, 'celery-abc', j);
      expect(j).toMatchObject({ id, name: 'S', papers: { [seeded.paper_a]: 'a.pdf' }, messages: [] });
      const warn = lines.find((l) => l.msg === 'corpus_synthesis_stuck_generating')!;
      expect(warn).toMatchObject({ level: 40, synthesis_id: id, old_task_id: 'celery-abc', task_state: 'missing' });
      expect('err' in warn).toBe(false);
      expect(lines.find((l) => l.msg === 'corpus_synthesis_dispatched')).toMatchObject({
        synthesis_id: id, task_id: j.task_id,
      });
    });

    it.each(['fail', 'cancel'] as const)('a generating row on a %s-ed job re-dispatches', async (op) => {
      const old = await jobIn(op);
      const id = await synth(USER_A_ID, 'generating', old);
      await expectRedispatched(id, old, await (await as().get(`/messages/groups/${id}`)).json());
    });

    it('a generating row on its own completed job with messages heals to complete without a dispatch', async () => {
      const old = await jobIn('complete');
      const id = await synth(USER_A_ID, 'generating', old, done);
      const { c, lines } = logged();
      const j = await (await c.get(`/messages/groups/${id}`)).json();
      expect(j).toMatchObject({ id, status: 'complete', messages: done });
      expect('task_id' in j).toBe(false);
      expect(await jobCount()).toBe(1);
      expect(await synthRow(id)).toEqual({ status: 'complete', task_id: null, messages: done });
      expect(lines.find((l) => l.msg === 'corpus_synthesis_stuck_generating')).toMatchObject({
        synthesis_id: id, old_task_id: old, task_state: 'completed',
      });
      expect(lines.some((l) => l.msg === 'corpus_synthesis_dispatched')).toBe(false);
    });

    it('a generating row on its own completed job with empty messages re-dispatches', async () => {
      const old = await jobIn('complete');
      const id = await synth(USER_A_ID, 'generating', old);
      await expectRedispatched(id, old, await (await as().get(`/messages/groups/${id}`)).json());
      expect(await jobCount()).toBe(2);
    });

    it('a throwing getJobState re-dispatches and logs err', async () => {
      const old = randomUUID();
      const id = await synth(USER_A_ID, 'generating', old);
      const { c, lines } = logged({ queue: throwingQueue() });
      await expectRedispatched(id, old, await (await c.get(`/messages/groups/${id}`)).json());
      expect(lines.find((l) => l.msg === 'corpus_synthesis_stuck_generating')).toMatchObject({
        synthesis_id: id, old_task_id: old, task_state: 'unknown', err: 'db down',
      });
    });

    it.each(['created', 'active'] as const)('a %s job is not stranded: no dispatch, no write', async (state) => {
      const old = await jobIn(null);
      if (state === 'active') await activate(old);
      const id = await synth(USER_A_ID, 'generating', old);
      const { c, lines } = logged();
      const j = await (await c.get(`/messages/groups/${id}`)).json();
      expect(j).toMatchObject({ status: 'generating', task_id: old });
      expect(await jobCount()).toBe(1);
      expect(await synthRow(id)).toMatchObject({ status: 'generating', task_id: old });
      expect(lines.some((l) => l.msg === 'corpus_synthesis_stuck_generating')).toBe(false);
    });

    it('an error row on a lost job keeps its behaviour: no regenerate', async () => {
      const id = await synth(USER_A_ID, 'error', 'celery-abc');
      const j = await (await as().get(`/messages/groups/${id}`)).json();
      expect(j.status).toBe('error');
      expect('task_id' in j).toBe(false);
      expect(await jobCount()).toBe(0);
      expect(await synthRow(id)).toMatchObject({ status: 'error', task_id: 'celery-abc' });
    });

    it('a generating row without a task_id is left alone', async () => {
      const id = await synth(USER_A_ID, 'generating', null);
      const j = await (await as().get(`/messages/groups/${id}`)).json();
      expect(j.status).toBe('generating');
      expect('task_id' in j).toBe(false);
      expect(await jobCount()).toBe(0);
    });

    it('a stuck GET charges the summary bucket once; the next stuck GET is 429 and dispatches nothing', async () => {
      const app = limited(1);
      const first = await synth(USER_A_ID, 'generating', 'celery-1');
      expect((await app.get(`/messages/groups/${first}`)).status).toBe(200);
      const second = await synth(USER_A_ID, 'generating', 'celery-2');
      const r = await app.get(`/messages/groups/${second}`);
      expect(r.status).toBe(429);
      expect((await r.json()).detail).toMatch(/^Rate limit exceeded: 1 summary per 24h/);
      expect(await jobCount()).toBe(1);
      expect(await synthRow(second)).toMatchObject({ status: 'generating', task_id: 'celery-2' });
    });

    it('the healed case read three times never charges', async () => {
      const app = limited(1);
      const healed = await synth(USER_A_ID, 'generating', 'celery-abc', done);
      for (let i = 0; i < 3; i++) {
        const r = await app.get(`/messages/groups/${healed}`);
        expect(r.status).toBe(200);
        expect((await r.json()).status).toBe('complete');
      }
      expect(await jobCount()).toBe(0);
      // The bucket is untouched: one real dispatch still fits, the next does not.
      expect((await app.get(`/messages/groups/${await synth(USER_A_ID, 'generating', 'celery-1')}`)).status).toBe(200);
      expect((await app.get(`/messages/groups/${await synth(USER_A_ID, 'generating', 'celery-2')}`)).status).toBe(429);
    });

    it('the re-dispatch only takes over the row it saw: a row changed meanwhile is answered as stored', async () => {
      const id = await synth(USER_A_ID, 'generating', 'celery-abc');
      const real = testQueue();
      const queue = Object.create(real) as JobQueue;
      // The worker of the old job finishes between the state read and the take-over.
      queue.send = async (name, data) => {
        const t = await real.send(name, data);
        await sql`UPDATE corpus_syntheses SET status = 'complete', task_id = NULL, messages = ${sql.json(done as never)}
                  WHERE id = ${id}`;
        return t;
      };
      const j = await (await client(testApp({ user: user(USER_A_ID), queue })).get(`/messages/groups/${id}`)).json();
      expect(j).toMatchObject({ status: 'complete', messages: done });
      expect('task_id' in j).toBe(false);
      expect(await synthRow(id)).toEqual({ status: 'complete', task_id: null, messages: done });
    });
    it('the heal only touches the row it saw: a task id changed meanwhile is left and answered as stored', async () => {
      const id = await synth(USER_A_ID, 'generating', 'celery-abc', done);
      const fresh = await jobIn(null);
      const queue = Object.create(testQueue()) as JobQueue;
      // Another request takes the row over between this request's read and its heal.
      queue.getJobState = async (taskId) => {
        await sql`UPDATE corpus_syntheses SET task_id = ${fresh} WHERE id = ${id}`;
        return testQueue().getJobState(taskId);
      };
      const j = await (await client(testApp({ user: user(USER_A_ID), queue })).get(`/messages/groups/${id}`)).json();
      expect(j).toMatchObject({ status: 'generating', task_id: fresh, messages: done });
      expect(await synthRow(id)).toEqual({ status: 'generating', task_id: fresh, messages: done });
    });
  });

  it('POST race: a row the worker wrote before the placeholder insert is kept', async () => {
    const p2 = await newPaper();
    const real = testQueue();
    const queue = Object.create(real) as JobQueue;
    queue.send = async (name, data) => {
      const t = await real.send(name, data);
      await sql`INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
                VALUES (${data.synthesis_id as string}, ${USER_A_ID}, 'Worker', ${[seeded.paper_a, p2]}::uuid[],
                        ${sql.json([{ role: 'synthesis', content: 'done' }] as never)}, 'complete', NULL)`;
      return t;
    };
    const r = await client(testApp({ user: user(USER_A_ID), queue })).post('/messages/groups', {
      name: 'Wave',
      paper_ids: [seeded.paper_a, p2],
    });
    expect(r.status).toBe(202);
    const j = await r.json();
    const row = (await sql`SELECT status, task_id, messages, name FROM corpus_syntheses WHERE id = ${j.synthesis_id}`)[0];
    expect(row).toEqual({
      status: 'complete', task_id: null, messages: [{ role: 'synthesis', content: 'done' }], name: 'Worker',
    });
    const g = await (await as().get(`/messages/groups/${j.synthesis_id}`)).json();
    expect(g).toMatchObject({ status: 'complete', messages: [{ role: 'synthesis', content: 'done' }] });
  });
});
