import type { Context } from 'hono';
import type { AppEnv } from '../app.js';

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
