import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { toPydanticIso } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { body, params, query } from '../http/validate.js';
import { LIMITS } from '../shared/constants.js';

const createSchema = z.object({
  feed_id: z.string(),
  post_index: z.number().int(),
  message_index: z.number().int().default(-1),
  post_snapshot: z.record(z.string(), z.unknown()),
});
const byPostParams = z.object({ feed_id: z.string(), post_index: z.coerce.number().int() });
const byPostQuery = z.object({ message_index: z.coerce.number().int().default(-1) });

export function bookmarksRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT id, feed_id, post_index, message_index, post_snapshot, bookmarked_at
      FROM bookmarks
      WHERE user_id = ${c.var.user.id}
      ORDER BY bookmarked_at DESC
      LIMIT ${LIMITS.LIBRARY}`;
    return c.json(
      rows.map((x) => ({
        id: String(x.id),
        feed_id: String(x.feed_id),
        post_index: x.post_index,
        message_index: x.message_index,
        post: x.post_snapshot,
        bookmarked_at: toPydanticIso(x.bookmarked_at),
      })),
    );
  });

  r.post('/', body(createSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const b = c.req.valid('json');
    const [owner] = await sql`SELECT 1 FROM feeds WHERE id = ${b.feed_id} AND user_id = ${userId}`;
    if (!owner) throw new HttpError(404, 'Feed not found');

    const [row] = await sql`
      INSERT INTO bookmarks (user_id, feed_id, post_index, message_index, post_snapshot)
      VALUES (${userId}, ${b.feed_id}, ${b.post_index}, ${b.message_index}, ${sql.json(b.post_snapshot as never)})
      ON CONFLICT (user_id, feed_id, post_index, message_index) DO NOTHING
      RETURNING id`;
    if (row) {
      logger.info({ feed_id: b.feed_id, post_index: b.post_index, message_index: b.message_index }, 'bookmark_created');
      return c.json({ id: String(row.id), status: 'created' }, 201);
    }
    const [existing] = await sql`
      SELECT id FROM bookmarks
      WHERE user_id = ${userId} AND feed_id = ${b.feed_id} AND post_index = ${b.post_index}
        AND message_index = ${b.message_index}`;
    return c.json({ id: String(existing!.id), status: 'already_bookmarked' }, 201);
  });

  // Registered before DELETE /:bookmark_id so the 4-segment path is unambiguous.
  r.delete('/post/:feed_id/:post_index', params(byPostParams), query(byPostQuery), async (c) => {
    const { sql } = c.var.deps;
    const { feed_id, post_index } = c.req.valid('param');
    const { message_index } = c.req.valid('query');
    // Intentionally idempotent: a toggle-off on an absent bookmark is a no-op success.
    await sql`
      DELETE FROM bookmarks
      WHERE user_id = ${c.var.user.id} AND feed_id = ${feed_id} AND post_index = ${post_index}
        AND message_index = ${message_index}`;
    await recordAudit(c, {
      action: 'bookmark.delete',
      resourceType: 'bookmark',
      metadata: { feed_id, post_index, message_index },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  r.delete('/:bookmark_id', async (c) => {
    const { sql, logger } = c.var.deps;
    const bookmarkId = c.req.param('bookmark_id');
    const res = await sql`DELETE FROM bookmarks WHERE id = ${bookmarkId} AND user_id = ${c.var.user.id}`;
    if (res.count === 0) throw new HttpError(404, 'Bookmark not found');
    logger.info({ bookmark_id: bookmarkId }, 'bookmark_deleted');
    await recordAudit(c, {
      action: 'bookmark.delete',
      resourceType: 'bookmark',
      resourceId: bookmarkId,
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  return r;
}
