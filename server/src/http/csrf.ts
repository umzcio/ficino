import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.js';

export const CSRF_COOKIE_NAME = 'ficino_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
const PROTECTED = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
// Exact path match only. Every entry is a CSRF carve-out; keep minimal.
const EXEMPT_PATHS = new Set(['/auth/login', '/auth/register']);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Double-submit cookie CSRF (C §2.2). Runs before routing, so 404 paths are covered too. */
export function csrf(config: Config): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const cookie = getCookie(c, CSRF_COOKIE_NAME);

    if (PROTECTED.has(method) && !EXEMPT_PATHS.has(c.req.path)) {
      const header = c.req.header(CSRF_HEADER_NAME);
      if (!cookie || !header || !safeEqual(cookie, header)) {
        return new Response('{"detail":"CSRF validation failed"}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    await next();

    if ((method === 'GET' || method === 'HEAD') && cookie === undefined) {
      setCookie(c, CSRF_COOKIE_NAME, randomBytes(32).toString('base64url'), {
        httpOnly: false, // JS reads it to echo in X-CSRF-Token
        sameSite: 'Lax',
        secure: config.environment !== 'development',
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
        ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
      });
    }
  };
}
