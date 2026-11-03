import type { Logger } from 'pino';
import type { Sql } from '../db/sql.js';

export type JobContext = {
  jobId: string;
  retryCount: number;
  signal: AbortSignal;
  logger: Logger;
  progress(meta: Record<string, unknown>): Promise<void>;
};

/** The soft limit is (jobTimeLimitSec - 60) s, matching Celery's 540/600. */
export function makeJobContext(
  job: { id: string; retryCount: number; signal: AbortSignal },
  sql: Sql,
  logger: Logger,
  softLimitMs: number,
): JobContext {
  return {
    jobId: job.id,
    retryCount: job.retryCount,
    signal: AbortSignal.any([job.signal, AbortSignal.timeout(softLimitMs)]),
    logger,
    async progress(meta) {
      await sql`UPDATE job_progress SET meta = ${sql.json(meta as never)}, updated_at = now() WHERE job_id = ${job.id}`;
    },
  };
}
