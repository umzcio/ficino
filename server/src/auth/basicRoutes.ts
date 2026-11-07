import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { HttpError } from '../http/errors.js';
import { recordAudit } from '../audit.js';
import { ipRateLimit } from '../http/rateLimit.js';
import { body } from '../http/validate.js';
import { getUserBasic, SESSION_COOKIE } from './currentUser.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { createSession, deleteSession, SESSION_TTL_SECONDS } from './sessions.js';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Transaction-scoped advisory lock that serializes `/auth/register`, so two simultaneous first
 * registrations cannot both see an empty users table. Distinct from migrate.ts's 727274.
 */
export const REGISTER_LOCK_KEY = 727275;

// Login does not bound the password so older accounts can still authenticate.
const loginBody = z.object({ email: z.string(), password: z.string() });

// 12..72 characters (code points, like pydantic). Also <= 72 bytes: bcrypt truncates beyond that,
// and login rejects such passwords, so accepting one here would create an unusable account.
const registerBody = z.object({
  email: z.string(),
  password: z
    .string()
    .refine((s) => [...s].length >= 12, 'String should have at least 12 characters')
    .refine((s) => [...s].length <= 72, 'String should have at most 72 characters')
    .refine((s) => Buffer.byteLength(s, 'utf8') <= 72, 'Password must be at most 72 bytes'),
});

export function basicRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const setSessionCookie = (c: Parameters<typeof setCookie>[0], token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: c.var.deps.config.environment !== 'development',
      maxAge: SESSION_TTL_SECONDS,
      path: '/', // no Domain: COOKIE_DOMAIN is deliberately ignored (C §6 item 21)
    });

  r.post('/register', ipRateLimit('register', 3, 3600), body(registerBody), async (c) => {
    const { sql, config } = c.var.deps;
    const { email, password } = c.req.valid('json');

    let userId: string;
    try {
      // The count, the email check and both inserts run under one lock (Python left a window here
      // in which two first registrations both saw zero users). The hash is computed inside it so a
      // refused request costs no bcrypt, as before.
      userId = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${REGISTER_LOCK_KEY})`;
        const [{ n }] = await tx`SELECT COUNT(*)::int AS n FROM users`;
        if (n > 0 && !config.allowRegistration) throw new HttpError(403, 'Registration is disabled');

        const [existing] = await tx`SELECT id FROM users WHERE email = ${email}`;
        if (existing) throw new HttpError(409, 'Email already registered');

        const passwordHash = await hashPassword(password);
        const [row] = await tx`
          INSERT INTO users (email, password_hash) VALUES (${email}, ${passwordHash}) RETURNING id`;
        await tx`INSERT INTO corpora (user_id, name) VALUES (${row.id}, 'Default')`;
        return String(row.id);
      });
    } catch (e) {
      // A unique violation the lock did not prevent (e.g. a row written outside this route).
      if ((e as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new HttpError(409, 'Email already registered');
      }
      throw e;
    }

    setSessionCookie(c, await createSession(sql, userId));
    c.set('user', { id: userId, email, display_name: null });
    await recordAudit(c, {
      action: 'user.register',
      resourceType: 'user',
      resourceId: userId,
      metadata: { email },
      statusCode: 201,
    });
    return c.json({ status: 'registered', user_id: userId }, 201);
  });

  r.post('/login', ipRateLimit('login', 5, 900), body(loginBody), async (c) => {
    const { sql } = c.var.deps;
    const { email, password } = c.req.valid('json');

    const [row] = await sql`SELECT id, password_hash FROM users WHERE email = ${email}`;
    const ok = await verifyPassword(password, row?.password_hash ?? null);
    if (!row || !ok) throw new HttpError(401, 'Invalid email or password');

    const userId = String(row.id);
    setSessionCookie(c, await createSession(sql, userId));
    return c.json({ status: 'logged_in', user_id: userId });
  });

  r.post('/logout', async (c) => {
    const { sql } = c.var.deps;
    const user = await getUserBasic(c); // 401s as in Python; the session is deleted by token below
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(sql, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    c.set('user', user);
    await recordAudit(c, { action: 'user.logout', resourceType: 'user', resourceId: user.id });
    return c.json({ status: 'logged_out' });
  });

  r.get('/me', async (c) => {
    const user = await getUserBasic(c);
    return c.json({ id: user.id, email: user.email, display_name: user.display_name });
  });

  return r;
}
