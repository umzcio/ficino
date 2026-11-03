import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { HttpError } from '../http/errors.js';
import { verifyToken } from '../shared/signedUrl.js';

/**
 * `token: str = Query(..., min_length=10, max_length=200)`: the token, or a pydantic-shaped 422 Response.
 * Lengths count code points, like Python.
 */
export function tokenQuery(c: Context<AppEnv>): string | Response {
  const value = c.req.query('token');
  const loc = ['query', 'token'];
  if (value === undefined) {
    return c.json({ detail: [{ type: 'missing', loc, msg: 'Field required', input: null }] }, 422);
  }
  const len = [...value].length;
  if (len < 10) {
    return c.json(
      {
        detail: [
          { type: 'string_too_short', loc, msg: 'String should have at least 10 characters', input: value, ctx: { min_length: 10 } },
        ],
      },
      422,
    );
  }
  if (len > 200) {
    return c.json(
      {
        detail: [
          { type: 'string_too_long', loc, msg: 'String should have at most 200 characters', input: value, ctx: { max_length: 200 } },
        ],
      },
      422,
    );
  }
  return value;
}

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

    return c.body(await readFile(fullPath), 200, { 'content-type': 'image/png' });
  });

  return r;
}
