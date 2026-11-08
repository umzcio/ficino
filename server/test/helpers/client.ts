import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import pino, { type Logger } from 'pino';
import type { ProviderDeps } from '../../src/providers/deps.js';
import type { Rng } from '../../src/shared/random.js';
import { createApp, type AppEnv } from '../../src/app.js';
import type { AuthUser } from '../../src/auth/types.js';
import { loadConfig, type Config } from '../../src/config.js';
import { resolveSigningKey } from '../../src/shared/signedUrl.js';
import { LocalStorage } from '../../src/storage/local.js';
import type { Sql } from '../../src/db/sql.js';
import { testSql } from './db.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { testQueue } from './queue.js';

let storageRoot: string | undefined;
/** One temp dir per process (test-only artifact, under os.tmpdir()). */
export function testStorageDirs() {
  storageRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ficino-test-storage-'));
  return {
    uploadDir: path.join(storageRoot, 'uploads'),
    figuresDir: path.join(storageRoot, 'figures'),
    mediaDir: path.join(storageRoot, 'media'),
  };
}

export const CSRF_TEST_TOKEN = 'test-csrf-token-fixture';

/** App over the test database with a silent logger (or `opts.logger`). Defaults to ENVIRONMENT=development (loadConfig's default). */
export function testApp(
  opts: {
    user?: AuthUser;
    config?: Partial<Config>;
    fetch?: typeof fetch;
    providers?: ProviderDeps;
    rng?: Rng;
    queue?: JobQueue;
    sql?: Sql;
    logger?: Logger;
  } = {},
): Hono<AppEnv> {
  const config: Config = {
    ...loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' }),
    ...testStorageDirs(),
    ...opts.config,
  };
  const logger = opts.logger ?? pino({ level: 'silent' });
  const signingKey = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
  const storage = new LocalStorage({ ...testStorageDirs(), ...opts.config }, signingKey, logger);
  return createApp({
    sql: opts.sql ?? testSql(),
    queue: opts.queue ?? testQueue(),
    config,
    logger,
    storage,
    signingKey,
    env: {},
    fetch: opts.fetch,
    userOverride: opts.user,
    providers: opts.providers,
    rng: opts.rng,
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
  /** The socket peer address the request appears to come from (what getConnInfo reads); none by default. */
  peer?: string;
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
    const env = init.peer === undefined ? undefined : { incoming: { socket: { remoteAddress: init.peer } } };
    const res = await app.request(path, { method, headers, body: payload }, env);
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((x) => x.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const attr = (k: string) => attrs.find((a) => a.toLowerCase().startsWith(`${k}=`))?.slice(k.length + 1);
      const maxAge = attr('max-age');
      const expires = attr('expires');
      const gone =
        value === '' ||
        (maxAge !== undefined && Number(maxAge) <= 0) ||
        (expires !== undefined && Date.parse(expires) <= Date.now());
      if (gone) cookies.delete(name);
      else cookies.set(name, value);
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
    send,
    cookies,
  };
}
