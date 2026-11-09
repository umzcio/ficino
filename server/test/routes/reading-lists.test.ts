import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { testBoss } from '../helpers/queue.js';

// Ports api/tests/test_reading_lists.py, the reading-list tests of test_idor_followups.py and the
// reorder/apply-ordering tests of test_wave3_correctness.py, plus the plan 05 Task 2 route contract.

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const as = (id = USER_A_ID, config: Record<string, unknown> = {}) => client(testApp({ user: user(id), config }));
const base = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' });

type PaperOpts = { title?: string | null; filename?: string; status?: string; uploadedAt?: string; authors?: string[] | null; year?: number | null };

async function newPaper(userId: string, corpusId: string | null, o: PaperOpts = {}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, title, authors, year, filename, file_path, status, uploaded_at)
    VALUES (${id}, ${userId}, ${corpusId}, ${o.title ?? null}, ${o.authors ?? null}, ${o.year ?? null},
            ${o.filename ?? 'x.pdf'}, '/tmp/x.pdf', ${o.status ?? 'complete'}, ${o.uploadedAt ?? new Date().toISOString()})`;
  return id;
}

type ListOpts = { name?: string; rationale?: unknown[]; createdAt?: string; statuses?: string[]; feeds?: (string | null)[] };

/** A list plus one chapter per paper (first unlocked, rest locked unless `statuses` says otherwise). */
async function seedList(userId: string, corpusId: string | null, paperIds: string[], o: ListOpts = {}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO reading_lists (id, user_id, corpus_id, name, paper_sequence, rationale, created_at)
    VALUES (${id}, ${userId}, ${corpusId}, ${o.name ?? 'L'}, ${paperIds}::uuid[],
            ${sql.json((o.rationale ?? []) as never)}, ${o.createdAt ?? new Date().toISOString()})`;
  for (const [i, pid] of paperIds.entries()) {
    const status = o.statuses?.[i] ?? (i === 0 ? 'unlocked' : 'locked');
    await sql`
      INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, feed_id, status)
      VALUES (${id}, ${i}, ${[pid]}::uuid[], ${o.feeds?.[i] ?? null}, ${status})`;
  }
  return id;
}

const chapterRows = async (listId: string) =>
  [...(await sql`SELECT chapter_index, paper_ids, feed_id, status FROM reading_list_chapters
                  WHERE reading_list_id = ${listId} ORDER BY chapter_index`)];

const listRow = async (listId: string) =>
  (await sql`SELECT corpus_id, name, paper_sequence, rationale FROM reading_lists WHERE id = ${listId}`)[0];

