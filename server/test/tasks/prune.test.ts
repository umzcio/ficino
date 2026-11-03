import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pruneExpired } from '../../src/tasks/prune.js';
import { resetDb, seedUsers, testSql, USER_A_ID } from '../helpers/db.js';

const sql = testSql();

beforeEach(async () => {
  await resetDb(sql);
  await seedUsers(sql);
});

describe('pruneExpired', () => {
  it('removes expired rows and keeps live ones', async () => {
    await sql`INSERT INTO rate_limits (key, count, window_ends_at) VALUES
      ('old', 1, now() - interval '1 minute'), ('live', 1, now() + interval '1 hour')`;
    await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES
      ('old', ${USER_A_ID}, now() - interval '1 minute'), ('live', ${USER_A_ID}, now() + interval '1 hour')`;
    const oldJob = randomUUID();
    const newJob = randomUUID();
    await sql`INSERT INTO job_progress (job_id, queue, created_at) VALUES
      (${oldJob}, 'process_paper', now() - interval '9 days'), (${newJob}, 'process_paper', now() - interval '7 days')`;

    expect(await pruneExpired(sql)).toEqual({ rate_limits: 1, sessions: 1, job_progress: 1 });

    expect((await sql`SELECT key FROM rate_limits`).map((r) => r.key)).toEqual(['live']);
    expect((await sql`SELECT token_hash FROM sessions`).map((r) => r.token_hash)).toEqual(['live']);
    expect((await sql`SELECT job_id FROM job_progress`).map((r) => r.job_id)).toEqual([newJob]);
  });
});
