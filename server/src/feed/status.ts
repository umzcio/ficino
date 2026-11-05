import type { JobState } from '../jobs/queue.js';

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
      const msg = isDict(s.output) ? s.output.message : undefined;
      return { status: 'error', task_id: taskId, error: typeof msg === 'string' ? msg : String(s.output ?? '') };
    }
    case 'cancelled':
      return { status: 'revoked', task_id: taskId };
  }
}
