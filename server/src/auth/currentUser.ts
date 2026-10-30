import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app.js';
import { HttpError } from '../http/errors.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { lookupSession } from './sessions.js';
import type { AuthUser } from './types.js';

export const SESSION_COOKIE = 'ficino_session';

const STUB_USER: AuthUser = { id: STUB_USER_ID, email: 'stub@ficino.dev', display_name: 'You' };

/** Session-cookie lookup (Python get_user_basic). Also used directly by /auth/logout and /auth/me. */
export async function getUserBasic(c: Context<AppEnv>): Promise<AuthUser> {
  const { sql } = c.var.deps;
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'Not authenticated');
  const session = await lookupSession(sql, token);
  if (session === null || session === 'expired') throw new HttpError(401, 'Session expired');
  const [row] = await sql`SELECT id, email, display_name FROM users WHERE id = ${session.userId}`;
  if (!row) throw new HttpError(401, 'User not found');
  return { id: String(row.id), email: row.email, display_name: row.display_name };
}

/** Sets c.var.user from deps.userOverride (tests) or the configured provider. */
export function currentUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { userOverride, config } = c.var.deps;
    if (userOverride) c.set('user', userOverride);
    else if (config.authProvider === 'none') c.set('user', STUB_USER);
    else c.set('user', await getUserBasic(c));
    await next();
  };
}

/** Apply per protected router: `router.use('*', requireUser)`. */
export const requireUser: MiddlewareHandler<AppEnv> = currentUser();
