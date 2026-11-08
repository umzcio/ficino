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
  /**
   * True when the soft time limit stopped the job (not a pg-boss abort): `signal` aborted with the soft limit's
   * reason, or `signal` has not aborted yet but the limit's time has passed (synchronous work kept its timer from
   * firing).
   */
  softLimitHit(): boolean;
  /**
   * For synchronous loops (MuPDF page walks), where `signal` cannot change because the event loop never turns:
   * throws `signal.reason` if it aborted, or a `TimeoutError` once the soft limit's time has passed by the clock.
   */
  checkpoint(): void;
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
  const softLimit = AbortSignal.timeout(softLimitMs);
  const signal = AbortSignal.any([job.signal, softLimit]);
  const deadline = Date.now() + softLimitMs;
  return {
    jobId: job.id,
    retryCount: job.retryCount,
    retryLimit,
    isFinalAttempt: job.retryCount >= retryLimit,
    signal,
    // AbortSignal.any takes the reason of whichever source aborted first.
    softLimitHit: () =>
      signal.aborted ? softLimit.aborted && signal.reason === softLimit.reason : Date.now() >= deadline,
    checkpoint() {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
    logger,
    async progress(meta) {
      await sql`
        INSERT INTO job_progress (job_id, queue, meta) VALUES (${job.id}, ${job.name}, ${sql.json(meta as never)})
        ON CONFLICT (job_id) DO UPDATE SET meta = EXCLUDED.meta, updated_at = now()`;
    },
  };
}
