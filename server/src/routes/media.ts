import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { HttpError } from '../http/errors.js';
import { tokenQuery } from '../http/tokenQuery.js';
import { verifyToken } from '../shared/signedUrl.js';

const FEED_ID_IN_KEY = /^feeds\/([^/]+)\//;

/** One `bytes=a-b`, `bytes=a-` or `bytes=-n` range; decimal digits only. Range units compare case-insensitively (RFC 9110 §14.1). */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;

export type ByteRange = { start: number; end: number };

/**
 * Deliberate change 8: the `Range` header against a file of `size` bytes.
 * - `null`: no header, another unit, several ranges, or a malformed one (`a > b` included): serve the whole file.
 * - `'unsatisfiable'`: `a >= size`, `bytes=-0`, or any range on an empty file: 416.
 * - otherwise the inclusive range, with `0 <= start <= end <= size - 1`.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const m = SINGLE_RANGE.exec(header);
  if (!m) return null;
  const a = m[1]!;
  const b = m[2]!;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && start > Number(b)) return null;
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return { start, end };
}

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
    const size = st.size;

    // Deliberate change 8: single byte ranges, so Safari can play and every browser can seek.
    const range = parseRange(c.req.header('range'), size);
    if (range === 'unsatisfiable') return c.body(null, 416, { 'content-range': `bytes */${size}` });
    const status = range === null ? 200 : 206;
    const headers: Record<string, string> = {
      'accept-ranges': 'bytes',
      'content-type': 'audio/mpeg',
      'content-length': String(range === null ? size : range.end - range.start + 1),
    };
    if (range !== null) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;

    // Hono answers HEAD with `new Response(null, <the GET response>)`, which never consumes or cancels the body,
    // so a stream opened here would leak its file descriptor. HEAD gets the status and headers without one.
    if (c.req.method === 'HEAD') return c.body(null, status, headers);

    const stream = createReadStream(filePath, range === null ? {} : { start: range.start, end: range.end });
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream, status, headers);
  });

  return r;
}
