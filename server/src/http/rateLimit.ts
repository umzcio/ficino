import { BlockList, isIP } from 'node:net';
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

/** `::ffff:a.b.c.d` (an IPv4 peer on a dual-stack socket) as `a.b.c.d`; anything else unchanged. */
function unmapIpv4(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

const trustLists = new WeakMap<string[], BlockList>();

/** The BlockList for one config's `trustedProxies` (`address/prefix` entries, validated by loadConfig). */
function trustList(cidrs: string[]): BlockList {
  let list = trustLists.get(cidrs);
  if (!list) {
    list = new BlockList();
    for (const cidr of cidrs) {
      const slash = cidr.lastIndexOf('/');
      const address = cidr.slice(0, slash);
      list.addSubnet(address, Number(cidr.slice(slash + 1)), isIP(address) === 6 ? 'ipv6' : 'ipv4');
    }
    trustLists.set(cidrs, list);
  }
  return list;
}

/**
 * The client's address: the socket peer, or the X-Real-IP it sends when the peer is in TRUSTED_PROXIES (the web
 * nginx sets it to $remote_addr) and the header is an IP address. Null without a socket (app.request in tests),
 * whatever the headers say. Never X-Forwarded-For.
 */
export function clientIp(c: Context<AppEnv>): string | null {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    return null; // no socket (app.request in tests)
  }
  if (!peer) return null;
  peer = unmapIpv4(peer);
  const family = isIP(peer);
  if (family === 0 || !trustList(c.var.deps.config.trustedProxies).check(peer, family === 6 ? 'ipv6' : 'ipv4')) return peer;
  const real = unmapIpv4(c.req.header('x-real-ip')?.trim() ?? '');
  return isIP(real) ? real : peer;
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