async function newFeed(userId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO feeds (id, user_id, posts, post_count) VALUES (${id}, ${userId}, '[]'::jsonb, 0)`;
  return id;
}

describe('GET /reading-lists', () => {
  it("lists only the caller's lists, newest first, with int counts and Z timestamps", async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const older = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2], {
      name: 'old',
      createdAt: '2026-01-01T00:00:00.123456+00:00',
      statuses: ['complete', 'unlocked'],
    });
    const newer = await seedList(USER_A_ID, null, [seeded.paper_a, p2], { name: 'new', createdAt: '2026-02-01T00:00:00+00:00' });
    await seedList(USER_B_ID, seeded.workspace_b, [seeded.paper_b], { name: 'b' });
    const r = await as().get('/reading-lists');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([
      { id: newer, name: 'new', paper_count: 2, chapter_count: 2, completed_chapters: 0, rationale: [], created_at: '2026-02-01T00:00:00Z' },
      {
        id: older,
        name: 'old',
        paper_count: 2,
        chapter_count: 2,
        completed_chapters: 1,
        rationale: [],
        created_at: '2026-01-01T00:00:00.123456Z',
      },
    ]);
  });

  it('a list without chapters counts 0', async () => {
    const id = randomUUID();
    await sql`INSERT INTO reading_lists (id, user_id, name) VALUES (${id}, ${USER_A_ID}, 'empty')`;
    const [item] = await (await as().get('/reading-lists')).json();
    expect(item).toMatchObject({ id, paper_count: 0, chapter_count: 0, completed_chapters: 0 });
  });

  it('filters by workspace_id; an empty filter lists all; a non-uuid filter is []', async () => {
    const ws2 = randomUUID();
    await sql`INSERT INTO corpora (id, user_id, name) VALUES (${ws2}, ${USER_A_ID}, 'A2')`;
    const inA = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a]);
    const inA2 = await seedList(USER_A_ID, ws2, [seeded.paper_a]);
    const c = as();
    expect((await (await c.get(`/reading-lists?workspace_id=${seeded.workspace_a}`)).json()).map((x: any) => x.id)).toEqual([inA]);
    expect((await (await c.get(`/reading-lists?workspace_id=${ws2}`)).json()).map((x: any) => x.id)).toEqual([inA2]);
    expect((await (await c.get('/reading-lists?workspace_id=')).json()).length).toBe(2);
    const bad = await c.get('/reading-lists?workspace_id=nope');
    expect([bad.status, await bad.json()]).toEqual([200, []]);
  });

  it('returns the stored rationale array as-is', async () => {
    const rationale = [{ paper_id: seeded.paper_a, rationale: 'first' }];
    await seedList(USER_A_ID, null, [seeded.paper_a], { rationale });
    expect((await (await as().get('/reading-lists')).json())[0].rationale).toEqual(rationale);
  });
});

describe('GET /reading-lists/:list_id', () => {
  it("is 404 for another user's list and for a non-uuid id", async () => {
    const listB = await seedList(USER_B_ID, seeded.workspace_b, [seeded.paper_b]);
    for (const id of [listB, 'nope', randomUUID()]) {
      const r = await as().get(`/reading-lists/${id}`);
      expect([r.status, await r.json()]).toEqual([404, { detail: 'Reading list not found' }]);
    }
  });

  it('papers in sequence order, foreign and deleted ids dropped, title falls back to filename', async () => {
    const t1 = await newPaper(USER_A_ID, seeded.workspace_a, { title: 'Titled', authors: ['X', 'Y'], year: 2020 });
    const tEmpty = await newPaper(USER_A_ID, seeded.workspace_a, { title: '', filename: 'empty.pdf' });
    const gone = randomUUID();
    const id = await seedList(USER_A_ID, seeded.workspace_a, [t1, seeded.paper_b, gone, tEmpty, seeded.paper_a], {
      createdAt: '2026-03-04T05:06:07.5+00:00',
    });
    const r = await as().get(`/reading-lists/${id}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.papers).toEqual([
      { id: t1, title: 'Titled', authors: ['X', 'Y'], year: 2020, rationale: '' },
      { id: tEmpty, title: 'empty.pdf', authors: [], year: null, rationale: '' },
      { id: seeded.paper_a, title: 'a.pdf', authors: [], year: null, rationale: '' },
    ]);
    expect(j).toMatchObject({ id, name: 'L', corpus_id: seeded.workspace_a, created_at: '2026-03-04T05:06:07.500000Z' });
    expect(Object.keys(j).sort()).toEqual(['chapters', 'corpus_id', 'created_at', 'id', 'name', 'papers']);
  });

  it('rationale: missing entry, missing key and a stored null are "", the first match wins', async () => {
    const [p1, p2, p3] = [
      await newPaper(USER_A_ID, null),
      await newPaper(USER_A_ID, null),
      await newPaper(USER_A_ID, null),
    ];
    const id = await seedList(USER_A_ID, null, [seeded.paper_a, p1, p2, p3], {
      rationale: [
        { paper_id: p1 },
        { paper_id: p2, rationale: null },
        { paper_id: p3, rationale: 'first' },
        { paper_id: p3, rationale: 'second' },
      ],
    });
    const j = await (await as().get(`/reading-lists/${id}`)).json();
    // Deliberate change 28: Python returned a stored null as null.
    expect(j.papers.map((p: any) => p.rationale)).toEqual(['', '', '', 'first']);
  });

  it('deliberate change 28: a stored non-text rationale is returned as text (a number) or ""', async () => {
    const [p1, p2, p3, p4] = [
      await newPaper(USER_A_ID, null),
      await newPaper(USER_A_ID, null),
      await newPaper(USER_A_ID, null),
      await newPaper(USER_A_ID, null),
    ];
    const id = await seedList(USER_A_ID, null, [p1, p2, p3, p4], {
      rationale: [
        { paper_id: p1, rationale: { a: 1 } },
        { paper_id: p2, rationale: [{}] },
        { paper_id: p3, rationale: 7 },
        { paper_id: p4, rationale: true },
      ],
    });
    const j = await (await as().get(`/reading-lists/${id}`)).json();
    expect(j.papers.map((p: any) => p.rationale)).toEqual(['', '', '7', '']);
  });

  it('chapters ordered by index without created_at; a NULL corpus is null', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    const feed = await newFeed(USER_A_ID);
    const id = await seedList(USER_A_ID, null, [seeded.paper_a, p2], { statuses: ['complete', 'unlocked'], feeds: [feed, null] });
    const j = await (await as().get(`/reading-lists/${id}`)).json();
    expect(j.corpus_id).toBeNull();
    expect(j.chapters).toEqual([
      { id: expect.any(String), chapter_index: 0, paper_ids: [seeded.paper_a], feed_id: feed, status: 'complete' },
      { id: expect.any(String), chapter_index: 1, paper_ids: [p2], feed_id: null, status: 'unlocked' },
    ]);
  });
});

