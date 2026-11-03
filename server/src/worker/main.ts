import { pathToFileURL } from 'node:url';
import type { PgBoss } from 'pg-boss';
import { loadConfig, type Env } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createSql } from '../db/sql.js';
import { makeJobContext } from '../jobs/context.js';
import { createBoss, ensureQueues, JobQueue } from '../jobs/queue.js';
import { isQueueName, QUEUES, type QueueName } from '../jobs/registry.js';
import { logger } from '../logger.js';
import { defaultProviderDeps, type ProviderDeps } from '../providers/deps.js';
import { resolveSigningKey } from '../shared/signedUrl.js';
import { LocalStorage } from '../storage/local.js';
import { HANDLERS, type Handler, type WorkerDeps } from './handlers.js';

export interface RunningWorker {
  close(): Promise<void>;
}

/** Test-only knobs. */
export interface WorkerOverrides {
  providers?: Partial<ProviderDeps>;
  handlers?: Partial<Record<QueueName, Handler>>;
  queueOverrides?: Parameters<typeof ensureQueues>[2];
  softLimitMs?: number;
}

const SCHEDULES: Array<{ queue: QueueName; cron: string }> = [
  { queue: 'check_stale_papers', cron: '0 3 * * *' },
  { queue: 'prune_expired', cron: '17 * * * *' },
];

/** Boots the worker: config, pool, migrations, pg-boss (with the cron scheduler), then one pg-boss worker per handler. */
export async function startWorker(rawEnv: Env = process.env, overrides: WorkerOverrides = {}): Promise<RunningWorker> {
  const env: Readonly<Env> = Object.freeze({ ...rawEnv });
  const config = loadConfig(env);
  const sql = createSql(config.databaseUrl, { max: config.workerDbPoolMax });
  let boss: PgBoss | undefined;
  try {
    await migrate(sql);
    const signingKey = resolveSigningKey(env);
    const storage = new LocalStorage(config, signingKey, logger);
    boss = createBoss(config.databaseUrl, { max: 5, supervise: true, schedule: true });
    boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
    await boss.start();
    await ensureQueues(boss, config.jobTimeLimitSec, overrides.queueOverrides);

    const deps: WorkerDeps = {
      sql,
      config,
      env,
      logger,
      storage,
      queue: new JobQueue(boss, sql),
      providers: { ...defaultProviderDeps(), ...overrides.providers },
    };
    const softLimitMs = overrides.softLimitMs ?? (config.jobTimeLimitSec - 60) * 1000;
    const handlers = { ...HANDLERS, ...overrides.handlers };

    for (const name of Object.keys(handlers)) {
      const handler = handlers[name as QueueName];
      if (!handler || !isQueueName(name)) continue;
      await boss.work(
        name,
        { localConcurrency: name === 'process_paper' ? config.ingestionConcurrency : 1, batchSize: 1 },
        async ([job]) => {
          if (!job) return;
          const ctx = makeJobContext(job, sql, logger, softLimitMs);
          try {
            return await handler(job.data, ctx, deps);
          } catch (err) {
            // Rethrow so pg-boss applies the queue's retry policy.
            logger.error({ err, queue: name, jobId: job.id, retryCount: job.retryCount }, 'job failed');
            throw err;
          }
        },
      );
    }
    for (const s of SCHEDULES) {
      if (!Object.hasOwn(QUEUES, s.queue)) continue;
      await boss.schedule(s.queue, s.cron, null, { tz: 'UTC' });
    }
  } catch (e) {
    await boss?.stop({ graceful: false, timeout: 5000 }).catch(() => undefined);
    await sql.end();
    throw e;
  }
  logger.info('ficino worker started');

  const b = boss;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await b.stop({ graceful: true, timeout: 30000 });
      } finally {
        await sql.end();
      }
    })());
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker()
    .then((worker) => {
      const stop = () => {
        worker.close().then(
          () => process.exit(0),
          (e) => {
            logger.error({ err: e }, 'shutdown failed');
            process.exit(1);
          },
        );
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((e) => {
      logger.error({ err: e }, 'startup failed');
      process.exit(1);
    });
}
