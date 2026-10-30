import { Hono } from 'hono';
import type { AppEnv } from '../app.js';

export function healthRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.on('GET', ['/health', '/healthz'], (c) => c.json({ status: 'ok', service: 'ficino-api' }));
  return r;
}