describe('POST /reading-lists', () => {
  it('from paper_ids: 201, chapters 0 unlocked and 1 locked, propose_ordering dispatched', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a, { status: 'processing' });
    const r = await as().post('/reading-lists', { name: 'My list', paper_ids: [seeded.paper_a, p2] });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toEqual({ id: expect.any(String), task_id: expect.any(String), paper_count: 2 });
    expect(await listRow(j.id)).toEqual({ corpus_id: null, name: 'My list', paper_sequence: [seeded.paper_a, p2], rationale: [] });
    expect((await chapterRows(j.id)).map((c) => [c.chapter_index, c.paper_ids, c.status])).toEqual([
      [0, [seeded.paper_a], 'unlocked'],
      [1, [p2], 'locked'],
    ]);
    const [progress] = await sql`SELECT queue FROM job_progress WHERE job_id = ${j.task_id}`;
    expect(progress!.queue).toBe('propose_ordering');
    const b = await testBoss();
    expect((await b.getJobById('propose_ordering', j.task_id))!.data).toEqual({
      paper_ids: [seeded.paper_a, p2],
      list_id: j.id,
      user_id: USER_A_ID,
    });
  });

  it('from corpus_id: only complete papers, in upload order', async () => {
    const late = await newPaper(USER_A_ID, seeded.workspace_a, { uploadedAt: '2030-01-01T00:00:00Z' });
    const early = await newPaper(USER_A_ID, seeded.workspace_a, { uploadedAt: '2000-01-01T00:00:00Z' });
    await newPaper(USER_A_ID, seeded.workspace_a, { status: 'processing', uploadedAt: '2001-01-01T00:00:00Z' });
    const r = await as().post('/reading-lists', { name: 'ws', corpus_id: seeded.workspace_a });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.paper_count).toBe(3);
    const row = await listRow(j.id);
    expect(row!.corpus_id).toBe(seeded.workspace_a);
    // seeded.paper_a was uploaded "now", between 2000 and 2030.
    expect(row!.paper_sequence).toEqual([early, seeded.paper_a, late]);
  });

  it('paper_ids: [] with a corpus_id uses the corpus', async () => {
    await newPaper(USER_A_ID, seeded.workspace_a);
    const r = await as().post('/reading-lists', { name: 'ws', corpus_id: seeded.workspace_a, paper_ids: [] });
    expect([r.status, (await r.json()).paper_count]).toEqual([201, 2]);
  });

  it('corpus_id "" with two paper_ids stores a NULL corpus', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    const r = await as().post('/reading-lists', { name: 'n', corpus_id: '', paper_ids: [seeded.paper_a, p2] });
    expect(r.status).toBe(201);
    expect((await listRow((await r.json()).id))!.corpus_id).toBeNull();
  });

  it("another user's paper id is 404 One or more papers not found and creates nothing", async () => {
    const r = await as().post('/reading-lists', { name: 'x', paper_ids: [seeded.paper_a, seeded.paper_b] });
    expect([r.status, await r.json()]).toEqual([404, { detail: 'One or more papers not found' }]);
    expect((await sql`SELECT count(*)::int AS n FROM reading_lists`)[0]!.n).toBe(0);
  });

  it("another user's corpus is 404 Workspace not found; so is a non-uuid corpus", async () => {
    for (const corpus_id of [seeded.workspace_b, 'nope']) {
      const r = await as().post('/reading-lists', { name: 'x', corpus_id });
      expect([r.status, await r.json()]).toEqual([404, { detail: 'Workspace not found' }]);
    }
    expect((await sql`SELECT count(*)::int AS n FROM reading_lists`)[0]!.n).toBe(0);
  });

  it('a duplicate id and a non-uuid id are 404', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    for (const paper_ids of [[seeded.paper_a, seeded.paper_a, p2], [seeded.paper_a, 'nope']]) {
      const r = await as().post('/reading-lists', { name: 'x', paper_ids });
      expect([r.status, (await r.json()).detail]).toEqual([404, 'One or more papers not found']);
    }
  });

  it('neither field is 400; one paper is 400', async () => {
    let r = await as().post('/reading-lists', { name: 'x' });
    expect([r.status, (await r.json()).detail]).toEqual([400, 'Provide paper_ids or corpus_id']);
    r = await as().post('/reading-lists', { name: 'x', paper_ids: [] });
    expect([r.status, (await r.json()).detail]).toEqual([400, 'Provide paper_ids or corpus_id']);
    r = await as().post('/reading-lists', { name: 'x', paper_ids: [seeded.paper_a] });
    expect([r.status, (await r.json()).detail]).toEqual([400, 'Need at least 2 papers for a reading list']);
    r = await as().post('/reading-lists', { name: 'x', corpus_id: seeded.workspace_a });
    expect([r.status, (await r.json()).detail]).toEqual([400, 'Need at least 2 papers for a reading list']);
  });

  it('a missing name is 422', async () => {
    const r = await as().post('/reading-lists', { paper_ids: [seeded.paper_a] });
    expect(r.status).toBe(422);
    expect((await r.json()).detail[0].loc).toEqual(['body', 'name']);
  });
});

