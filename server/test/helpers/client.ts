import type { Hono } from 'hono';
import pino from 'pino';
import { createApp, type AppEnv } from '../../src/app.js';
import type { AuthUser } from '../../src/auth/types.js';
import { loadConfig, type Config } from '../../src/config.js';
import { testSql } from './db.js';

export const CSRF_TEST_TOKEN = 'test-csrf-token-fixture';

/** App over the test database with a silent logger. Defaults to ENVIRONMENT=development (loadConfig's default). */
export function testApp(opts: { user?: AuthUser; config?: Partial<Config> } = {}): Hono<AppEnv> {
  const config: Config = {
    ...loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' }),
    ...opts.config,
  };
  return createApp({
    sql: testSql(),
    config,
    logger: pino({ level: 'silent' }),
    env: {},
    userOverride: opts.user,
  });
}

export interface TestResponse {
  status: number;
  headers: Headers;
  json(): Promise<any>;
  text(): Promise<string>;
}

interface ReqInit {
  headers?: Record<string, string>;
}

/**
 * Cookie-jar client over `app.request`. By default it pre-seeds the ficino_csrf cookie and sends the
 * matching X-CSRF-Token on POST/PUT/DELETE/PATCH (like _CsrfAutoClient in api/tests/conftest.py);
 * `{ csrf: false }` turns that off.
 */
export function client(app: Hono<AppEnv>, opts: { csrf?: boolean } = {}) {
  const useCsrf = opts.csrf ?? true;
  const cookies = new Map<string, string>();
  if (useCsrf) cookies.set('ficino_csrf', CSRF_TEST_TOKEN);

  async function send(method: string, path: string, body?: unknown, init: ReqInit = {}): Promise<TestResponse> {
    const headers: Record<string, string> = { ...init.headers };
    if (cookies.size > 0) {
      headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (useCsrf && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      headers['x-csrf-token'] ??= CSRF_TEST_TOKEN;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] ??= 'application/json';
    }
    const res = await app.request(path, { method, headers, body: payload });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  return {
    get: (path: string, init?: ReqInit) => send('GET', path, undefined, init),
    post: (path: string, body?: unknown, init?: ReqInit) => send('POST', path, body, init),
    put: (path: string, body?: unknown, init?: ReqInit) => send('PUT', path, body, init),
    patch: (path: string, body?: unknown, init?: ReqInit) => send('PATCH', path, body, init),
    delete: (path: string, init?: ReqInit) => send('DELETE', path, undefined, init),
    cookies,
  };
}
