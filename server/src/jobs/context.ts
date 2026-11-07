import type { Logger } from 'pino';
import type { Sql } from '../db/sql.js';

export type JobContext = {
  jobId: string;
  retryCount: number;
  /** The job row's retry limit (pg-boss `includeMetadata`), the same number pg-boss's own retry decision reads. */
  retryLimit: number;
  /** True when a throw from this run will not be retried. */
  isFinalAttempt: boolean;
  signal: AbortSignal;
  logger: Logger;
  progress(meta: Record<string, unknown>): Promise<void>;
};

/** The soft limit is (jobTimeLimitSec - 60) s, matching Celery's 540/600. */
export function makeJobContext(
  job: { id: string; name: string; retryCount: number; signal: AbortSignal },
  sql: Sql,
  logger: Logger,
  softLimitMs: number,
  retryLimit: number,
): JobContext {
  return {
    jobId: job.id,
    retryCount: job.retryCount,
    retryLimit,
    isFinalAttempt: job.retryCount >= retryLimit,
    signal: AbortSignal.any([job.signal, AbortSignal.timeout(softLimitMs)]),
    logger,
    async progress(meta) {
      await sql`
        INSERT INTO job_progress (job_id, queue, meta) VALUES (${job.id}, ${job.name}, ${sql.json(meta as never)})
        ON CONFLICT (job_id) DO UPDATE SET meta = EXCLUDED.meta, updated_at = now()`;
    },
  };
}