describe('PUT /reading-lists/:list_id/reorder', () => {
  it('updates paper_sequence', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2]);
    const r = await as().put(`/reading-lists/${id}/reorder`, { paper_sequence: [p2, seeded.paper_a] });
    expect([r.status, await r.json()]).toEqual([200, { status: 'reordered' }]);
    expect((await listRow(id))!.paper_sequence).toEqual([p2, seeded.paper_a]);
    expect((await chapterRows(id)).map((c) => [c.chapter_index, c.paper_ids, c.status])).toEqual([
      [0, [p2], 'unlocked'],
      [1, [seeded.paper_a], 'locked'],
    ]);
  });

  it('a duplicate is 422 with a plain detail string', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2]);
    const r = await as().put(`/reading-lists/${id}/reorder`, { paper_sequence: [seeded.paper_a, seeded.paper_a, p2] });
    expect([r.status, await r.json()]).toEqual([422, { detail: 'Duplicate paper IDs in sequence' }]);
  });

  it("another user's paper and a non-uuid id are 404 One or more papers not found", async () => {
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a]);
    for (const seq of [[seeded.paper_a, seeded.paper_b], [seeded.paper_a, 'nope']]) {
      const r = await as().put(`/reading-lists/${id}/reorder`, { paper_sequence: seq });
      expect([r.status, await r.json()]).toEqual([404, { detail: 'One or more papers not found' }]);
    }
    expect((await listRow(id))!.paper_sequence).toEqual([seeded.paper_a]);
  });

  it("another user's list is 404 Reading list not found", async () => {
    const listB = await seedList(USER_B_ID, seeded.workspace_b, [seeded.paper_b]);
    for (const id of [listB, 'nope']) {
      const r = await as().put(`/reading-lists/${id}/reorder`, { paper_sequence: [seeded.paper_a] });
      expect([r.status, await r.json()]).toEqual([404, { detail: 'Reading list not found' }]);
    }
    expect((await listRow(listB))!.paper_sequence).toEqual([seeded.paper_b]);
  });

  it('keeps completed chapters and rebuilds the rest after them', async () => {
    const [p1, p2, p3] = [await newPaper(USER_A_ID, null), await newPaper(USER_A_ID, null), await newPaper(USER_A_ID, null)];
    const [f0, f1] = [await newFeed(USER_A_ID), await newFeed(USER_A_ID)];
    const id = await seedList(USER_A_ID, null, [seeded.paper_a, p1, p2], {
      statuses: ['complete', 'complete', 'locked'],
      feeds: [f0, f1, null],
      rationale: [{ paper_id: p2, rationale: 'kept' }],
    });
    const r = await as().put(`/reading-lists/${id}/reorder`, { paper_sequence: [seeded.paper_a, p1, p3, p2] });
    expect(r.status).toBe(200);
    expect((await chapterRows(id)).map((c) => [c.chapter_index, c.paper_ids, c.feed_id, c.status])).toEqual([
      [0, [seeded.paper_a], f0, 'complete'],
      [1, [p1], f1, 'complete'],
      [2, [p3], null, 'unlocked'],
      [3, [p2], null, 'locked'],
    ]);
    expect((await listRow(id))!.rationale).toEqual([{ paper_id: p2, rationale: 'kept' }]);
  });

  it('an empty sequence deletes every chapter without a feed', async () => {
    const [p1, p2] = [await newPaper(USER_A_ID, null), await newPaper(USER_A_ID, null)];
    const f0 = await newFeed(USER_A_ID);
    const id = await seedList(USER_A_ID, null, [seeded.paper_a, p1, p2], {
      statuses: ['complete', 'unlocked', 'locked'],
      feeds: [f0, null, null],
    });
    const r = await as().put(`/reading-lists/${id}/reorder`, { paper_sequence: [] });
    expect([r.status, await r.json()]).toEqual([200, { status: 'reordered' }]);
    expect((await listRow(id))!.paper_sequence).toEqual([]);
    expect((await chapterRows(id)).map((c) => [c.chapter_index, c.feed_id])).toEqual([[0, f0]]);
  });
});

