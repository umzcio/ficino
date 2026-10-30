import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { query } from '../http/validate.js';

const auditQuery = z.object({ limit: z.coerce.number().int().default(100) });

export function usersRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/me', async (c) => {
    const { sql } = c.var.deps;
    const [row] = await sql`SELECT id, email, display_name, created_at FROM users WHERE id = ${c.var.user.id}`;
    if (!row) throw new HttpError(404, 'User not found');
    return c.json({
      id: String(row.id),
      email: row.email,
      display_name: row.display_name,
      created_at: toPydanticIso(row.created_at),
    });
  });

  r.get('/me/audit-log', query(auditQuery), async (c) => {
    const { sql } = c.var.deps;
    const limit = Math.min(Math.max(c.req.valid('query').limit, 1), 500);
    // metadata::text reproduces Python's asyncpg behavior: jsonb arrives as a JSON *string* (C §6.18).
    const rows = await sql`
      SELECT id, action, resource_type, resource_id, metadata::text AS metadata, ip, status_code, created_at
      FROM audit_log WHERE user_id = ${c.var.user.id} ORDER BY created_at DESC LIMIT ${limit}`;
    return c.json(
      rows.map((row) => ({
        id: String(row.id),
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        metadata: row.metadata,
        ip: row.ip,
        status_code: row.status_code,
        created_at: toPydanticIso(row.created_at),
      })),
    );
  });

  return r;
}
