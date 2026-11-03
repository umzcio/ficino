import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError } from '../../src/http/errors.js';
import { body, params, pyInt } from '../../src/http/validate.js';
import { resolveSigningKey } from '../../src/shared/signedUrl.js';
import { LocalStorage } from '../../src/storage/local.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, testSql, USER_A_ID } from '../helpers/db.js';

describe('error contract (C §0)', () => {
  beforeEach(() => resetDb(testSql()));

  it('unknown route → 404 {"detail":"Not Found"}', async () => {
    const r = await client(testApp()).get('/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Not Found' });
  });

  it('wrong method on a real route → 405 {"detail":"Method Not Allowed"}', async () => {
    const r = await client(testApp()).delete('/health');
    expect(r.status).toBe(405);
    expect(await r.json()).toEqual({ detail: 'Method Not Allowed' });
    expect(r.headers.get('allow')).toBe('GET');
  });

  it('405 detection sees routes mounted with app.route()', async () => {
    const { Hono } = await import('hono');
    const app = testApp();
    const sub = new Hono();
    sub.get('/things/:id', (c) => c.json({ id: c.req.param('id') }));
    app.route('/v', sub);
    const c = client(app);
    expect((await c.get('/v/things/1')).status).toBe(200);
    expect((await c.delete('/v/things/1')).status).toBe(405);
    expect((await c.delete('/v/other')).status).toBe(404);
  });

  it('c.notFound() from a handler on a path with another method is 404, not 405', async () => {
    const app = testApp();
    app.get('/__t/papers/:id', (c) => c.notFound());
    app.delete('/__t/papers/:id', (c) => c.body(null, 204));
    const c = client(app);
    const r = await c.get('/__t/papers/1');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Not Found' });
    expect((await c.post('/__t/papers/1', {})).status).toBe(405);
  });

  it('non-Error throw → 500 text/plain with security headers', async () => {
    const app = testApp();
    app.get('/__t/str', () => {
      throw 'string';
    });
    const r = await client(app).get('/__t/str');
    expect(r.status).toBe(500);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await r.text()).toBe('Internal Server Error');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });

  it('HttpError → {detail} with its status', async () => {
    const app = testApp();
    app.get('/__t/teapot', () => {
      throw new HttpError(418, 'short and stout');
    });
    const r = await client(app).get('/__t/teapot');
    expect(r.status).toBe(418);
    expect(await r.json()).toEqual({ detail: 'short and stout' });
  });

  it('unhandled exception → 500 text/plain "Internal Server Error"', async () => {
    const app = testApp();
    app.get('/__t/boom', () => {
      throw new Error('secret internals');
    });
    const r = await client(app).get('/__t/boom');
    expect(r.status).toBe(500);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await r.text()).toBe('Internal Server Error');
  });

  it('22P02 mapping logs a warn with path, code and message', async () => {
    const { createApp } = await import('../../src/app.js');
    const { loadConfig } = await import('../../src/config.js');
    const { default: pino } = await import('pino');
    const key = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (s: string) => void lines.push(s) });
    const app = createApp({
      sql: testSql(),
      config: loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' }),
      logger,
      storage: new LocalStorage({ uploadDir: '/nonexistent/u', figuresDir: '/nonexistent/f', mediaDir: '/nonexistent/m' }, key),
      signingKey: key,
      env: {},
    });
    app.get('/__t/uuid', async (c) => {
      await testSql()`SELECT ${'abc'}::uuid`;
      return c.json({});
    });
    expect((await client(app).get('/__t/uuid')).status).toBe(404);
    const rec = JSON.parse(lines.at(-1)!);
    expect(rec).toMatchObject({ level: 40, path: '/__t/uuid', code: '22P02', msg: 'invalid_text_representation mapped to 404' });
  });

  it('22P02 logs the Postgres error text under pg_message', async () => {
    const { createApp } = await import('../../src/app.js');
    const { loadConfig } = await import('../../src/config.js');
    const { default: pino } = await import('pino');
    const key = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (s: string) => void lines.push(s) });
    const app = createApp({
      sql: testSql(),
      config: loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' }),
      logger,
      storage: new LocalStorage({ uploadDir: '/nonexistent/u', figuresDir: '/nonexistent/f', mediaDir: '/nonexistent/m' }, key),
      signingKey: key,
      env: {},
    });
    app.get('/__t/uuid', async (c) => {
      await testSql()`SELECT ${'abc'}::uuid`;
      return c.json({});
    });
    await client(app).get('/__t/uuid');
    const rec = JSON.parse(lines.at(-1)!);
    expect(rec.pg_message).toMatch(/invalid input syntax for type uuid/);
    expect(rec.msg).toBe('invalid_text_representation mapped to 404');
  });

  it('HTTPException keeps headers from its res (Retry-After) on the {detail} response', async () => {
    const { HTTPException } = await import('hono/http-exception');
    const app = testApp();
    app.get('/__t/slow', () => {
      throw new HTTPException(429, {
        message: 'slow down',
        res: new Response('x', { status: 429, headers: { 'Retry-After': '7', 'Content-Type': 'text/plain' } }),
      });
    });
    const r = await client(app).get('/__t/slow');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('7');
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await r.json()).toEqual({ detail: 'slow down' });
  });

  it('PG invalid_text_representation (22P02) → 404 {"detail":"Not Found"}', async () => {
    const app = testApp();
    app.get('/__t/uuid', async (c) => {
      await testSql()`SELECT ${'abc'}::uuid`;
      return c.json({});
    });
    const r = await client(app).get('/__t/uuid');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Not Found' });
  });

  it('other PG errors stay 500', async () => {
    const app = testApp();
    app.get('/__t/pg', async (c) => {
      await testSql()`SELECT 1 FROM no_such_table`;
      return c.json({});
    });
    const r = await client(app).get('/__t/pg');
    expect(r.status).toBe(500);
    expect(await r.text()).toBe('Internal Server Error');
  });
});

