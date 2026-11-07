import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import { migrationVersions } from '../db/migrate.js';
import type { Sql } from '../db/sql.js';
import { DEFAULT_WORKSPACE_ID, STUB_USER_ID } from '../shared/constants.js';
import { cleanupRestoredData, type CleanupReport, type RestoreDb } from './cleanup.js';
import { parseDump, publicBlocks, type CopyBlock } from './dump.js';
import { RestoreError } from './errors.js';

/**
 * Public tables a restore never loads or requires empty: the target's persona seed and migration ledger win, and the
 * TS-only tables (sessions, rate limits, job progress) have no archived data. Every other public table is restored.
 */
export const NOT_RESTORED_TABLES: ReadonlySet<string> = new Set([
  'personas',
  'schema_migrations',
  'sessions',
  'rate_limits',
  'job_progress',
]);

/**
 * Reference columns the baseline leaves without a foreign key, checked like one. Keys match
 * `orphanReferenceCounts`'s `<table>.<column>`.
 */
const UNENFORCED_REFERENCES: readonly Reference[] = [
  { table: 'post_replies', columns: ['persona_key'], parentSchema: 'public', parentTable: 'personas', parentColumns: ['key'] },
  { table: 'user_likes', columns: ['persona_key'], parentSchema: 'public', parentTable: 'personas', parentColumns: ['key'] },
];

/** The archive's ids the re-key replaces or removes. */
export type RestoreIds = {
  owner: string;
  orphans: string[];
  /** The orphans' corpora, deleted with them. */
  orphanCorpora: string[];
  sourceDefaultCorpus: string;
};

export type RestoreReport = {
  dryRun: boolean;
  /** Rows loaded per public table, as the dump had them. */
  loaded: Record<string, number>;
  /** Schemas with COPY data that were not loaded (auth, storage, …). */
  skippedSchemas: string[];
  /** Public tables with COPY data that were not loaded (the persona seed and the migration ledger win). */
  skippedTables: string[];
  ids: RestoreIds;
  cleanup: CleanupReport;
  /** Rows per restored table after the re-key and cleanup. */
  counts: Record<string, number>;
};

type Reference = { table: string; columns: string[]; parentSchema: string; parentTable: string; parentColumns: string[] };

/** Identifiers in `unsafe` text come only from the catalog or the dump's header; always quoted. */
const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const listing = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');

const nonZero = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

async function publicTables(sql: RestoreDb): Promise<string[]> {
  const rows = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  return rows.map((r) => r.tablename as string);
}

/** Every public table the restore loads and requires empty: all of them except `NOT_RESTORED_TABLES`. */
export async function restoredTables(sql: RestoreDb): Promise<string[]> {
  return (await publicTables(sql)).filter((t) => !NOT_RESTORED_TABLES.has(t));
}

/** Public base tables with a column of this name. */
async function tablesWithColumn(sql: RestoreDb, column: string): Promise<string[]> {
  const rows = await sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = ${column} AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name`;
  return rows.map((r) => r.table_name as string);
}

async function rowCount(sql: RestoreDb, table: string): Promise<number> {
  const [r] = await sql`SELECT count(*)::int AS n FROM ${sql(table)}`;
  return r!.n as number;
}

/**
 * The target must be fully migrated (`schema_migrations` equals the migration files) and hold no restorable data,
 * except the stub user and its empty Default workspace that an early API boot creates (`stubToReplace: true`: the
 * restore deletes and replaces them). Rows in a table the restore does not load but which name a user (sessions)
 * also count as data. Read-only; throws `RestoreError` naming the tables and counts.
 */
export async function assertRestorable(sql: RestoreDb, migrationsDir?: string): Promise<{ stubToReplace: boolean }> {
  const prefix = 'schema_migrations does not match the migrations';
  const [ledger] = await sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`;
  if (!ledger!.present) throw new RestoreError(`${prefix}: the table is missing (run the migrations first)`);
  const applied = (await sql`SELECT version FROM schema_migrations ORDER BY version`).map((r) => r.version as string);
  const expected = await migrationVersions(migrationsDir);
  const missing = expected.filter((v) => !applied.includes(v));
  const unexpected = applied.filter((v) => !expected.includes(v));
  if (missing.length > 0 || unexpected.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (unexpected.length > 0) parts.push(`unexpected ${unexpected.join(', ')}`);
    throw new RestoreError(`${prefix}: ${parts.join('; ')}`);
  }

  const restored = await restoredTables(sql);
  const data: Record<string, number> = {};
  for (const t of restored) data[t] = await rowCount(sql, t);
  for (const t of await tablesWithColumn(sql, 'user_id')) {
    if (restored.includes(t)) continue;
    const [r] = await sql`SELECT count(*)::int AS n FROM ${sql(t)} WHERE user_id IS NOT NULL`;
    data[t] = r!.n as number;
  }
  const found = nonZero(data);
  const tables = Object.keys(found);
  if (tables.length === 0) return { stubToReplace: false };

  if (tables.every((t) => t === 'users' || t === 'corpora')) {
    const users = await sql`SELECT id::text FROM users`;
    const corpora = await sql`SELECT id::text, user_id::text FROM corpora`;
    const onlyStub = users.length === 1 && users[0]!.id === STUB_USER_ID;
    const onlyDefault = corpora.every((c) => c.id === DEFAULT_WORKSPACE_ID && c.user_id === STUB_USER_ID);
    if (onlyStub && onlyDefault) return { stubToReplace: true };
  }
  throw new RestoreError(`target database is not empty: ${listing(found)}`);
}

