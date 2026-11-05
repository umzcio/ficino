import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { beforeEach, expect, it } from 'vitest';
import { makeJobContext } from '../../src/jobs/context.js';
import { resetDb, testSql } from '../helpers/db.js';

beforeEach(() => resetDb(testSql()));

it('signal aborts with a TimeoutError after the soft limit', async () => {
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'process_paper', retryCount: 0, signal: new AbortController().signal },
    testSql(),
    pino({ level: 'silent' }),
    50,
    2,
  );
  expect(ctx.signal.aborted).toBe(false);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('did not abort within 500ms')), 500);
    ctx.signal.addEventListener('abort', () => (clearTimeout(t), resolve()));
  });
  expect((ctx.signal.reason as Error).name).toBe('TimeoutError');
});

it('signal follows the pg-boss job signal', () => {
  const ac = new AbortController();
  const ctx = makeJobContext({ id: randomUUID(), name: 'process_paper', retryCount: 1, signal: ac.signal }, testSql(), pino({ level: 'silent' }), 60_000, 2);
  expect(ctx.retryCount).toBe(1);
  ac.abort(new Error('stop'));
  expect(ctx.signal.aborted).toBe(true);
});

it('progress upserts meta and bumps updated_at', async () => {
  const sql = testSql();
  const id = randomUUID();
  await sql`INSERT INTO job_progress (job_id, queue) VALUES (${id}, 'process_paper')`;
  const ctx = makeJobContext({ id, name: 'process_paper', retryCount: 0, signal: new AbortController().signal }, sql, pino({ level: 'silent' }), 60_000, 2);
  await ctx.progress({ step: 'a', paper_id: 'p' });
  await ctx.progress({ step: 'b', paper_id: 'p' });
  const [r] = await sql`SELECT meta, updated_at > created_at AS bumped FROM job_progress WHERE job_id = ${id}`;
  expect(r!.meta).toEqual({ step: 'b', paper_id: 'p' });
  expect(r!.bumped).toBe(true);
});

it('progress creates the row when none exists, with the job queue name', async () => {
  const sql = testSql();
  const id = randomUUID();
  const ctx = makeJobContext({ id, name: 'prune_expired', retryCount: 0, signal: new AbortController().signal }, sql, pino({ level: 'silent' }), 60_000, 2);
  await ctx.progress({ step: 'z' });
  const [r] = await sql`SELECT queue, meta FROM job_progress WHERE job_id = ${id}`;
  expect(r).toEqual({ queue: 'prune_expired', meta: { step: 'z' } });
});

it('isFinalAttempt: retry 0 of a limit of 2 is not final, retry 2 is', () => {
  const at = (retryCount: number) =>
    makeJobContext(
      { id: randomUUID(), name: 'generate_paper_summary', retryCount, signal: new AbortController().signal },
      testSql(),
      pino({ level: 'silent' }),
      60_000,
      2,
    );
  expect(at(0).isFinalAttempt).toBe(false);
  expect(at(1).isFinalAttempt).toBe(false);
  expect(at(2).isFinalAttempt).toBe(true);
  expect(at(0).retryLimit).toBe(2);
});

it('isFinalAttempt: a queue without retries is final on its first run', () => {
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'regenerate_post', retryCount: 0, signal: new AbortController().signal },
    testSql(),
    pino({ level: 'silent' }),
    60_000,
    0,
  );
  expect(ctx.isFinalAttempt).toBe(true);
});
