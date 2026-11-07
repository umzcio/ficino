import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './sql.js';

const LOCK_KEY = 727274;
const FILE_RE = /^\d{4}_.*\.sql$/;

// src/db -> server/migrations; dist/db -> /app/migrations
const DEFAULT_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

async function migrationFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
}

const versionOf = (file: string): string => file.slice(0, 4);

/** The sorted 4-character versions `migrate()` records for `dir` (one per migration file). */
export async function migrationVersions(dir: string = DEFAULT_DIR): Promise<string[]> {
  return (await migrationFiles(dir)).map(versionOf);
}

/** Applies pending migrations in name order and returns the versions applied. */
export async function migrate(sql: Sql, dir: string = DEFAULT_DIR): Promise<string[]> {
  const max = sql.options.max;
  if (typeof max === 'number' && max < 2) {
    throw new Error(`migrate needs a pool of at least 2 connections (got ${max})`);
  }
  const files = await migrationFiles(dir);
  const applied: string[] = [];
  // Advisory locks are per-session: hold one reserved connection for the whole run,
  // while each file's transaction uses another pool connection (so max must be >= 2).
  const conn = await sql.reserve();
  let failure: { err: unknown } | undefined;
  try {
    await conn`SELECT pg_advisory_lock(${LOCK_KEY})`;
    try {
      await conn`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      const done = new Set((await conn`SELECT version FROM schema_migrations`).map((r) => r.version as string));
      for (const file of files) {
        const version = versionOf(file);
        if (done.has(version)) continue;
        const text = await readFile(join(dir, file), 'utf8');
        await sql.begin(async (tx) => {
          await tx.unsafe(text);
          await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
        });
        applied.push(version);
      }
    } catch (err) {
      failure = { err };
      throw err;
    } finally {
      try {
        await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`;
      } catch (unlockErr) {
        // A dead connection drops the session lock anyway; never mask the migration's own error.
        if (!failure) throw unlockErr;
        console.error('migrate: advisory unlock failed after migration error:', unlockErr);
      }
    }
  } finally {
    conn.release();
  }
  return applied;
}