/**
 * Every dump block must load into an existing, restorable table, and every column in its list must exist and not be
 * generated. One error names every problem.
 */
async function assertLoadable(sql: RestoreDb, blocks: CopyBlock[]): Promise<void> {
  const rows = await sql`
    SELECT table_name, column_name, is_generated FROM information_schema.columns WHERE table_schema = 'public'`;
  const schema = new Map<string, Map<string, boolean>>();
  for (const r of rows) {
    const cols = schema.get(r.table_name as string) ?? new Map<string, boolean>();
    cols.set(r.column_name as string, r.is_generated === 'ALWAYS');
    schema.set(r.table_name as string, cols);
  }
  const missingTables = new Set<string>();
  const notRestored = new Set<string>();
  const missingColumns = new Set<string>();
  const generated = new Set<string>();
  for (const b of blocks) {
    const cols = schema.get(b.table);
    if (!cols) {
      missingTables.add(b.table);
      continue;
    }
    if (NOT_RESTORED_TABLES.has(b.table)) {
      notRestored.add(b.table);
      continue;
    }
    for (const c of b.columns) {
      if (!cols.has(c)) missingColumns.add(`${b.table}.${c}`);
      else if (cols.get(c)) generated.add(`${b.table}.${c}`);
    }
  }
  const parts: string[] = [];
  const add = (label: string, set: Set<string>) => {
    if (set.size > 0) parts.push(`${label}: ${[...set].sort().join(', ')}`);
  };
  add('dump tables missing from the schema', missingTables);
  add('dump has data for tables the restore does not load', notRestored);
  add('dump columns missing from the schema', missingColumns);
  add('dump writes generated columns', generated);
  if (parts.length > 0) throw new RestoreError(parts.join('; '));
}

async function copyBlock(tx: RestoreDb, block: CopyBlock): Promise<void> {
  const columns = block.columns.map(ident).join(', ');
  const writable = await tx.unsafe(`COPY "public".${ident(block.table)} (${columns}) FROM STDIN`).writable();
  await pipeline(Readable.from(block.rows.map((r) => `${r}\n`)), writable);
}

/**
 * The archive's ids, discovered from the loaded rows: the owner is the one user owning any paper or feed; every other
 * user is an orphan that may own only corpora holding nothing (checked over every `user_id` and `corpus_id` column);
 * the source Default is the owner's one corpus named `Default`. Anything else throws `RestoreError`.
 */
export async function discoverIds(tx: RestoreDb): Promise<RestoreIds> {
  const owners = await tx`
    SELECT user_id::text AS id FROM papers WHERE user_id IS NOT NULL
    UNION SELECT user_id::text FROM feeds WHERE user_id IS NOT NULL
    ORDER BY 1`;
  if (owners.length !== 1) throw new RestoreError(`expected exactly one owner, found ${owners.length}`);
  const owner = owners[0]!.id as string;
  const [ownerRow] = await tx`SELECT count(*)::int AS n FROM users WHERE id = ${owner}`;
  if (ownerRow!.n !== 1) throw new RestoreError(`owner ${owner} has no users row`);

  const orphans = (await tx`SELECT id::text FROM users WHERE id <> ${owner} ORDER BY id`).map((r) => r.id as string);
  const userTables = (await tablesWithColumn(tx, 'user_id')).filter((t) => t !== 'corpora');
  const corpusTables = await tablesWithColumn(tx, 'corpus_id');
  const orphanCorpora: string[] = [];
  for (const orphan of orphans) {
    let owned = 0;
    for (const t of userTables) {
      const [r] = await tx`SELECT count(*)::int AS n FROM ${tx(t)} WHERE user_id = ${orphan}`;
      owned += r!.n as number;
    }
    const corpora = (await tx`SELECT id::text FROM corpora WHERE user_id = ${orphan} ORDER BY id`).map(
      (r) => r.id as string,
    );
    for (const t of corpusTables) {
      const [r] = await tx`SELECT count(*)::int AS n FROM ${tx(t)} WHERE corpus_id = ANY(${corpora}::uuid[])`;
      owned += r!.n as number;
    }
    if (owned > 0) throw new RestoreError(`user ${orphan} owns data`);
    orphanCorpora.push(...corpora);
  }

  const defaults = await tx`SELECT id::text FROM corpora WHERE user_id = ${owner} AND name = 'Default'`;
  if (defaults.length !== 1) {
    throw new RestoreError(`expected exactly one corpus named Default for the owner, found ${defaults.length}`);
  }
  const sourceDefaultCorpus = defaults[0]!.id as string;

  if (owner === STUB_USER_ID || orphans.includes(STUB_USER_ID)) {
    throw new RestoreError('the dump already contains the stub user id');
  }
  const [taken] = await tx`SELECT count(*)::int AS n FROM corpora WHERE id = ${DEFAULT_WORKSPACE_ID}`;
  if (sourceDefaultCorpus !== DEFAULT_WORKSPACE_ID && (taken!.n as number) > 0) {
    throw new RestoreError('the dump already contains the default workspace id');
  }
  return { owner, orphans, orphanCorpora: orphanCorpora.sort(), sourceDefaultCorpus };
}

