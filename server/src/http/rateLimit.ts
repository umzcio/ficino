import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppEnv } from '../app.js';
import type { Config } from '../config.js';
import type { Sql } from '../db/sql.js';
import { HttpError } from './errors.js';

const USER_WINDOW_SEC = 86400;

/**
 * Fixed-window counter: one statement, so concurrent hits can't lose increments. The window starts at
 * the first hit and is not extended by later ones. Returns the count after this hit.
 */
export async function hitRateLimit(sql: Sql, key: string, windowSec: number): Promise<number> {
  const [row] = await sql`
    INSERT INTO rate_limits AS r (key, count, window_ends_at)
    VALUES (${key}, 1, now() + make_interval(secs => ${windowSec}))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN r.window_ends_at <= now() THEN 1 ELSE r.count + 1 END,
      window_ends_at = CASE WHEN r.window_ends_at <= now() THEN now() + make_interval(secs => ${windowSec}) ELSE r.window_ends_at END
    RETURNING count`;
  return Number(row.count);
}

/** X-Real-IP (set by nginx to $remote_addr), else the socket peer, else null. Never X-Forwarded-For. */
export function clientIp(c: Context<AppEnv>): string | null {
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // no socket (app.request in tests)
  }
}

/** Imperative per-user charge. No-op under AUTH_PROVIDER=none. Needs c.var.user. */
export async function chargeUserRateLimit(c: Context<AppEnv>, prefix: keyof Config['rateLimits']): Promise<void> {
  const { sql, config, logger } = c.var.deps;
  if (config.authProvider === 'none') return;
  const max = config.rateLimits[prefix];
  const userId = c.var.user.id;
  const count = await hitRateLimit(sql, `ratelimit:${prefix}:${userId}`, USER_WINDOW_SEC);
  if (count > max) {
    logger.warn({ user_id: userId, action: prefix, limit: max }, 'rate_limit_exceeded');
    throw new HttpError(429, `Rate limit exceeded: ${max} ${prefix} per ${Math.floor(USER_WINDOW_SEC / 3600)}h. Try again later.`);
  }
}

/** Compose after requireUser and BEFORE validators. */
export function userRateLimit(prefix: keyof Config['rateLimits']): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await chargeUserRateLimit(c, prefix);
    await next();
  };
}

/** Always active. Compose BEFORE validators so an invalid request still uses up a slot. */
export function ipRateLimit(prefix: 'login' | 'register', max: number, windowSec: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { sql, logger } = c.var.deps;
    const ip = clientIp(c) ?? 'unknown';
    const count = await hitRateLimit(sql, `ratelimit:${prefix}:ip:${ip}`, windowSec);
    if (count > max) {
      logger.warn({ ip, action: prefix, limit: max }, 'ip_rate_limit_exceeded');
      throw new HttpError(429, `Too many ${prefix} attempts. Try again later.`);
    }
    await next();
  };
}
