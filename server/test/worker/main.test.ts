import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
});

import { startApi, type RunningApi } from '../../src/api/main.js';
import type { JobContext } from '../../src/jobs/context.js';
import { createBoss, JobQueue } from '../../src/jobs/queue.js';
import { createSql } from '../../src/db/sql.js';
import { startWorker, type RunningWorker } from '../../src/worker/main.js';
import { createScratchDb } from '../helpers/db.js';

let worker: RunningWorker | undefined;
let api: RunningApi | undefined;
let drop: (() => Promise<void>) | undefined;
let dir: string | undefined;

afterEach(async () => {
  await worker?.close();
  await api?.close();
  await drop?.();
  if (dir) await rm(dir, { recursive: true, force: true });
  worker = api = drop = dir = undefined;
});

async function envFor(url: string) {
  dir = await mkdtemp(join(tmpdir(), 'ficino-worker-'));
  return {
    DATABASE_URL: url,
    AUTH_PROVIDER: 'none',
    ENVIRONMENT: 'development',
    PORT: '0',
    LOG_LEVEL: 'silent',
    UPLOAD_DIR: join(dir, 'uploads'),
    FIGURES_DIR: join(dir, 'figures'),
    MEDIA_DIR: join(dir, 'media'),
  };
}

describe('startWorker', () => {
  it('boots concurrently with the API, migrates once, schedules crons, runs a job and closes idempotently', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    const env = await envFor(scratch.url);
    [worker, api] = await Promise.all([startWorker(env), startApi(env)]);

    const probe = createSql(scratch.url, { max: 2 });
    const boss = createBoss(scratch.url, { max: 2, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    try {
      const versions = await probe`SELECT version, count(*)::int AS n FROM schema_migrations GROUP BY version`;
      expect(versions.length).toBeGreaterThan(0);
      expect(versions.every((r) => r.n === 1)).toBe(true);

      await boss.start();
      const schedules = await boss.getSchedules();
      expect(schedules.map((x) => [x.name, x.cron, x.timezone ?? x.options?.tz]).sort()).toEqual([
        ['check_stale_papers', '0 3 * * *', 'UTC'],
        ['prune_expired', '17 * * * *', 'UTC'],
      ]);

      const queue = new JobQueue(boss, probe);
      const id = await queue.send('check_stale_papers', {});
      await vi.waitFor(
        async () => {
          expect((await queue.getJobState(id)).state).toBe('completed');
        },
        { timeout: 15000, interval: 200 },
      );
      expect((await queue.getJobState(id)).output).toEqual({ status: 'complete', stale_count: 0 });
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
      await probe.end();
    }

    const w = worker;
    await w.close();
    await w.close();
    worker = undefined;
  });

  it('close() waits for a handler still running after the pg-boss stop timeout before ending the pool', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    const env = await envFor(scratch.url);
    const probe = createSql(scratch.url, { max: 1 });
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let stopCalledAt = 0;
    let writeError: unknown = 'not run';
    try {
      worker = await startWorker(env, {
        stopTimeoutMs: 1000,
        handlers: {
          // Ignores the abort signal, like a handler mid-cleanup writing setError after pg-boss gave up on it.
          check_stale_papers: async (_data, _ctx, deps) => {
            started();
            await vi.waitFor(() => expect(stopCalledAt).toBeGreaterThan(0), { timeout: 15000, interval: 20 });
            while (Date.now() - stopCalledAt < 2000) await new Promise((r) => setTimeout(r, 50));
            try {
              await deps.sql`INSERT INTO drain_probe (note) VALUES ('written after stop')`;
              writeError = null;
            } catch (e) {
              writeError = e;
            }
            return { status: 'complete' };
          },
        },
      });
      await probe`CREATE TABLE drain_probe (note text)`;
      const boss = createBoss(scratch.url, { max: 1, supervise: false, schedule: false });
      boss.on('error', () => undefined);
      await boss.start();
      try {
        await new JobQueue(boss, probe).send('check_stale_papers', {});
        await running;
      } finally {
        await boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
      }

      const w = worker;
      stopCalledAt = Date.now();
      await w.close();
      worker = undefined;
      expect(writeError).toBeNull();
      expect(await probe`SELECT note FROM drain_probe`).toEqual([{ note: 'written after stop' }]);
    } finally {
      await probe.end();
    }
  }, 30000);
  it('passes each queue its retry limit (policy or override), so the last retry sees isFinalAttempt', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    const env = await envFor(scratch.url);
    const seen: Array<{ queue: string; retryCount: number; retryLimit: number; final: boolean }> = [];
    const record = (queue: string) => async (_data: unknown, ctx: JobContext) => {
      seen.push({ queue, retryCount: ctx.retryCount, retryLimit: ctx.retryLimit, final: ctx.isFinalAttempt });
      throw new Error('boom');
    };
    worker = await startWorker(env, {
      queueOverrides: { generate_paper_summary: { retryLimit: 1, retryDelay: 0 } },
      handlers: { generate_paper_summary: record('summary'), check_post_feed: record('post_feed') },
    });
    const probe = createSql(scratch.url, { max: 1 });
    const boss = createBoss(scratch.url, { max: 1, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    try {
      await boss.start();
      const queue = new JobQueue(boss, probe);
      await queue.send('generate_paper_summary', { paper_id: 'p' });
      await queue.send('check_post_feed', {});
      await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 20000, interval: 200 });
      expect(seen.filter((x) => x.queue === 'summary')).toEqual([
        { queue: 'summary', retryCount: 0, retryLimit: 1, final: false },
        { queue: 'summary', retryCount: 1, retryLimit: 1, final: true },
      ]);
      expect(seen.filter((x) => x.queue === 'post_feed')).toEqual([
        { queue: 'post_feed', retryCount: 0, retryLimit: 0, final: true },
      ]);
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
      await probe.end();
    }
  }, 30000);
  it("reads the retry limit from the job row, so a per-job limit beats the queue's policy", async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    const env = await envFor(scratch.url);
    const seen: Array<{ retryCount: number; retryLimit: number; final: boolean }> = [];
    worker = await startWorker(env, {
      handlers: {
        generate_corpus_synthesis: async (_data: unknown, ctx: JobContext) => {
          seen.push({ retryCount: ctx.retryCount, retryLimit: ctx.retryLimit, final: ctx.isFinalAttempt });
          throw new Error('boom');
        },
      },
    });
    const boss = createBoss(scratch.url, { max: 1, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    try {
      await boss.start();
      // The queue's policy is retryLimit 2; this job's own row says 0. Sent through pg-boss directly, because
      // JobQueue.send takes no per-job options (and writes a job_progress row this fake handler doesn't need).
      const id = randomUUID();
      expect(await boss.send('generate_corpus_synthesis', {}, { id, retryLimit: 0 })).toBe(id);
      await vi.waitFor(
        async () => expect((await boss.getJobById('generate_corpus_synthesis', id))?.state).toBe('failed'),
        { timeout: 20000, interval: 200 },
      );
      expect(seen).toEqual([{ retryCount: 0, retryLimit: 0, final: true }]);
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    }
  }, 30000);
});
