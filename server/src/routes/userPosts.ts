import type postgres from 'postgres';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { recordAudit } from '../audit.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import { isStuckJobState } from '../feed/status.js';
import { HttpError } from '../http/errors.js';
import { userRateLimit } from '../http/rateLimit.js';
import { body, pyMaxLen } from '../http/validate.js';
import type { JobState } from '../jobs/queue.js';
import type { QueueName } from '../jobs/registry.js';
import { LIMITS } from '../shared/constants.js';
import { isUuid } from '../shared/uuid.js';

const DISPATCH_FAILED = 'Failed to dispatch Archivist response. Try again.';

const createSchema = z.object({ content: pyMaxLen(4000), corpus_id: z.string().nullish() });
const followUpSchema = z.object({ content: pyMaxLen(4000) });

function shape(row: postgres.Row) {
  return {
    id: String(row.id),
    content: row.content,
    replies: row.replies,
    sources: row.sources,
    status: row.status,
    created_at: toPydanticIso(row.created_at ?? null),
  };
}

/**
 * Sends the Archivist job and stores its id. On a send failure the post is marked `error` with no `task_id`
 * (nothing will answer it, so a follow-up may retry it) and the route answers 503.
 */
async function dispatchOrFail(
  c: Context<AppEnv>,
  postId: string,
  queue: QueueName,
  data: Record<string, unknown>,
): Promise<string> {
  const { sql, logger } = c.var.deps;
  let taskId: string;
  try {
    taskId = await c.var.deps.queue.send(queue, data);
  } catch (e) {
    logger.error({ post_id: postId, error: e instanceof Error ? e.message : String(e) }, 'user_post_dispatch_failed');
    await sql`UPDATE user_posts SET status = 'error', task_id = NULL WHERE id = ${postId}`;
    throw new HttpError(503, DISPATCH_FAILED);
  }
  await sql`UPDATE user_posts SET task_id = ${taskId} WHERE id = ${postId}`;
  return taskId;
}

