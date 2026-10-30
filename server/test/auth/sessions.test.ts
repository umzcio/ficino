import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession, deleteSession, lookupSession, SESSION_TTL_SECONDS } from '../../src/auth/sessions.js';
import { resetDb, seedUsers, testSql, USER_A_ID } from '../helpers/db.js';

const sql = testSql();

beforeEach(async () => {
  await resetDb(sql);
  await seedUsers(sql);
});

describe('sessions', () => {
  it('TTL constant is 7 days', () => expect(SESSION_TTL_SECONDS).toBe(604800));

  it('createSession returns a 43-char base64url token and stores only sha256(token)', async () => {
    const token = await createSession(sql, USER_A_ID);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await sql`SELECT token_hash FROM sessions`;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0].token_hash).not.toBe(token);
  });

  it('lookup hit returns the user and slides expires_at to ~7 days', async () => {
    const token = await createSession(sql, USER_A_ID);
    await sql`UPDATE sessions SET expires_at = now() + interval '1 day'`;
    expect(await lookupSession(sql, token)).toEqual({ userId: USER_A_ID });
    const [r] = await sql`SELECT expires_at > now() + interval '6 days 23 hours' AS ok FROM sessions`;
    expect(r.ok).toBe(true);
  });

  it('unknown token is null', async () => {
    expect(await lookupSession(sql, 'nope')).toBeNull();
  });

  it('expired row returns "expired" and is deleted; a second lookup is null', async () => {
    const token = await createSession(sql, USER_A_ID);
    await sql`UPDATE sessions SET expires_at = now() - interval '1 second'`;
    expect(await lookupSession(sql, token)).toBe('expired');
    expect(await sql`SELECT 1 FROM sessions`).toHaveLength(0);
    expect(await lookupSession(sql, token)).toBeNull();
  });

  it('deleteSession removes the row; deleting a user cascades to sessions', async () => {
    const t1 = await createSession(sql, USER_A_ID);
    await deleteSession(sql, t1);
    expect(await lookupSession(sql, t1)).toBeNull();
    await createSession(sql, USER_A_ID);
    await sql`DELETE FROM users WHERE id = ${USER_A_ID}`;
    expect(await sql`SELECT 1 FROM sessions`).toHaveLength(0);
  });
});
