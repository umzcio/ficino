import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createSql, type Sql } from '../../src/db/sql.js';
import { createScratchDb } from '../helpers/db.js';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const VERSIONS = (await readdir(MIGRATIONS_DIR))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .map((f) => f.slice(0, 4))
  .sort();

const TABLES = [
  'alerts', 'annotations', 'audit_log', 'bookmarks', 'chunks', 'corpora', 'corpus_syntheses',
  'feed_posts', 'feeds', 'figures', 'job_progress', 'paper_summaries', 'paper_tags', 'papers', 'persona_dms',
  'personas', 'post_replies', 'rate_limits', 'reading_list_chapters', 'reading_lists', 'sessions', 'tags', 'user_likes',
  'user_posts', 'user_settings', 'users',
];

let scratch: Awaited<ReturnType<typeof createScratchDb>>;
let sql: Sql;
let first: string[];
let second: string[];

beforeAll(async () => {
  scratch = await createScratchDb();
  sql = createSql(scratch.url, { max: 2 });
  first = await migrate(sql);
  second = await migrate(sql);
});

afterAll(async () => {
  await sql?.end();
  await scratch?.drop();
});

it('applies every migration once, then nothing', () => {
  expect(first).toEqual(VERSIONS);
  expect(second).toEqual([]);
});

it('creates the 26 public tables (23 baseline + sessions + rate_limits + job_progress)', async () => {
  const rows = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1`;
  expect(rows.map((r) => r.tablename)).toEqual(TABLES);
});

it('seeds 7 personas', async () => {
  const [r] = await sql`SELECT count(*)::int AS n FROM personas`;
  expect(r!.n).toBe(7);
});

it('chunks has exactly one unique index on (paper_id, chunk_index)', async () => {
  const rows = await sql`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'chunks' AND indexdef LIKE 'CREATE UNIQUE%'`;
  const matching = rows.filter((r) => /\(paper_id, chunk_index\)/.test(r.indexdef));
  expect(matching).toHaveLength(1);
});

it('drops the duplicate indexes', async () => {
  const rows = await sql`
    SELECT conname AS n FROM pg_constraint WHERE conname IN
      ('chunks_paper_chunk_idx_uq','figures_paper_figure_idx_uq','post_replies_feed_post_uq')
    UNION ALL SELECT indexname FROM pg_indexes WHERE indexname = 'persona_dms_user_persona_idx'`;
  expect(rows).toHaveLength(0);
});

it('fills search_vector on chunk insert', async () => {
  const [u] = await sql`INSERT INTO users (email) VALUES ('m@x.dev') RETURNING id`;
  const [p] = await sql`INSERT INTO papers (user_id, filename, file_path) VALUES (${u!.id}, 'a.pdf', '/a.pdf') RETURNING id`;
  const [c] = await sql`
    INSERT INTO chunks (paper_id, user_id, section, content, chunk_index)
    VALUES (${p!.id}, ${u!.id}, 's', 'quantum entanglement', 0)
    RETURNING search_vector::text AS sv`;
  expect(c!.sv).toContain('entangl');
});

it('has the hnsw embedding index', async () => {
  const rows = await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'chunks_embedding_hnsw'`;
  expect(rows).toHaveLength(1);
});

it('throws immediately on a pool of 1 instead of deadlocking', async () => {
  const { createSql } = await import('../../src/db/sql.js');
  const tiny = createSql(process.env.DATABASE_URL!, { max: 1 });
  try {
    await expect(migrate(tiny)).rejects.toThrow('at least 2 connections');
  } finally {
    await tiny.end();
  }
});

it('concurrent migrate() calls on separate pools: one applies, the other waits and returns []', async () => {
  const db = await createScratchDb();
  const a = createSql(db.url, { max: 2 });
  const b = createSql(db.url, { max: 2 });
  try {
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    expect([ra, rb].map((r) => r.length).sort()).toEqual([0, VERSIONS.length]);
    const rows = await a`SELECT version FROM schema_migrations ORDER BY 1`;
    expect(rows.map((r) => r.version)).toEqual(VERSIONS);
  } finally {
    await a.end();
    await b.end();
    await db.drop();
  }
});

it('a failed unlock does not mask the migration error', async () => {
  const db = await createScratchDb();
  const s = createSql(db.url, { max: 2 });
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  // Kill the session holding the advisory lock (migrate's reserved connection), then fail.
  await writeFile(
    join(dir, '0001_boom.sql'),
    `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid();
     SELECT pg_sleep(0.3);
     DO $$ BEGIN RAISE EXCEPTION 'migration boom'; END $$;`,
  );
  try {
    await expect(migrate(s, dir)).rejects.toThrow('migration boom');
  } finally {
    await s.end({ timeout: 1 }).catch(() => undefined);
    await db.drop();
  }
});