/** Every foreign key on a `public` table, from the catalog. */
async function foreignKeys(sql: RestoreDb): Promise<Reference[]> {
  const rows = await sql`
    SELECT cl.relname AS table,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS columns,
           pn.nspname AS parent_schema, pl.relname AS parent_table,
           ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o) AS parent_columns
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class pl ON pl.oid = c.confrelid
    JOIN pg_namespace pn ON pn.oid = pl.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
    ORDER BY cl.relname, c.conname`;
  return rows.map((r) => ({
    table: r.table as string,
    columns: r.columns as string[],
    parentSchema: r.parent_schema as string,
    parentTable: r.parent_table as string,
    parentColumns: r.parent_columns as string[],
  }));
}

const refKey = (ref: Reference): string => `${ref.table}.${ref.columns.join(',')}`;

/**
 * Per reference `<table>.<column>`, the child rows whose non-null key has no parent row: every foreign key on a
 * `public` table (from `pg_constraint`), plus the persona-key columns the baseline leaves unenforced. Every entry is
 * present, zero or not. The load runs with foreign-key triggers off, so this is what stands in for them.
 */
export async function orphanReferenceCounts(sql: RestoreDb): Promise<Record<string, number>> {
  const refs = await foreignKeys(sql);
  const seen = new Set(refs.map(refKey));
  for (const extra of UNENFORCED_REFERENCES) {
    if (seen.has(refKey(extra))) continue;
    const [present] = await sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${extra.table} AND column_name = ${extra.columns[0]!}`;
    if ((present!.n as number) > 0) refs.push(extra);
  }
  const out: Record<string, number> = {};
  for (const ref of refs) {
    const notNull = ref.columns.map((c) => `c.${ident(c)} IS NOT NULL`).join(' AND ');
    const match = ref.columns.map((c, i) => `p.${ident(ref.parentColumns[i]!)} = c.${ident(c)}`).join(' AND ');
    const [r] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM "public".${ident(ref.table)} c
       WHERE ${notNull}
         AND NOT EXISTS (SELECT 1 FROM ${ident(ref.parentSchema)}.${ident(ref.parentTable)} p WHERE ${match})`,
    );
    const key = refKey(ref);
    out[key] = (out[key] ?? 0) + (r!.n as number);
  }
  return out;
}

/**
 * Per `public` table, the rows whose JSON text (`to_jsonb(t)::text`) still contains the owner, an orphan, an orphan's
 * corpus or the source Default corpus id, wherever it sits. Non-zero tables only.
 */
export async function sourceIdCounts(sql: RestoreDb, ids: RestoreIds): Promise<Record<string, number>> {
  const patterns = [ids.owner, ...ids.orphans, ...ids.orphanCorpora, ids.sourceDefaultCorpus].map(
    (id) => `%${id.toLowerCase()}%`,
  );
  const out: Record<string, number> = {};
  for (const t of await publicTables(sql)) {
    const [r] = await sql`
      SELECT count(*)::int AS n FROM ${sql(t)} x WHERE lower(to_jsonb(x)::text) LIKE ANY(${patterns}::text[])`;
    if ((r!.n as number) > 0) out[t] = r!.n as number;
  }
  return out;
}

/** Thrown inside the transaction to roll a dry run back after its report is built. */
class DryRunRollback extends Error {}

