// Restore the archived SaaS data into a freshly migrated TS database and its storage volumes.
//   node dist/restore/cli.js db --dump <file> --source-embed-model <id> [--dry-run]
//   node dist/restore/cli.js files --bucket <dir> --manifest <file> [--chown <uid>:<gid>] [--dry-run]
//   node dist/restore/cli.js verify [--embed-model <id>] [--owner <uid>:<gid>]
// stdout carries exactly one JSON object (the report) and a newline, so `cli.js … > report.json` parses; logs (pino
// JSON, counts only) and errors (the message only: no stack, no row content) go to stderr. Exit 0 on success, 1 on any
// error, a failed verify check, or (files) a restored row left without its file.
import { readFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import pino from 'pino';
import postgres from 'postgres';
import { loadConfig } from '../config.js';
import { createSql, type Sql } from '../db/sql.js';
import type { StorageDirs } from '../storage/local.js';
import { restoreDatabase } from './database.js';
import { RestoreError } from './errors.js';
import { copyStorage, parseManifest, planStorageCopy } from './files.js';
import { verifyRestore } from './verify.js';

const USAGE = `usage: cli.js db --dump <file> --source-embed-model <id> [--dry-run]
       cli.js files --bucket <dir> --manifest <file> [--chown <uid>:<gid>] [--dry-run]
       cli.js verify [--embed-model <id>] [--owner <uid>:<gid>]`;

// src/logger.ts writes to stdout, which is reserved for the report: everything here logs through this one.
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

/** A bad command line: the message is printed with the usage. */
class UsageError extends Error {}

type Ids = { uid: number; gid: number };

function ids(flag: string, value: string | undefined): Ids | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d+):(\d+)$/.exec(value);
  if (!m) throw new UsageError(`${flag} must be <uid>:<gid> (numbers), got ${JSON.stringify(value)}`);
  return { uid: Number(m[1]), gid: Number(m[2]) };
}

function required(flag: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new UsageError(`${flag} is required`);
  return value;
}

type Values = Record<string, string | boolean | undefined>;

function args(argv: string[], options: ParseArgsOptionsConfig): Values {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values as Values;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

function emit(report: unknown): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

/** Connects with the env's `DATABASE_URL` and storage dirs, runs `fn`, and always closes the pool. */
async function withDb<T>(fn: (sql: Sql, dirs: StorageDirs) => Promise<T>): Promise<T> {
  const config = loadConfig(process.env, log);
  const sql = createSql(config.databaseUrl, { max: 2 });
  try {
    return await fn(sql, { uploadDir: config.uploadDir, figuresDir: config.figuresDir, mediaDir: config.mediaDir });
  } finally {
    await sql.end();
  }
}

async function db(argv: string[]): Promise<number> {
  const v = args(argv, {
    dump: { type: 'string' },
    'source-embed-model': { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  const dump = required('--dump', v.dump as string | undefined);
  // Never guessed: the tag says which model made the archived vectors until the re-embed replaces them.
  const sourceEmbedModel = required('--source-embed-model', v['source-embed-model'] as string | undefined);
  const text = await readFile(dump, 'utf8');
  const report = await withDb((sql) =>
    restoreDatabase(sql, text, { sourceEmbedModel, dryRun: v['dry-run'] === true, log }),
  );
  emit(report);
  return 0;
}

async function files(argv: string[]): Promise<number> {
  const v = args(argv, {
    bucket: { type: 'string' },
    manifest: { type: 'string' },
    chown: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  const bucket = required('--bucket', v.bucket as string | undefined);
  const manifestPath = required('--manifest', v.manifest as string | undefined);
  const chown = ids('--chown', v.chown as string | undefined);
  const dryRun = v['dry-run'] === true;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    if (e instanceof SyntaxError) throw new RestoreError('manifest: not valid JSON');
    throw e;
  }
  const manifest = parseManifest(raw);

  const { plan, copied } = await withDb(async (sql, dirs) => {
    const plan = await planStorageCopy(sql, bucket, manifest, dirs);
    // A dry run stops at the plan: nothing is copied or chowned.
    const copied = dryRun ? 0 : (await copyStorage(plan, dirs, { chown })).copied;
    return { plan, copied };
  });
  log.info(
    {
      dry_run: dryRun,
      copies: plan.copies.length,
      skipped: plan.skipped.length,
      missing: plan.missing.length,
      copied,
      chown: chown !== undefined && !dryRun,
    },
    'restore_files',
  );
  emit({ copies: plan.copies, skipped: plan.skipped, missing: plan.missing, copied });
  if (plan.missing.length > 0) {
    const n = plan.missing.length;
    process.stderr.write(`restore files: ${n} restored ${n === 1 ? 'row has' : 'rows have'} no file (see "missing")\n`);
    return 1;
  }
  return 0;
}

async function verify(argv: string[]): Promise<number> {
  const v = args(argv, { 'embed-model': { type: 'string' }, owner: { type: 'string' } });
  const embedModel = v['embed-model'] as string | undefined;
  const owner = ids('--owner', v.owner as string | undefined);
  const result = await withDb((sql, dirs) => verifyRestore(sql, dirs, { embedModel, owner }));
  const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
  log.info({ ok: result.ok, failed }, 'restore_verify');
  emit(result);
  if (!result.ok) {
    process.stderr.write(`restore verify failed: ${failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

/**
 * What stderr says about an error: its message, except that a database error's quoted values (which can be row
 * content, e.g. `invalid input syntax for type uuid: "…"`) are elided.
 */
function describeError(e: unknown): string {
  if (e instanceof postgres.PostgresError) {
    return `database error ${e.code}: ${e.message.replace(/"[^"]*"/g, '"…"')}`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'db':
      return db(rest);
    case 'files':
      return files(rest);
    case 'verify':
      return verify(rest);
    default:
      throw new UsageError(command === undefined ? 'a command is required' : `unknown command ${JSON.stringify(command)}`);
  }
}

const command = process.argv[2] ?? '';
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  const prefix = ['db', 'files', 'verify'].includes(command) ? `restore ${command} failed` : 'restore failed';
  process.stderr.write(`${prefix}: ${describeError(e)}\n`);
  if (e instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}
