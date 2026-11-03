import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import type { Sql } from '../db/sql.js';
import { isQueueName, QUEUES, type QueueName } from './registry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createBoss(
  databaseUrl: string,
  opts: { max: number; supervise: boolean; schedule: boolean },
): PgBoss {
  return new PgBoss({
    connectionString: databaseUrl,
    schema: 'pgboss',
    migrate: true,
    max: opts.max,
    supervise: opts.supervise,
    schedule: opts.schedule,
  });
}

type Overrides = Partial<Record<QueueName, { retryLimit?: number; retryDelay?: number }>>;

/** Creates or updates every queue with its retry policy. Idempotent. `overrides` is for tests only. */
export async function ensureQueues(boss: PgBoss, jobTimeLimitSec: number, overrides: Overrides = {}): Promise<void> {
  for (const name of Object.keys(QUEUES) as QueueName[]) {
    const policy = QUEUES[name] as { retryLimit: number; retryDelay?: number };
    const opts = {
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelay ?? 0,
      ...overrides[name],
      expireInSeconds: jobTimeLimitSec,
    };
    await boss.createQueue(name, opts);
    await boss.updateQueue(name, opts);
  }
}

export type JobState = {
  queue: QueueName | null;
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed' | 'missing';
  progress: Record<string, unknown> | null;
  output: unknown;
};

const MISSING: JobState = { queue: null, state: 'missing', progress: null, output: null };

/** The slice of PgBoss that JobQueue uses (lets tests supply a lazily started boss). */
export type BossLike = Pick<PgBoss, 'send' | 'getJobById'>;

/** pg-boss stores a non-object handler result (e.g. a number) as `{ value }`; hand it back as returned. */
function unwrapOutput(output: unknown): unknown {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const keys = Object.keys(output);
    if (keys.length === 1 && keys[0] === 'value') return (output as { value: unknown }).value;
  }
  return output ?? null;
}

export class JobQueue {
  constructor(
    private readonly boss: BossLike,
    private readonly sql: Sql,
  ) {}

  async send(queue: QueueName, data: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    await this.sql`INSERT INTO job_progress (job_id, queue, meta) VALUES (${id}, ${queue}, NULL)`;
    try {
      const sent = await this.boss.send(queue, data, { id });
      if (sent === null) throw new Error(`pg-boss did not accept job for queue ${queue}`);
    } catch (e) {
      await this.sql`DELETE FROM job_progress WHERE job_id = ${id}`.catch(() => undefined);
      throw e;
    }
    return id;
  }

  async getJobState(jobId: string): Promise<JobState> {
    if (!UUID_RE.test(jobId)) return MISSING;
    const [row] = await this.sql`SELECT queue, meta FROM job_progress WHERE job_id = ${jobId}`;
    if (!row || !isQueueName(row.queue)) return MISSING;
    const job = await this.boss.getJobById(row.queue, jobId);
    if (!job) return MISSING;
    return {
      queue: row.queue,
      state: job.state,
      progress: (row.meta as Record<string, unknown> | null) ?? null,
      output: unwrapOutput(job.output),
    };
  }
}
