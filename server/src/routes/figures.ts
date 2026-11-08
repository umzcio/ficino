import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { HttpError } from '../http/errors.js';
import { tokenQuery } from '../http/tokenQuery.js';
import { verifyToken } from '../shared/signedUrl.js';

export function figuresRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/:paper_id/:figure_id', async (c) => {
    const { sql, config, signingKey } = c.var.deps;
    const paperId = c.req.param('paper_id');
    const figureId = c.req.param('figure_id');
    const token = tokenQuery(c);
    if (typeof token !== 'string') return token;

    // 1) The token must cover this figure id and be unexpired (before any DB work).
    if (!verifyToken(signingKey, figureId, token)) throw new HttpError(403, 'Invalid or expired figure token');

    // 2) The paper must belong to the caller.
    const [row] = await sql`
      SELECT f.image_path FROM figures f
      JOIN papers p ON f.paper_id = p.id AND p.user_id = ${c.var.user.id}
      WHERE f.id = ${figureId} AND f.paper_id = ${paperId}`;
    if (!row) throw new HttpError(404, 'Figure not found');

    // 3) Rebuild the path from the route params and reject any escape.
    const stored: string = row.image_path ?? '';
    const filename = stored.slice(stored.lastIndexOf('/') + 1);
    if (!filename || filename.startsWith('.')) throw new HttpError(400, 'Invalid image path');
    if (!paperId || paperId.includes('/') || paperId.includes('..')) throw new HttpError(400, 'Invalid paper id');
    const base = resolve(config.figuresDir);
    const fullPath = resolve(base, paperId, filename);
    if (fullPath !== base && !fullPath.startsWith(base + sep)) throw new HttpError(400, 'Path escape detected');
    const st = await stat(fullPath).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, 'Figure file missing');

    // no-store: the service worker's figure cache (cleared on sign-out) is the
    // only client-side copy; the browser HTTP cache is beyond the app's reach.
    return c.body(await readFile(fullPath), 200, { 'content-type': 'image/png', 'cache-control': 'private, no-store' });
  });

  return r;
}