describe('PUT /reading-lists/:list_id/apply-ordering', () => {
  it('applies a valid permutation: rationale keeps paper_id only, every chapter rebuilt', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const f0 = await newFeed(USER_A_ID);
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2], {
      statuses: ['complete', 'unlocked'],
      feeds: [f0, null],
    });
    const r = await as().put(`/reading-lists/${id}/apply-ordering`, {
      ordered_papers: [
        { paper_id: p2, rationale: 'client text' },
        { paper_id: seeded.paper_a, rationale: 'more' },
      ],
    });
    expect([r.status, await r.json()]).toEqual([200, { status: 'applied' }]);
    const row = await listRow(id);
    expect(row!.paper_sequence).toEqual([p2, seeded.paper_a]);
    expect(row!.rationale).toEqual([{ paper_id: p2 }, { paper_id: seeded.paper_a }]);
    expect((await chapterRows(id)).map((c) => [c.chapter_index, c.paper_ids, c.feed_id, c.status])).toEqual([
      [0, [p2], null, 'unlocked'],
      [1, [seeded.paper_a], null, 'locked'],
    ]);
  });

  it('a foreign paper id is 400 and nothing changes', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2]);
    const r = await as().put(`/reading-lists/${id}/apply-ordering`, {
      ordered_papers: [{ paper_id: seeded.paper_a }, { paper_id: seeded.paper_b }],
    });
    expect([r.status, await r.json()]).toEqual([400, { detail: 'Ordering must be a permutation of the existing paper list' }]);
    expect((await listRow(id))!.paper_sequence).toEqual([seeded.paper_a, p2]);
  });

  it('an uppercase id is not a match (string compare against stored ids)', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2]);
    const r = await as().put(`/reading-lists/${id}/apply-ordering`, {
      ordered_papers: [{ paper_id: seeded.paper_a.toUpperCase() }, { paper_id: p2 }],
    });
    expect(r.status).toBe(400);
  });

  it('a subset is 400', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2]);
    const r = await as().put(`/reading-lists/${id}/apply-ordering`, { ordered_papers: [{ paper_id: p2 }] });
    expect(r.status).toBe(400);
  });

  it('a duplicate is 422 Duplicate paper IDs in ordering', async () => {
    const p2 = await newPaper(USER_A_ID, seeded.workspace_a);
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a, p2]);
    const r = await as().put(`/reading-lists/${id}/apply-ordering`, {
      ordered_papers: [{ paper_id: seeded.paper_a }, { paper_id: seeded.paper_a }, { paper_id: p2 }],
    });
    expect([r.status, await r.json()]).toEqual([422, { detail: 'Duplicate paper IDs in ordering' }]);
  });

  it('a malformed body is a 422 validation error, not a 500', async () => {
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a]);
    let r = await as().put(`/reading-lists/${id}/apply-ordering`, { ordered_papers: [{}] });
    expect(r.status).toBe(422);
    const [issue] = (await r.json()).detail;
    expect(issue).toMatchObject({ loc: ['body', 'ordered_papers', 0, 'paper_id'], type: expect.any(String), msg: expect.any(String) });
    r = await as().put(`/reading-lists/${id}/apply-ordering`, { ordered_papers: ['x'] });
    expect(r.status).toBe(422);
    expect((await r.json()).detail[0].loc).toEqual(['body', 'ordered_papers', 0]);
  });

  it('an empty list is 400 No ordering data', async () => {
    const id = await seedList(USER_A_ID, seeded.workspace_a, [seeded.paper_a]);
    const r = await as().put(`/reading-lists/${id}/apply-ordering`, { ordered_papers: [] });
    expect([r.status, await r.json()]).toEqual([400, { detail: 'No ordering data' }]);
  });

  it("another user's list is 404 Reading list not found", async () => {
    const listB = await seedList(USER_B_ID, seeded.workspace_b, [seeded.paper_b]);
    const r = await as().put(`/reading-lists/${listB}/apply-ordering`, { ordered_papers: [{ paper_id: seeded.paper_b }] });
    expect([r.status, await r.json()]).toEqual([404, { detail: 'Reading list not found' }]);
  });
});

