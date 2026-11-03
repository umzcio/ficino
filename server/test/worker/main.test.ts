import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
});

import { startApi, type RunningApi } from '../../src/api/main.js';
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
});
