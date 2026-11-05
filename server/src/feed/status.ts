import type { JobState } from '../jobs/queue.js';

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The message of a failed job's output, else its string form. */
export function jobErrorMessage(output: unknown): string {
  const msg = isDict(output) ? output.message : undefined;
  return typeof msg === 'string' ? msg : String(output ?? '');
}

/** C §5.3: the summary status poll. Only completed and failed are terminal; everything else is generating. */
export function summaryStatusFromJob(paperId: string, s: JobState): Record<string, unknown> {
  if (s.state === 'completed') return { status: 'complete', paper_id: paperId };
  if (s.state === 'failed') return { status: 'error', error: jobErrorMessage(s.output) };
  return { status: 'generating' };
}

/** A job that will never finish: a row still saying `generating` for it is stranded. */
export function isStuckJobState(state: JobState['state']): boolean {
  return state === 'failed' || state === 'cancelled' || state === 'missing';
}

/** C §5.2: the Celery state machine of get_feed_status, translated to pg-boss job states. */
export function feedStatusFromJob(taskId: string, s: JobState): Record<string, unknown> {
  switch (s.state) {
    case 'missing':
    case 'created':
      return { status: 'pending', task_id: taskId };
    case 'retry':
      return { status: 'retry', task_id: taskId };
    case 'active':
      return s.progress != null
        ? { status: 'generating', task_id: taskId, meta: s.progress }
        : { status: 'started', task_id: taskId };
    case 'completed': {
      const out = isDict(s.output) ? s.output : {};
      return {
        status: 'complete',
        task_id: taskId,
        feed_id: out.feed_id ?? null,
        post_count: out.post_count ?? null,
        duration_ms: out.duration_ms ?? null,
      };
    }
    case 'failed': {
      return { status: 'error', task_id: taskId, error: jobErrorMessage(s.output) };
    }
    case 'cancelled':
      return { status: 'revoked', task_id: taskId };
  }
}
