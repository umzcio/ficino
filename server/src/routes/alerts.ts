import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { LIMITS } from '../shared/constants.js';

export function alertsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT id, alert_type, title, body, metadata, read, created_at
      FROM alerts
      WHERE user_id = ${c.var.user.id} AND dismissed = false
      ORDER BY created_at DESC
      LIMIT ${LIMITS.ALERTS}`;
    return c.json(
      rows.map((row) => ({
        id: String(row.id),
        type: row.alert_type,
        title: row.title,
        body: row.body,
        metadata: row.metadata,
        read: row.read,
        created_at: toPydanticIso(row.created_at),
      })),
    );
  });

  r.get('/unread-count', async (c) => {
    const { sql } = c.var.deps;
    const [row] = await sql`
      SELECT COUNT(*)::int AS count FROM alerts
      WHERE user_id = ${c.var.user.id} AND read = false AND dismissed = false`;
    return c.json({ count: row!.count });
  });

  // Declared before /:alert_id/read; the shapes differ, but keep the literal route first.
  r.put('/read-all', async (c) => {
    const { sql } = c.var.deps;
    await sql`UPDATE alerts SET read = true WHERE user_id = ${c.var.user.id} AND dismissed = false`;
    return c.json({ status: 'ok' });
  });

  r.put('/:alert_id/read', async (c) => {
    const { sql } = c.var.deps;
    await sql`UPDATE alerts SET read = true WHERE id = ${c.req.param('alert_id')} AND user_id = ${c.var.user.id}`;
    return c.json({ status: 'ok' });
  });

  r.delete('/:alert_id', async (c) => {
    const { sql, logger } = c.var.deps;
    const alertId = c.req.param('alert_id');
    const res = await sql`
      UPDATE alerts SET dismissed = true
      WHERE id = ${alertId} AND user_id = ${c.var.user.id} AND dismissed = false`;
    if (res.count === 0) throw new HttpError(404, 'Alert not found');
    logger.info({ alert_id: alertId }, 'alert_dismissed');
    return c.body(null, 204);
  });

  return r;
}