describe('validation helpers (C §0, 422 shape)', () => {
  const schema = z.object({ name: z.string(), n: z.number().int() });

  function app() {
    const a = testApp();
    a.post('/__t/echo', body(schema), (c) => c.json(c.req.valid('json')));
    a.get('/__t/post/:post_index', params(z.object({ post_index: z.coerce.number().int() })), (c) =>
      c.json(c.req.valid('param')),
    );
    return a;
  }

  it('valid body passes through', async () => {
    const r = await client(app()).post('/__t/echo', { name: 'a', n: 1 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ name: 'a', n: 1 });
  });

  it('invalid body → 422 with loc[0]="body"', async () => {
    const r = await client(app()).post('/__t/echo', { name: 'a', n: 'x' });
    expect(r.status).toBe(422);
    const { detail } = await r.json();
    expect(detail[0]).toMatchObject({ loc: ['body', 'n'], input: 'x' });
    expect(typeof detail[0].type).toBe('string');
    expect(typeof detail[0].msg).toBe('string');
  });

  it('malformed JSON → 422 array detail', async () => {
    const r = await client(app()).post('/__t/echo', undefined, {
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(422);
    expect(Array.isArray((await r.json()).detail)).toBe(true);
  });

  it('path int coerces; non-int → 422 with loc[0]="path"', async () => {
    const c = client(app());
    expect(await (await c.get('/__t/post/3')).json()).toEqual({ post_index: 3 });
    const r = await c.get('/__t/post/abc');
    expect(r.status).toBe(422);
    expect((await r.json()).detail[0].loc).toEqual(['path', 'post_index']);
  });
});

describe('pyInt (Python int() query semantics)', () => {
  it.each(['', '%20', '0x10', '1e3', '5.0'])('rejects %j with 422', async (v) => {
    const r = await client(testApp({ user: { id: USER_A_ID, email: 'a@b', display_name: null } })).get(
      `/users/me/audit-log?limit=${v}`,
    );
    expect(r.status).toBe(422);
  });

  it.each([['5', 5], ['%207%20', 7], ['-1', -1], ['%2B3', 3]])('accepts %j', async (v) => {
    const r = await client(testApp({ user: { id: USER_A_ID, email: 'a@b', display_name: null } })).get(
      `/users/me/audit-log?limit=${v}`,
    );
    expect(r.status).toBe(200);
  });

  it('pyInt unit: outputs numbers', () => {
    expect(pyInt.parse(' 7 ')).toBe(7);
    expect(pyInt.parse(5)).toBe(5);
    expect(() => pyInt.parse('5.0')).toThrow();
    expect(() => pyInt.parse(5.5)).toThrow();
  });
});
