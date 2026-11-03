import { randomUUID } from 'node:crypto';
import { createSql, type Sql } from '../../src/db/sql.js';

export const USER_A_ID = '11111111-1111-1111-1111-111111111111';
export const USER_B_ID = '22222222-2222-2222-2222-222222222222';

export interface Seeded {
  user_a: string;
  user_b: string;
  workspace_a: string;
  workspace_b: string;
  feed_a: string;
  feed_b: string;
  paper_a: string;
  paper_b: string;
}

let shared: Sql | undefined;

/** Lazily created per-process client for the test database (DATABASE_URL set by test/setup.ts). */
export function testSql(): Sql {
  shared ??= createSql(process.env.DATABASE_URL!, { max: 5 });
  return shared;
}

export function dbName(): string {
  return decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1));
}

/** A uniquely named empty database on the test server. */
export async function createScratchDb(): Promise<{ url: string; drop(): Promise<void> }> {
  const sql = testSql();
  const name = `scratch_${randomUUID().replace(/-/g, '')}`;
  await sql`CREATE DATABASE ${sql(name)}`;
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    async drop() {
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`;
      await sql`DROP DATABASE IF EXISTS ${sql(name)}`;
    },
  };
}

/** Empties every public table except personas and schema_migrations. */
export async function resetDb(sql: Sql): Promise<void> {
  const rows = await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('personas', 'schema_migrations')`;
  if (rows.length > 0) {
    const list = rows.map((r) => `"${String(r.tablename).replace(/"/g, '""')}"`).join(', ');
    // Identifiers come from the catalog, not user input; TRUNCATE can't take parameters.
    await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }
  // pg-boss jobs and schedules go; queues stay.
  const [boss] = await sql`SELECT to_regclass('pgboss.job') AS j, to_regclass('pgboss.schedule') AS s`;
  if (boss!.j) await sql.unsafe('DELETE FROM pgboss.job');
  if (boss!.s) await sql.unsafe('DELETE FROM pgboss.schedule');
}

/** Mirrors the seeded_users fixture in api/tests/conftest.py: two users, each with a workspace, feed and paper. */
export async function seedUsers(sql: Sql): Promise<Seeded> {
  const s: Seeded = {
    user_a: USER_A_ID,
    user_b: USER_B_ID,
    workspace_a: randomUUID(),
    workspace_b: randomUUID(),
    feed_a: randomUUID(),
    feed_b: randomUUID(),
    paper_a: randomUUID(),
    paper_b: randomUUID(),
  };
  await sql`
    INSERT INTO users (id, email) VALUES
      (${s.user_a}, 'auth-test-a@ficino.dev'), (${s.user_b}, 'auth-test-b@ficino.dev')
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO corpora (id, user_id, name) VALUES
      (${s.workspace_a}, ${s.user_a}, 'A-ws'), (${s.workspace_b}, ${s.user_b}, 'B-ws')`;
  await sql`
    INSERT INTO feeds (id, user_id, corpus_id, posts, post_count) VALUES
      (${s.feed_a}, ${s.user_a}, ${s.workspace_a}, '[]'::jsonb, 0),
      (${s.feed_b}, ${s.user_b}, ${s.workspace_b}, '[]'::jsonb, 0)`;
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status) VALUES
      (${s.paper_a}, ${s.user_a}, ${s.workspace_a}, 'a.pdf', '/tmp/a.pdf', 'complete'),
      (${s.paper_b}, ${s.user_b}, ${s.workspace_b}, 'b.pdf', '/tmp/b.pdf', 'complete')`;
  return s;
}
