import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { toIsoformat } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { params, pyInt } from '../http/validate.js';
import { LIMITS } from '../shared/constants.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const threadParams = z.object({ feed_id: z.string(), post_index: pyInt });
const deleteParams = z.object({ feed_id: z.string(), post_index: pyInt, message_index: pyInt });

export function repliesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/conversations', async (c) => {
    const { sql } = c.var.deps;
    // WITH ORDINALITY so ORDER BY ord DESC finds the LATEST turn of each role.
    const rows = await sql`
      SELECT pr.id, pr.feed_id, pr.post_index, pr.persona_key, pr.updated_at,
             COALESCE(jsonb_array_length(pr.messages), 0)::int AS message_count,
             COALESCE(
               (SELECT LEFT(m->>'content', 100)
                FROM jsonb_array_elements(pr.messages) WITH ORDINALITY AS t(m, ord)
                WHERE m->>'role' = 'user'
                ORDER BY ord DESC LIMIT 1),
               ''
             ) AS last_user,
             COALESCE(
               (SELECT LEFT(m->>'content', 100)
                FROM jsonb_array_elements(pr.messages) WITH ORDINALITY AS t(m, ord)
                WHERE m->>'role' = 'persona'
                ORDER BY ord DESC LIMIT 1),
               ''
             ) AS last_persona
      FROM post_replies pr
      JOIN feeds f ON pr.feed_id = f.id AND f.user_id = ${c.var.user.id}
      ORDER BY pr.updated_at DESC
      LIMIT ${LIMITS.ACTIVITY}`;
    return c.json(
      rows.map((x) => ({
        id: String(x.id),
        feed_id: String(x.feed_id),
        post_index: x.post_index,
        persona_key: x.persona_key,
        message_count: x.message_count,
        last_user_message: x.last_user,
        last_persona_message: x.last_persona,
        updated_at: toIsoformat(x.updated_at),
      })),
    );
  });

  r.get('/replied-posts/:feed_id', async (c) => {
    const { sql } = c.var.deps;
    const feedId = c.req.param('feed_id');
    // A non-UUID id cannot match a uuid column (Python 500s on the cast); answer empty instead.
    if (!UUID_RE.test(feedId)) return c.json([]);
    const rows = await sql`
      SELECT pr.post_index FROM post_replies pr
      JOIN feeds f ON pr.feed_id = f.id AND f.user_id = ${c.var.user.id}
      WHERE pr.feed_id = ${feedId}`;
    return c.json(rows.map((x) => x.post_index as number));
  });

  r.get('/:feed_id/:post_index', params(threadParams), async (c) => {
    const { sql } = c.var.deps;
    const { feed_id: feedId, post_index: postIndex } = c.req.valid('param');
    const [row] = UUID_RE.test(feedId)
      ? await sql`
          SELECT pr.id, pr.messages, pr.persona_key FROM post_replies pr
          JOIN feeds f ON pr.feed_id = f.id AND f.user_id = ${c.var.user.id}
          WHERE pr.feed_id = ${feedId} AND pr.post_index = ${postIndex}`
      : [];
    if (!row) return c.json({ messages: [], persona_key: null });
    return c.json({ id: String(row.id), messages: row.messages, persona_key: row.persona_key });
  });

  r.delete('/:feed_id/:post_index/message/:message_index', params(deleteParams), async (c) => {
    const { sql } = c.var.deps;
    const { feed_id: feedId, post_index: postIndex, message_index: idx } = c.req.valid('param');
    const [owner] = UUID_RE.test(feedId)
      ? await sql`SELECT id FROM feeds WHERE id = ${feedId} AND user_id = ${c.var.user.id}`
      : [];
    if (!owner) throw new HttpError(404, 'Feed not found');
    const [row] = await sql`
      SELECT id, jsonb_array_length(messages) AS n FROM post_replies
      WHERE feed_id = ${feedId} AND post_index = ${postIndex}`;
    if (!row) throw new HttpError(404, 'Reply thread not found');
    if (idx < 0 || idx >= Number(row.n)) throw new HttpError(404, 'Message not found');
    // Single statement; jsonb - int removes the element atomically. updated_at is untouched, as in Python.
    await sql`
      UPDATE post_replies SET messages = messages - ${idx}::int
      WHERE feed_id = ${feedId} AND post_index = ${postIndex}`;
    await recordAudit(c, {
      action: 'reply.delete_message',
      resourceType: 'reply',
      metadata: { feed_id: feedId, post_index: postIndex, message_index: idx },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  return r;
}
