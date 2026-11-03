import type { Sql } from '../db/sql.js';

/** Deletes expired rate-limit windows and sessions, and job_progress rows pg-boss has already forgotten (8 days). */
export async function pruneExpired(sql: Sql): Promise<{ rate_limits: number; sessions: number; job_progress: number }> {
  const rl = await sql`DELETE FROM rate_limits WHERE window_ends_at < now()`;
  const se = await sql`DELETE FROM sessions WHERE expires_at < now()`;
  const jp = await sql`DELETE FROM job_progress WHERE created_at < now() - interval '8 days'`;
  return { rate_limits: rl.count, sessions: se.count, job_progress: jp.count };
}
