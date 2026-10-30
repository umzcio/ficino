import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { toIsoformat } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { body, params, pyInt } from '../http/validate.js';
import { LIMITS } from '../shared/constants.js';

const pathSchema = z.object({ feed_id: z.string(), post_index: pyInt });
const upsertSchema = z.object({ body: z.string() });

export function annotationsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT id, feed_id, post_index, body, created_at, updated_at
      FROM annotations WHERE user_id = ${c.var.user.id}
      ORDER BY updated_at DESC
      LIMIT ${LIMITS.ANNOTATIONS}`;
    return c.json(
      rows.map((x) => ({
        id: String(x.id),
        feed_id: String(x.feed_id),
        post_index: x.post_index,
        body: x.body,
        created_at: toIsoformat(x.created_at),
        updated_at: toIsoformat(x.updated_at),
      })),
    );
  });

  r.get('/:feed_id/:post_index', params(pathSchema), async (c) => {
    const { sql } = c.var.deps;
    const { feed_id, post_index } = c.req.valid('param');
    const [row] = await sql`
      SELECT id, body, created_at, updated_at FROM annotations
      WHERE user_id = ${c.var.user.id} AND feed_id = ${feed_id} AND post_index = ${post_index}`;
    if (!row) throw new HttpError(404, 'No annotation');
    return c.json({
      id: String(row.id),
      feed_id,
      post_index,
      body: row.body,
      created_at: toIsoformat(row.created_at),
      updated_at: toIsoformat(row.updated_at),
    });
  });

  r.put('/:feed_id/:post_index', params(pathSchema), body(upsertSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const { feed_id, post_index } = c.req.valid('param');
    const text = c.req.valid('json').body.trim();
    if (!text) throw new HttpError(400, 'Annotation body cannot be empty');
    const [row] = await sql`
      INSERT INTO annotations (user_id, feed_id, post_index, body)
      VALUES (${c.var.user.id}, ${feed_id}, ${post_index}, ${text})
      ON CONFLICT (user_id, feed_id, post_index)
      DO UPDATE SET body = ${text}, updated_at = NOW()
      RETURNING id, created_at, updated_at`;
    logger.info({ feed_id, post_index }, 'annotation_upserted');
    return c.json({
      id: String(row!.id),
      feed_id,
      post_index,
      body: text,
      created_at: toIsoformat(row!.created_at),
      updated_at: toIsoformat(row!.updated_at),
    });
  });

  r.delete('/:feed_id/:post_index', params(pathSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const { feed_id, post_index } = c.req.valid('param');
    const res = await sql`
      DELETE FROM annotations
      WHERE user_id = ${c.var.user.id} AND feed_id = ${feed_id} AND post_index = ${post_index}`;
    if (res.count === 0) throw new HttpError(404, 'Annotation not found');
    logger.info({ feed_id, post_index }, 'annotation_deleted');
    await recordAudit(c, {
      action: 'annotation.delete',
      resourceType: 'annotation',
      resourceId: feed_id,
      metadata: { post_index },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  return r;
}
