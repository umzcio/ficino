import type postgres from 'postgres';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { recordAudit } from '../audit.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { userRateLimit } from '../http/rateLimit.js';
import { body, pyMaxLen } from '../http/validate.js';
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
    const { sql, queue, logger } = c.var.deps;
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

    let taskId: string;
    try {
      taskId = await queue.send('respond_to_user_post', { user_post_id: postId, corpus_id: corpusId ?? null });
    } catch (e) {
      logger.error({ post_id: postId, error: e instanceof Error ? e.message : String(e) }, 'user_post_dispatch_failed');
      await sql`UPDATE user_posts SET status = 'error' WHERE id = ${postId}`;
      throw new HttpError(503, DISPATCH_FAILED);
    }
    await sql`UPDATE user_posts SET task_id = ${taskId} WHERE id = ${postId}`;
    logger.info({ post_id: postId, task_id: taskId }, 'user_post_created');
    return c.json({ id: postId, task_id: taskId, status: 'pending' }, 201);
  });

  r.post('/:post_id/replies', userRateLimit('user_post'), body(followUpSchema), async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const postId = c.req.param('post_id');
    const { content } = c.req.valid('json');

    const [owned] = isUuid(postId)
      ? await sql`SELECT id FROM user_posts WHERE id = ${postId} AND user_id = ${c.var.user.id}`
      : [];
    if (!owned) throw new HttpError(404, 'Post not found');

    // Check-and-flip in one statement: of two concurrent follow-ups only the row-lock winner updates.
    const [updated] = await sql`
      UPDATE user_posts
      SET replies = replies || ${sql.json([{ role: 'user', content }] as never)}, status = 'pending'
      WHERE id = ${postId} AND status = 'complete'
      RETURNING id`;
    if (!updated) throw new HttpError(409, 'Previous reply not ready yet');

    let taskId: string;
    try {
      taskId = await queue.send('respond_to_user_post_followup', { user_post_id: postId });
    } catch (e) {
      logger.error({ post_id: postId, error: e instanceof Error ? e.message : String(e) }, 'user_post_dispatch_failed');
      await sql`UPDATE user_posts SET status = 'error' WHERE id = ${postId}`;
      throw new HttpError(503, DISPATCH_FAILED);
    }
    await sql`UPDATE user_posts SET task_id = ${taskId} WHERE id = ${postId}`;
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
    const { sql } = c.var.deps;
    const postId = c.req.param('post_id');
    const [row] = isUuid(postId)
      ? await sql`SELECT status, task_id FROM user_posts WHERE id = ${postId} AND user_id = ${c.var.user.id}`
      : [];
    if (!row) throw new HttpError(404, 'Post not found');
    return c.json({ status: row.status, task_id: row.task_id ?? '' });
  });

  return r;
}
