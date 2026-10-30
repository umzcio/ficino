import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { HttpError } from '../http/errors.js';
import { body, params, query } from '../http/validate.js';

const createSchema = z.object({
  feed_id: z.string(),
  post_index: z.number().int(),
  message_index: z.number().int().default(-1),
  persona_key: z.string().nullish(),
  post_type: z.string().nullish(),
  category: z.string().nullish(),
});
const delParams = z.object({ feed_id: z.string(), post_index: z.coerce.number().int() });
const delQuery = z.object({ message_index: z.coerce.number().int().default(-1) });

export function likesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/feed/:feed_id', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT post_index, message_index FROM user_likes
      WHERE user_id = ${c.var.user.id} AND feed_id = ${c.req.param('feed_id')}`;
    const posts: number[] = [];
    const replies: Record<string, boolean> = {};
    for (const row of rows) {
      if (row.message_index === -1) posts.push(row.post_index);
      else replies[`${row.post_index}:${row.message_index}`] = true;
    }
    return c.json({ posts, replies });
  });

  r.post('/', body(createSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const b = c.req.valid('json');
    const [owner] = await sql`SELECT 1 FROM feeds WHERE id = ${b.feed_id} AND user_id = ${userId}`;
    if (!owner) throw new HttpError(404, 'Feed not found');

    const [row] = await sql`
      INSERT INTO user_likes (user_id, feed_id, post_index, message_index, persona_key, post_type, category)
      VALUES (${userId}, ${b.feed_id}, ${b.post_index}, ${b.message_index},
              ${b.persona_key ?? null}, ${b.post_type ?? null}, ${b.category ?? null})
      ON CONFLICT (user_id, feed_id, post_index, message_index) DO NOTHING
      RETURNING id`;
    if (row) {
      logger.info({ feed_id: b.feed_id, post_index: b.post_index, message_index: b.message_index }, 'like_created');
      return c.json({ id: String(row.id), status: 'created' }, 201);
    }
    const [existing] = await sql`
      SELECT id FROM user_likes
      WHERE user_id = ${userId} AND feed_id = ${b.feed_id} AND post_index = ${b.post_index}
        AND message_index = ${b.message_index}`;
    return c.json({ id: String(existing!.id), status: 'already_liked' }, 201);
  });

  r.delete('/feed/:feed_id/:post_index', params(delParams), query(delQuery), async (c) => {
    const { sql, logger } = c.var.deps;
    const { feed_id, post_index } = c.req.valid('param');
    const { message_index } = c.req.valid('query');
    const res = await sql`
      DELETE FROM user_likes
      WHERE user_id = ${c.var.user.id} AND feed_id = ${feed_id} AND post_index = ${post_index}
        AND message_index = ${message_index}`;
    if (res.count === 0) throw new HttpError(404, 'Like not found');
    logger.info({ feed_id, post_index, message_index }, 'like_deleted');
    await recordAudit(c, {
      action: 'like.delete',
      resourceType: 'like',
      metadata: { feed_id, post_index, message_index },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  return r;
}
