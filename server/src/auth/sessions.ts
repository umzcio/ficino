import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '../db/sql.js';

export const SESSION_TTL_SECONDS = 604800; // 7 days

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Returns a 43-char base64url token; only sha256(token) is stored. */
export async function createSession(sql: Sql, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, now() + ${SESSION_TTL_SECONDS} * interval '1 second')`;
  return token;
}

/** A hit slides expires_at to now + 7 days; an expired row is deleted and reported as 'expired'. */
export async function lookupSession(
  sql: Sql,
  token: string,
): Promise<{ userId: string } | 'expired' | null> {
  const h = hashToken(token);
  const [hit] = await sql`
    UPDATE sessions SET expires_at = now() + ${SESSION_TTL_SECONDS} * interval '1 second'
    WHERE token_hash = ${h} AND expires_at > now()
    RETURNING user_id`;
  if (hit) return { userId: String(hit.user_id) };
  const gone = await sql`DELETE FROM sessions WHERE token_hash = ${h} RETURNING 1`;
  return gone.length > 0 ? 'expired' : null;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
}
