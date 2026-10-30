import type { Context } from 'hono';
import type { AppEnv } from './app.js';
import { clientIp } from './http/rateLimit.js';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  statusCode?: number;
}

/**
 * Persist an audit_log row for c.var.user. Never throws. Call after the main write, never inside a
 * transaction (a failed INSERT would poison it).
 */
export async function recordAudit(c: Context<AppEnv>, e: AuditEntry): Promise<void> {
  try {
    const { sql } = c.var.deps;
    const ip = clientIp(c);
    const ua = (c.req.header('user-agent') ?? '').slice(0, 500);
    await sql`
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, ip, user_agent, status_code)
      VALUES (${c.var.user.id}, ${e.action}, ${e.resourceType}, ${e.resourceId ?? null},
              ${sql.json((e.metadata ?? {}) as never)}, ${ip}, ${ua}, ${e.statusCode ?? 200})`;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    c.var.deps.logger.warn({ error_type: error.name, error: error.message.slice(0, 200) }, 'audit_log_write_failed');
  }
}