export function userPostsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const workspaceId = c.req.query('workspace_id');
    // A non-UUID workspace cannot match a uuid column (Python 500s on the cast); answer empty instead.
    if (workspaceId && !isUuid(workspaceId)) return c.json([]);
    const scope = workspaceId ? sql`AND corpus_id = ${workspaceId}` : sql``;
    const rows = await sql`
      SELECT id, content, replies, sources, status, created_at
      FROM user_posts
      WHERE user_id = ${c.var.user.id} ${scope}
      ORDER BY created_at DESC LIMIT ${LIMITS.CONTENT}`;
    return c.json(rows.map(shape));
  });

  r.get('/:post_id', async (c) => {
    const { sql } = c.var.deps;
    const postId = c.req.param('post_id');
    const [row] = isUuid(postId)
      ? await sql`
          SELECT id, content, replies, sources, status, created_at
          FROM user_posts WHERE id = ${postId} AND user_id = ${c.var.user.id}`
      : [];
    if (!row) throw new HttpError(404, 'Post not found');
    return c.json(shape(row));
  });

  r.post('/', userRateLimit('user_post'), body(createSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const { content, corpus_id: corpusId } = c.req.valid('json');

    // A corpus must belong to the caller, else a user could stage an Archivist run over another's corpus.
    if (corpusId) {
      const [owner] = isUuid(corpusId)
        ? await sql`SELECT 1 AS ok FROM corpora WHERE id = ${corpusId} AND user_id = ${userId}`
        : [];
      if (!owner) throw new HttpError(404, 'Workspace not found');
    }

    const [row] = await sql`
      INSERT INTO user_posts (user_id, corpus_id, content, status)
      VALUES (${userId}, ${corpusId || null}, ${content}, 'pending') RETURNING id`;
    const postId = String(row!.id);

    const taskId = await dispatchOrFail(c, postId, 'respond_to_user_post', {
      user_post_id: postId,
      corpus_id: corpusId ?? null,
    });
    logger.info({ post_id: postId, task_id: taskId }, 'user_post_created');
    return c.json({ id: postId, task_id: taskId, status: 'pending' }, 201);
  });

  r.post('/:post_id/replies', userRateLimit('user_post'), body(followUpSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const postId = c.req.param('post_id');
    const { content } = c.req.valid('json');

    const [owned] = isUuid(postId)
      ? await sql`SELECT id FROM user_posts WHERE id = ${postId} AND user_id = ${c.var.user.id}`
      : [];
    if (!owned) throw new HttpError(404, 'Post not found');

    // Check-and-flip in one statement: of two concurrent follow-ups only the row-lock winner updates.
    // Deliberate change 11: an `error` post with no job left (task_id NULL) whose last turn is the user's is
    // retryable; the retry replaces that unanswered turn (the frontend dropped its copy after the failure). A failed
    // first answer (no turns) stays a dead end, as in Python.
    const [updated] = await sql`
      UPDATE user_posts
      SET replies = CASE WHEN status = 'error' THEN replies - (-1) ELSE replies END
            || ${sql.json([{ role: 'user', content }] as never)},
          status = 'pending', task_id = NULL
      WHERE id = ${postId}
        AND (status = 'complete' OR (status = 'error' AND task_id IS NULL AND replies->-1->>'role' = 'user'))
      RETURNING id`;
    if (!updated) throw new HttpError(409, 'Previous reply not ready yet');

    const taskId = await dispatchOrFail(c, postId, 'respond_to_user_post_followup', { user_post_id: postId });
    logger.info({ post_id: postId, task_id: taskId }, 'user_post_followup');
    return c.json({ id: postId, task_id: taskId, status: 'pending' }, 202);
  });

  r.delete('/:post_id', async (c) => {
    const { sql } = c.var.deps;
    const postId = c.req.param('post_id');
    const res = isUuid(postId)
      ? await sql`DELETE FROM user_posts WHERE id = ${postId} AND user_id = ${c.var.user.id}`
      : { count: 0 };
    if (res.count === 0) throw new HttpError(404, 'Post not found');
    await recordAudit(c, { action: 'user_post.delete', resourceType: 'user_post', resourceId: postId, statusCode: 204 });
    return c.body(null, 204);
  });

  r.get('/:post_id/status', async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const postId = c.req.param('post_id');
    const [row] = isUuid(postId)
      ? await sql`SELECT status, task_id FROM user_posts WHERE id = ${postId} AND user_id = ${c.var.user.id}`
      : [];
    if (!row) throw new HttpError(404, 'Post not found');
    const answer = (r: postgres.Row) => c.json({ status: r.status, task_id: r.task_id ?? '' });

    // Deliberate change 11: a post whose job will never run again must not spin or 409 forever. `completed` is not
    // stuck: a late task_id write from an earlier follow-up can point a live post at a completed job. No
    // re-dispatch here (no charge path, and a job that kills the process would loop).
    const oldTaskId = row.task_id as string | null;
    if ((row.status !== 'pending' && row.status !== 'error') || !oldTaskId) return answer(row);
    let state: JobState['state'];
    try {
      state = (await queue.getJobState(oldTaskId)).state;
    } catch (e) {
      logger.warn(
        { post_id: postId, task_id: oldTaskId, err: e instanceof Error ? e.message : String(e) },
        'user_post_status_check_failed',
      );
      return answer(row);
    }
    if (!isStuckJobState(state)) return answer(row);

    // pending: the job died before its catch ran. error: a non-final attempt kept its task_id, then the final
    // attempt was hard-killed. Either way nothing will answer the last turn; clearing task_id makes it retryable.
    const pending = row.status === 'pending';
    logger.warn(
      { post_id: postId, old_task_id: oldTaskId, task_state: state },
      pending ? 'user_post_stuck_pending' : 'user_post_stuck_error',
    );
    const [healed] = await sql`
      UPDATE user_posts SET status = 'error', task_id = NULL
      WHERE id = ${postId} AND status = ${row.status as string} AND task_id = ${oldTaskId}
      RETURNING status, task_id`;
    if (healed) return answer(healed);
    // Something else wrote the row first (a retry, a late answer): answer what is stored now.
    const [now] = await sql`SELECT status, task_id FROM user_posts WHERE id = ${postId}`;
    if (!now) throw new HttpError(404, 'Post not found');
    return answer(now);
  });

  return r;
}