describe('POST /reading-lists/:list_id/chapters/:chapter_index/generate', () => {
  it('an unlocked chapter is 202 queued and dispatches generate_chapter', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    const id = await seedList(USER_A_ID, null, [seeded.paper_a, p2]);
    const r = await as().post(`/reading-lists/${id}/chapters/0/generate`);
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j).toEqual({ task_id: expect.any(String), status: 'queued' });
    const b = await testBoss();
    expect((await b.getJobById('generate_chapter', j.task_id))!.data).toEqual({
      reading_list_id: id,
      chapter_index: 0,
      user_id: USER_A_ID,
    });
  });

  it('a complete chapter dispatches too', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    const id = await seedList(USER_A_ID, null, [seeded.paper_a, p2], { statuses: ['complete', 'unlocked'] });
    expect((await as().post(`/reading-lists/${id}/chapters/0/generate`)).status).toBe(202);
  });

  it('a locked chapter is 400', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    const id = await seedList(USER_A_ID, null, [seeded.paper_a, p2]);
    const r = await as().post(`/reading-lists/${id}/chapters/1/generate`);
    expect([r.status, await r.json()]).toEqual([400, { detail: 'Chapter is locked. Complete prior chapters first.' }]);
  });

  it("a missing index, another user's list and a non-uuid list are 404 Chapter not found", async () => {
    const id = await seedList(USER_A_ID, null, [seeded.paper_a]);
    const listB = await seedList(USER_B_ID, null, [seeded.paper_b]);
    for (const path of [`${id}/chapters/9`, `${listB}/chapters/0`, 'nope/chapters/0', `${id}/chapters/99999999999`]) {
      const r = await as().post(`/reading-lists/${path}/generate`);
      expect([r.status, await r.json()]).toEqual([404, { detail: 'Chapter not found' }]);
    }
    expect((await sql`SELECT count(*)::int AS n FROM job_progress`)[0]!.n).toBe(0);
  });

  it('a non-int index is 422', async () => {
    const id = await seedList(USER_A_ID, null, [seeded.paper_a]);
    const r = await as().post(`/reading-lists/${id}/chapters/x/generate`);
    expect(r.status).toBe(422);
    expect((await r.json()).detail[0].loc).toEqual(['path', 'chapter_index']);
  });
});

