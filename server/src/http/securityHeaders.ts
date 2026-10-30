import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';

// connect-src is 'self' only: Supabase is gone from the TS port (deliberate divergence from C §2.1).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";

export function securityHeaders(config: Config): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.environment !== 'development') {
      c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      c.header('Content-Security-Policy', CSP);
    }
  };
}
