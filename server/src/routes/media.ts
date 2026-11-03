import { readFile, stat } from 'node:fs/promises';
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { HttpError } from '../http/errors.js';
import { verifyToken } from '../shared/signedUrl.js';
import { tokenQuery } from './figures.js';

const FEED_ID_IN_KEY = /^feeds\/([^/]+)\//;

/** Feed audio and podcast files, behind a signed token that is also tied to the caller's own feed. */
export function mediaRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/*', async (c) => {
    const { sql, storage, signingKey } = c.var.deps;
    const key = c.req.path.slice('/media/'.length);
    const token = tokenQuery(c);
    if (typeof token !== 'string') return token;

    if (!verifyToken(signingKey, `media:${key}`, token)) throw new HttpError(403, 'Invalid or expired media token');

    const filePath = storage.mediaFilePath(key);
    if (filePath === null) throw new HttpError(404, 'Media not found');
    const feedId = FEED_ID_IN_KEY.exec(key)?.[1];
    if (!feedId) throw new HttpError(404, 'Media not found');
    const [owned] = await sql`SELECT 1 FROM feeds WHERE id = ${feedId} AND user_id = ${c.var.user.id}`;
    if (!owned) throw new HttpError(404, 'Media not found');

    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, 'Media file missing');
    return c.body(await readFile(filePath), 200, { 'content-type': 'audio/mpeg' });
  });

  return r;
}
