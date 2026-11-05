import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeJobContext } from '../../src/jobs/context.js';
import { ensureQueues } from '../../src/jobs/queue.js';
import { QUEUES } from '../../src/jobs/registry.js';
import { resetDb, testSql } from '../helpers/db.js';
import { TEST_JOB_TIME_LIMIT_SEC, testBoss, testQueue } from '../helpers/queue.js';

const sql = testSql();
const queue = testQueue();
const logger = pino({ level: 'silent' });
const workers: Array<{ name: string; id: string }> = [];

beforeEach(() => resetDb(sql));
afterEach(async () => {
  const boss = await testBoss();
  for (const w of workers.splice(0)) await boss.offWork(w.name, { id: w.id, wait: true });
});

async function work(
  name: Parameters<typeof queue.send>[0],
  handler: (ctx: ReturnType<typeof makeJobContext>) => Promise<unknown>,
) {
  const boss = await testBoss();
  const id = await boss.work(name, { pollingIntervalSeconds: 0.5 }, async ([job]) =>
    handler(makeJobContext(job!, sql, logger, 60_000, 0)),
  );
  workers.push({ name, id });
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

it('send returns a uuid and the job is created', async () => {
  const id = await queue.send('check_stale_papers', {});
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const s = await queue.getJobState(id);
  expect(s.state).toBe('created');
  expect(s.queue).toBe('check_stale_papers');
  expect(s.progress).toBeNull();
});

it('completed job exposes its output', async () => {
  await work('prune_expired', async () => ({ ok: 1 }));
  const id = await queue.send('prune_expired', {});
  const s = await until(() => queue.getJobState(id), (v) => v.state === 'completed');
  expect(s.state).toBe('completed');
  expect(s.output).toEqual({ ok: 1 });
});

it('an active job reports progress', async () => {
  let release!: () => void;
  const latch = new Promise<void>((r) => (release = r));
  await work('compute_preferences', async (ctx) => {
    await ctx.progress({ step: 'x' });
    await latch;
  });
  const id = await queue.send('compute_preferences', {});
  const s = await until(() => queue.getJobState(id), (v) => v.state === 'active' && v.progress !== null);
  expect(s.state).toBe('active');
  expect(s.progress).toEqual({ step: 'x' });
  release();
  await until(() => queue.getJobState(id), (v) => v.state === 'completed');
});

it('a throwing handler fails the job with the error message in output', async () => {
  await work('check_post_feed', async () => {
    throw new Error('boom');
  });
  const id = await queue.send('check_post_feed', {});
  const s = await until(() => queue.getJobState(id), (v) => v.state === 'failed');
  expect(s.state).toBe('failed');
  expect((s.output as { message: string }).message).toBe('boom');
});

it('retries keep the job id', async () => {
  const boss = await testBoss();
  await ensureQueues(boss, TEST_JOB_TIME_LIMIT_SEC, { check_contradictions: { retryLimit: 1, retryDelay: 0 } });
  try {
    await work('check_contradictions', async (ctx) => {
      if (ctx.retryCount === 0) throw new Error('first attempt');
      return ctx.retryCount;
    });
    const id = await queue.send('check_contradictions', {});
    const s = await until(() => queue.getJobState(id), (v) => v.state === 'completed');
    expect(s.state).toBe('completed');
    expect(s.output).toBe(1);
  } finally {
    for (const w of workers.splice(0)) await boss.offWork(w.name, { id: w.id, wait: true });
    await ensureQueues(boss, TEST_JOB_TIME_LIMIT_SEC);
  }
});

it('unknown ids are missing', async () => {
  expect((await queue.getJobState('nope')).state).toBe('missing');
  expect((await queue.getJobState(randomUUID())).state).toBe('missing');
});

it('ensureQueues is idempotent and applies the registry policy', async () => {
  const boss = await testBoss();
  await ensureQueues(boss, TEST_JOB_TIME_LIMIT_SEC);
  await ensureQueues(boss, TEST_JOB_TIME_LIMIT_SEC);
  const q = await boss.getQueue('respond_to_user_post');
  expect(q?.retryLimit).toBe(QUEUES.respond_to_user_post.retryLimit);
  expect(q?.retryDelay).toBe(180);
  expect(q?.expireInSeconds).toBe(TEST_JOB_TIME_LIMIT_SEC);
});

it('resetDb clears jobs but keeps the queues', async () => {
  const id = await queue.send('check_stale_papers', {});
  await resetDb(sql);
  expect((await queue.getJobState(id)).state).toBe('missing');
  const boss = await testBoss();
  expect(await boss.getQueue('check_stale_papers')).not.toBeNull();
});