/**
 * Data-only restore of a plain-text pg_dump onto a freshly migrated database, in one transaction: preconditions; the
 * `public` COPY blocks (never auth, storage, personas or the migration ledger) loaded with foreign-key triggers off;
 * the orphans dropped; the owner re-keyed to the stub user and its Default corpus to the default workspace (every
 * `user_id` and `corpus_id` column, plus the ids inside `audit_log`); the cleanup; then every reference must resolve
 * and no row may still contain a source id, else `RestoreError` and nothing is written. `dryRun` rolls back after the
 * report. Logs counts only.
 */
export async function restoreDatabase(
  sql: Sql,
  dumpText: string,
  opts: { sourceEmbedModel: string; dryRun?: boolean; migrationsDir?: string; log?: Logger },
): Promise<RestoreReport> {
  const log = opts.log;
  await assertRestorable(sql, opts.migrationsDir);
  const all = parseDump(dumpText);
  const blocks = publicBlocks(all);
  const skippedSchemas = [...new Set(all.filter((b) => b.schema !== 'public').map((b) => b.schema))].sort();
  const skippedTables = [
    ...new Set(all.filter((b) => b.schema === 'public' && !blocks.includes(b)).map((b) => b.table)),
  ].sort();
  await assertLoadable(sql, blocks);
  const loaded: Record<string, number> = {};
  for (const b of blocks) loaded[b.table] = (loaded[b.table] ?? 0) + b.rows.length;
  log?.info({ loaded, skipped_schemas: skippedSchemas, skipped_tables: skippedTables }, 'restore_db_parsed');

  let report: RestoreReport | undefined;
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      // Again inside the transaction: an API that booted after the first check may have created the stub since.
      const { stubToReplace } = await assertRestorable(tx, opts.migrationsDir);
      if (stubToReplace) {
        await tx`DELETE FROM corpora WHERE id = ${DEFAULT_WORKSPACE_ID} AND user_id = ${STUB_USER_ID}`;
        await tx`DELETE FROM users WHERE id = ${STUB_USER_ID}`;
      }
      for (const b of blocks) await copyBlock(tx, b);

      const ids = await discoverIds(tx);
      await tx`DELETE FROM corpora WHERE user_id = ANY(${ids.orphans}::uuid[])`;
      await tx`DELETE FROM users WHERE id = ANY(${ids.orphans}::uuid[])`;

      // No foreign key cascades on update, and the triggers are off: every id column is re-keyed by hand.
      for (const t of await tablesWithColumn(tx, 'user_id')) {
        await tx`UPDATE ${tx(t)} SET user_id = ${STUB_USER_ID} WHERE user_id = ${ids.owner}`;
      }
      for (const t of await tablesWithColumn(tx, 'corpus_id')) {
        await tx`UPDATE ${tx(t)} SET corpus_id = ${DEFAULT_WORKSPACE_ID} WHERE corpus_id = ${ids.sourceDefaultCorpus}`;
      }
      await tx`UPDATE corpora SET id = ${DEFAULT_WORKSPACE_ID} WHERE id = ${ids.sourceDefaultCorpus}`;
      await tx`UPDATE users SET id = ${STUB_USER_ID}, clerk_id = 'stub' WHERE id = ${ids.owner}`;
      // audit_log keeps ids outside id columns.
      await tx`
        UPDATE audit_log SET metadata = jsonb_set(metadata, '{corpus_id}', to_jsonb(${DEFAULT_WORKSPACE_ID}::text))
        WHERE jsonb_typeof(metadata) = 'object' AND lower(metadata ->> 'corpus_id') = ${ids.sourceDefaultCorpus}`;
      await tx`UPDATE audit_log SET resource_id = ${DEFAULT_WORKSPACE_ID}
               WHERE lower(resource_id) = ${ids.sourceDefaultCorpus}`;
      await tx`UPDATE audit_log SET resource_id = ${STUB_USER_ID} WHERE lower(resource_id) = ${ids.owner}`;

      const cleanup = await cleanupRestoredData(tx, { sourceEmbedModel: opts.sourceEmbedModel, log });

      const dangling = nonZero(await orphanReferenceCounts(tx));
      if (Object.keys(dangling).length > 0) throw new RestoreError(`orphan references: ${listing(dangling)}`);
      const remaining = await sourceIdCounts(tx, ids);
      if (Object.keys(remaining).length > 0) throw new RestoreError(`source ids remain: ${listing(remaining)}`);

      const counts: Record<string, number> = {};
      for (const t of await restoredTables(tx)) counts[t] = await rowCount(tx, t);
      report = { dryRun: opts.dryRun === true, loaded, skippedSchemas, skippedTables, ids, cleanup, counts };
      log?.info({ dry_run: report.dryRun, orphans: ids.orphans.length, counts }, 'restore_db');
      if (opts.dryRun) throw new DryRunRollback('dry run');
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report!;
}
