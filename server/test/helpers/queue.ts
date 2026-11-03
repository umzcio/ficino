import type { PgBoss } from 'pg-boss';
import { createBoss, ensureQueues, JobQueue, type BossLike } from '../../src/jobs/queue.js';
import { testSql } from './db.js';

export const TEST_JOB_TIME_LIMIT_SEC = 600;

let boss: PgBoss | undefined;
let started: Promise<PgBoss> | undefined;

/** One pg-boss per process, started on first call (never started by files that don't use the queue). */
export function testBoss(): Promise<PgBoss> {
  started ??= (async () => {
    boss = createBoss(process.env.DATABASE_URL!, { max: 3, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    await boss.start();
    await ensureQueues(boss, TEST_JOB_TIME_LIMIT_SEC);
    return boss;
  })();
  return started;
}

export async function stopTestBoss(): Promise<void> {
  if (!started) return;
  const p = started;
  started = undefined;
  boss = undefined;
  const b = await p.catch(() => undefined);
  await b?.stop({ graceful: true, timeout: 5000 });
}

/** A JobQueue over the lazily started test boss; the start is awaited on first use. */
export function testQueue(): JobQueue {
  const lazy: BossLike = {
    send: (async (...args: unknown[]) => (await testBoss()).send(...(args as [string]))) as BossLike['send'],
    getJobById: (async (...args: unknown[]) =>
      (await testBoss()).getJobById(...(args as [string, string]))) as BossLike['getJobById'],
  };
  return new JobQueue(lazy, testSql());
}
