import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkStalePapers, createAlert, dedupeHash } from '../../src/tasks/alerts.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';

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