describe('DELETE /reading-lists/:list_id', () => {
  it('204, an audit row, chapters gone, the chapter feed kept', async () => {
    const feed = await newFeed(USER_A_ID);
    const id = await seedList(USER_A_ID, null, [seeded.paper_a], { statuses: ['complete'], feeds: [feed] });
    const r = await as().delete(`/reading-lists/${id}`);
    expect(r.status).toBe(204);
    expect(await listRow(id)).toBeUndefined();
    expect(await chapterRows(id)).toEqual([]);
    expect((await sql`SELECT id FROM feeds WHERE id = ${feed}`).length).toBe(1);
    const [a] = await sql`SELECT user_id, resource_type, resource_id, status_code FROM audit_log WHERE action = 'reading_list.delete'`;
    expect(a).toEqual({ user_id: USER_A_ID, resource_type: 'reading_list', resource_id: id, status_code: 204 });
  });

  it("another user's list and a non-uuid id are 404 and nothing is deleted", async () => {
    const listB = await seedList(USER_B_ID, null, [seeded.paper_b]);
    for (const id of [listB, 'nope']) {
      const r = await as().delete(`/reading-lists/${id}`);
      expect([r.status, await r.json()]).toEqual([404, { detail: 'Reading list not found' }]);
    }
    expect(await listRow(listB)).toBeDefined();
    expect((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n).toBe(0);
  });
});

describe('feed_generation rate limit', () => {
  const limited = () => as(USER_A_ID, { authProvider: 'basic', rateLimits: { ...base.rateLimits, feed_generation: 1 } });

  it('create and chapter generate share the bucket', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    const c = limited();
    const created = await c.post('/reading-lists', { name: 'x', paper_ids: [seeded.paper_a, p2] });
    expect(created.status).toBe(201);
    const r = await c.post(`/reading-lists/${(await created.json()).id}/chapters/0/generate`);
    expect(r.status).toBe(429);
    expect((await r.json()).detail).toBe('Rate limit exceeded: 1 feed_generation per 24h. Try again later.');
  });

  it('an invalid create body still uses the slot', async () => {
    const p2 = await newPaper(USER_A_ID, null);
    const c = limited();
    expect((await c.post('/reading-lists', { paper_ids: 'nope' })).status).toBe(422);
    expect((await c.post('/reading-lists', { name: 'x', paper_ids: [seeded.paper_a, p2] })).status).toBe(429);
    expect((await sql`SELECT count(*)::int AS n FROM reading_lists`)[0]!.n).toBe(0);
  });

  it('a non-int chapter index still uses the slot', async () => {
    const c = limited();
    expect((await c.post(`/reading-lists/${randomUUID()}/chapters/x/generate`)).status).toBe(422);
    expect((await c.post(`/reading-lists/${randomUUID()}/chapters/0/generate`)).status).toBe(429);
  });
});
