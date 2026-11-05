import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { loadConfig } from '../../src/config.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { LocalStorage } from '../../src/storage/local.js';
import {
  checkContradictions,
  checkPostFeed,
  checkStalePapers,
  createAlert,
  dedupeHash,
} from '../../src/tasks/alerts.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
let s: Seeded;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  // seedUsers makes complete papers uploaded now with feeds; start each test from a clean slate.
  await sql`DELETE FROM feeds`;
  await sql`DELETE FROM papers`;
});

async function paper(userId: string, corpusId: string | null, opts: { status?: string; daysOld?: number; title?: string | null } = {}) {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, title, filename, file_path, status, uploaded_at)
    VALUES (${id}, ${userId}, ${corpusId}, ${opts.title === undefined ? 'Old Paper' : opts.title}, 'old.pdf', '/x/old.pdf',
            ${opts.status ?? 'complete'}, now() - ${`${opts.daysOld ?? 8} days`}::interval)`;
  return id;
}
const feed = (userId: string, corpusId: string | null) =>
  sql`INSERT INTO feeds (id, user_id, corpus_id, posts, post_count) VALUES (${randomUUID()}, ${userId}, ${corpusId}, '[]'::jsonb, 0)`;
const alerts = () => sql`SELECT * FROM alerts ORDER BY created_at`;

describe('dedupeHash', () => {
  it('matches the Python golden vectors', () => {
    expect(dedupeHash('stale_paper', '33333333-3333-3333-3333-333333333333')).toBe('1a3b13f0d7f786c976c28430304f3fef');
    expect(dedupeHash('contradiction', 'b', 'a')).toBe('25523e845988b9444472da722ce05440');
  });
});

describe('createAlert', () => {
  it('inserts once per dedupe hash and always when the hash is null', async () => {
    const a = { userId: s.user_a, alertType: 't', title: 'T', body: 'B', dedupeHash: 'h' };
    await createAlert(sql, a);
    await createAlert(sql, a);
    await createAlert(sql, { ...a, dedupeHash: null });
    await createAlert(sql, { ...a, dedupeHash: null });
    expect(await alerts()).toHaveLength(3);
  });
});

describe('checkStalePapers', () => {
  it('alerts the owner of a week-old complete paper with no feed, with verbatim text', async () => {
    const id = await paper(s.user_a, s.workspace_a);
    expect(await checkStalePapers(sql)).toEqual({ status: 'complete', stale_count: 1 });
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: s.user_a,
      alert_type: 'stale_paper',
      title: 'Unused paper in your corpus',
      body: `"Old Paper" has been in your corpus for over a week but hasn't been part of any feed generation. Consider generating a feed or removing it.`,
      metadata: { paper_id: id, paper_title: 'Old Paper' },
      dedupe_hash: dedupeHash('stale_paper', id),
    });
  });

  it('falls back to the filename when the title is empty', async () => {
    await paper(s.user_a, s.workspace_a, { title: null });
    await checkStalePapers(sql);
    expect((await alerts())[0]!.metadata).toMatchObject({ paper_title: 'old.pdf' });
  });

  it('is suppressed by a feed of the same user in the same corpus', async () => {
    await paper(s.user_a, s.workspace_a);
    await feed(s.user_a, s.workspace_a);
    expect((await checkStalePapers(sql)).stale_count).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });

  it('is suppressed by an all-papers feed (corpus_id NULL) of the same user', async () => {
    await paper(s.user_a, s.workspace_a);
    await feed(s.user_a, null);
    expect((await checkStalePapers(sql)).stale_count).toBe(0);
  });

  it("is not suppressed by another user's feed", async () => {
    await paper(s.user_a, s.workspace_a);
    await feed(s.user_b, null);
    await feed(s.user_b, s.workspace_a);
    expect((await checkStalePapers(sql)).stale_count).toBe(1);
  });

  it('ignores 6-day-old and non-complete papers', async () => {
    await paper(s.user_a, s.workspace_a, { daysOld: 6 });
    await paper(s.user_a, s.workspace_a, { status: 'pending' });
    expect((await checkStalePapers(sql)).stale_count).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });

  it('creates a single alert when run twice', async () => {
    await paper(s.user_a, s.workspace_a);
    await checkStalePapers(sql);
    expect((await checkStalePapers(sql)).stale_count).toBe(1);
    expect(await alerts()).toHaveLength(1);
  });
});

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });

function harness(providers = fakeProviders()) {
  const logger = pino({ level: 'silent' });
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'x', retryCount: 0, signal: new AbortController().signal },
    sql,
    logger,
    600_000,
  );
  const deps: WorkerDeps = {
    sql,
    config,
    env: {},
    logger,
    storage: new LocalStorage(config, Buffer.from('k'.repeat(32))),
    queue: testQueue(),
    providers: providers.deps,
    rng: () => 0.5,
  };
  return { ctx, deps, providers };
}

async function chunks(paperId: string, userId: string, rows: Array<[string, string]>) {
  for (const [i, [section, content]] of rows.entries()) {
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count)
      VALUES (${paperId}, ${userId}, ${section}, ${content}, ${i}, 5)`;
  }
}

describe('checkContradictions', () => {
  it('writes one alert for the paper whose chunks are classified as contradicting; a rerun adds none', async () => {
    const mine = await paper(s.user_a, s.workspace_a, { title: 'Mine', daysOld: 0 });
    const others = [
      await paper(s.user_a, s.workspace_a, { title: 'Other 1', daysOld: 0 }),
      await paper(s.user_a, s.workspace_a, { title: 'Other 2', daysOld: 0 }),
      await paper(s.user_a, s.workspace_a, { title: 'Other 3', daysOld: 0 }),
    ];
    await chunks(mine, s.user_a, [['results', 'MINE-' + 'x'.repeat(300)]]);
    for (const [i, o] of others.entries()) await chunks(o, s.user_a, [['results', `OTHER${i + 1}-` + 'y'.repeat(300)]]);
    const classify = (user: string) => (user.includes('OTHER2-') ? 'contradicts' : 'supports');
    const mk = () =>
      fakeProviders({
        chat: (_b, info) => (info.purpose === 'classify' ? classify(info.user) : 'x'),
      });
    const h = harness(mk());
    expect(await checkContradictions({ paper_id: mine }, h.ctx, h.deps)).toEqual({ status: 'complete', contradictions: 1 });
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: s.user_a,
      alert_type: 'contradiction',
      title: 'Contradiction detected',
      body: '"Mine" challenges a finding in "Other 2". The papers present conflicting evidence on overlapping topics.',
      dedupe_hash: dedupeHash('contradiction', mine, others[1]!),
    });
    const meta = rows[0]!.metadata as Record<string, string>;
    expect(meta).toMatchObject({
      new_paper_id: mine,
      other_paper_id: others[1],
      new_paper_title: 'Mine',
      other_paper_title: 'Other 2',
    });
    expect(meta.chunk_a_preview).toBe(('MINE-' + 'x'.repeat(300)).slice(0, 200));
    expect(meta.chunk_b_preview).toBe(('OTHER2-' + 'y'.repeat(300)).slice(0, 200));
    const h2 = harness(mk());
    await checkContradictions({ paper_id: mine }, h2.ctx, h2.deps);
    expect(await alerts()).toHaveLength(1);
  });

  it('never samples references, bibliography, acknowledgments or funding chunks', async () => {
    const mine = await paper(s.user_a, s.workspace_a, { daysOld: 0 });
    const other = await paper(s.user_a, s.workspace_a, { daysOld: 0 });
    await chunks(mine, s.user_a, [['introduction', 'KEEPMINE'], ['references', 'DROPREF'], ['funding', 'DROPFUND']]);
    await chunks(other, s.user_a, [['bibliography', 'DROPBIB'], ['acknowledgments', 'DROPACK'], ['results', 'KEEPOTHER']]);
    const h = harness();
    await checkContradictions({ paper_id: mine }, h.ctx, h.deps);
    const sent = h.providers.calls.map((c) => JSON.stringify(c.body)).join('\n');
    expect(sent).toContain('KEEPMINE');
    expect(sent).toContain('KEEPOTHER');
    for (const bad of ['DROPREF', 'DROPFUND', 'DROPBIB', 'DROPACK']) expect(sent).not.toContain(bad);
  });

  it('returns the Python skipped reasons', async () => {
    const h = harness();
    expect(await checkContradictions({ paper_id: randomUUID() }, h.ctx, h.deps)).toEqual({
      status: 'skipped',
      reason: 'paper_not_found',
    });
    const lone = await paper(s.user_a, s.workspace_a, { daysOld: 0 });
    expect(await checkContradictions({ paper_id: lone }, h.ctx, h.deps)).toEqual({
      status: 'skipped',
      reason: 'no_other_papers',
    });
    const nullCorpus = await paper(s.user_a, null, { daysOld: 0 });
    await paper(s.user_a, null, { daysOld: 0 });
    expect(await checkContradictions({ paper_id: nullCorpus }, h.ctx, h.deps)).toEqual({
      status: 'skipped',
      reason: 'no_other_papers',
    });
    const mine = await paper(s.user_a, s.workspace_a, { daysOld: 0 });
    expect(await checkContradictions({ paper_id: mine }, h.ctx, h.deps)).toEqual({
      status: 'skipped',
      reason: 'no_chunks',
    });
    expect(h.providers.calls).toHaveLength(0);
  });

  it('is registered in HANDLERS with the other alert job', () => {
    expect(HANDLERS.check_contradictions).toBeTypeOf('function');
    expect(HANDLERS.check_post_feed).toBeTypeOf('function');
  });
});

describe('checkPostFeed', () => {
  const mkPosts = (types: string[], ref = 'Ref') => types.map((t, i) => ({ id: i + 1, post_type: t, paper_ref: ref }));
  const addFeed = async (userId: string, posts: unknown[]) => {
    const id = randomUUID();
    await sql`INSERT INTO feeds (id, user_id, posts, post_count) VALUES (${id}, ${userId}, ${sql.json(posts as never)}, ${posts.length})`;
    return id;
  };

  it('writes disagreement_spike for 6 debate posts of 10 and not for 5 of 10', async () => {
    const h = harness();
    const six = await addFeed(s.user_a, mkPosts([...Array(4).fill('quote'), ...Array(2).fill('reply'), ...Array(4).fill('post')]));
    expect(await checkPostFeed({ feed_id: six }, h.ctx, h.deps)).toEqual({ status: 'complete' });
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: s.user_a,
      alert_type: 'disagreement_spike',
      title: 'High-debate feed generated',
      body: 'Your latest feed has 6 debate posts out of 10 \u2014 the personas are really arguing. Something in your corpus is provocative.',
      metadata: { feed_id: six, debate_count: 6, total: 10 },
      dedupe_hash: dedupeHash('disagreement_spike', six),
    });
    await sql`DELETE FROM alerts`;
    const five = await addFeed(s.user_a, mkPosts([...Array(5).fill('quote'), ...Array(5).fill('post')]));
    await checkPostFeed({ feed_id: five }, h.ctx, h.deps);
    expect(await alerts()).toHaveLength(0);
  });

  it('writes reading_gap for the owner only, and nothing for a summarized paper', async () => {
    const gap = await paper(s.user_a, s.workspace_a, { title: 'Gap Paper', daysOld: 0 });
    const done = await paper(s.user_a, s.workspace_a, { title: 'Done Paper', daysOld: 0 });
    await paper(s.user_b, s.workspace_b, { title: 'Gap Paper', daysOld: 0 });
    await sql`INSERT INTO paper_summaries (paper_id) VALUES (${done})`;
    const f = await addFeed(s.user_a, [
      { id: 1, post_type: 'post', paper_ref: 'Smith 2020 (Gap Paper)' },
      { id: 2, post_type: 'post', paper_ref: 'Done Paper' },
    ]);
    const h = harness();
    await checkPostFeed({ feed_id: f }, h.ctx, h.deps);
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: s.user_a,
      alert_type: 'reading_gap',
      title: 'Go deeper on this paper',
      body: `Personas are debating "Gap Paper" in your feeds, but you haven't read its summary yet. Tap to explore.`,
      metadata: { paper_id: gap, paper_title: 'Gap Paper' },
      dedupe_hash: dedupeHash('reading_gap', gap),
    });
  });

  it('skips a missing feed and an empty one', async () => {
    const h = harness();
    expect(await checkPostFeed({ feed_id: randomUUID() }, h.ctx, h.deps)).toEqual({ status: 'skipped' });
    const empty = await addFeed(s.user_a, []);
    expect(await checkPostFeed({ feed_id: empty }, h.ctx, h.deps)).toEqual({ status: 'skipped' });
  });
});
