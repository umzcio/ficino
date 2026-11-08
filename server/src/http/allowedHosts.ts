import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import { DEV_ORIGINS, type Config } from '../config.js';
import { normalizeHost } from '../shared/host.js';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

function originHost(origin: string): string {
  let host: string | null = null;
  try {
    host = normalizeHost(new URL(origin).host);
  } catch {
    // reported below
  }
  if (host === null) throw new Error(`CORS_ORIGINS entry is not an origin: ${origin}`);
  return host;
}

/**
 * The Host names the API answers to: loopback (the container healthcheck calls 127.0.0.1), the hostnames of
 * CORS_ORIGINS (the web nginx passes the browser's Host, which for a same-origin deployment is the origin's
 * host), the dev origins' hosts in development, and ALLOWED_HOSTS. Null when ALLOWED_HOSTS is `*` (no check).
 */
export function allowedHostSet(config: Pick<Config, 'allowedHosts' | 'corsOrigins' | 'environment'>): Set<string> | null {
  if (config.allowedHosts === '*') return null;
  const origins = config.environment === 'development' ? [...config.corsOrigins, ...DEV_ORIGINS] : config.corsOrigins;
  return new Set([...LOOPBACK, ...origins.map(originHost), ...config.allowedHosts]);
}

/**
 * DNS-rebinding guard, mounted first. A page on an attacker's name that later resolves to this server is
 * same-origin with itself, so neither CORS nor the double-submit CSRF check stops it (it can set its own
 * ficino_csrf cookie); only the Host it must send gives it away. Any request whose Host header, or request URL
 * host, is not an allowed name gets 421 `{"detail":"Unknown host"}` before csrf, routing or any handler runs.
 */
export function allowedHosts(config: Config, logger: Logger): MiddlewareHandler {
  const allowed = allowedHostSet(config);
  if (allowed === null) return (_c, next) => next();
  return async (c, next) => {
    const header = c.req.header('host');
    const urlHost = new URL(c.req.url).host;
    const hosts = header === undefined ? [urlHost] : [header, urlHost];
    if (
      hosts.every((h) => {
        const name = normalizeHost(h);
        return name !== null && allowed.has(name);
      })
    ) {
      return next();
    }
    logger.warn({ method: c.req.method, path: c.req.path, host: (header ?? urlHost).slice(0, 255) }, 'host_rejected');
    return new Response('{"detail":"Unknown host"}', {
      status: 421,
      headers: { 'content-type': 'application/json' },
    });
  };
}
