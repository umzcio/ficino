import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createSql, type Sql } from '../../src/db/sql.js';
import type { ManifestEntry } from '../../src/restore/files.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import { createScratchDb } from '../helpers/db.js';
import {
  buildSyntheticDump,
  buildSyntheticStorage,
  SECRET_MARKER,
  SYN,
  SYNTHETIC_POST_COUNT,
  SYNTHETIC_STORAGE_KEYS as KEYS,
} from '../helpers/syntheticArchive.js';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_MODEL = 'voyage:voyage-4-large@1024';
const T = 30_000;

type Run = { code: number | null; stdout: string; stderr: string };

let scratch: Awaited<ReturnType<typeof createScratchDb>>;
let sql: Sql;
let base: string;
let dumpPath: string;
let manifestPath: string;
let bucket: string;
let manifest: ManifestEntry[];
let out: { uploads: string; figures: string; media: string };
/** Every run's output in this test, for the secret sweep. */
let runs: Run[];

/** Runs the CLI from source with only the env it needs. */
function runCli(args: string[]): Promise<Run> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: scratch.url,
    UPLOAD_DIR: out.uploads,
    FIGURES_DIR: out.figures,
    MEDIA_DIR: out.media,
    LOG_LEVEL: 'info', // the suite's setup sets 'silent', which would hide a log line written to stdout
  };
  for (const k of ['HOME', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/restore/cli.ts', ...args], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const run = { code, stdout, stderr };
      runs.push(run);
      resolve(run);
    });
  });
}

const db = (...extra: string[]) => runCli(['db', '--dump', dumpPath, '--source-embed-model', SOURCE_MODEL, ...extra]);
const files = (...extra: string[]) => runCli(['files', '--bucket', bucket, '--manifest', manifestPath, ...extra]);
const verify = (...extra: string[]) => runCli(['verify', ...extra]);

/** The whole of stdout is one JSON object followed by a newline. */
function json(run: Run): Record<string, unknown> {
  expect(run.stdout.endsWith('\n'), run.stderr).toBe(true);
  expect(run.stdout.trimEnd().includes('\n'), 'stdout has exactly one line').toBe(false);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  for (const t of tables) {
    const [r] = await sql`SELECT count(*)::int AS n FROM ${sql(t.tablename as string)}`;
    out[t.tablename as string] = r!.n as number;
  }
  return out;
}

async function filesUnder(dir: string): Promise<string[]> {
  return ((await readdir(dir, { recursive: true }).catch(() => [])) as string[]).sort();
}

describe('restore CLI', () => {
  beforeEach(async () => {
    runs = [];
    scratch = await createScratchDb();
    sql = createSql(scratch.url, { max: 2 });
    await migrate(sql);
    base = await mkdtemp(join(tmpdir(), 'ficino-restore-cli-'));
    dumpPath = join(base, 'data.sql');
    await writeFile(dumpPath, buildSyntheticDump());
    bucket = join(base, 'bucket');
    manifest = await buildSyntheticStorage(bucket);
    manifestPath = join(base, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    out = { uploads: join(base, 'out/uploads'), figures: join(base, 'out/figures'), media: join(base, 'out/media') };
  });

  afterEach(async () => {
    await sql?.end();
    await scratch?.drop();
    await rm(base, { recursive: true, force: true });
  });

  it('db, files and verify succeed end to end on the synthetic archive', { timeout: T }, async () => {
    const owner = `${process.getuid!()}:${process.getgid!()}`;

    const restored = await db();
    expect(restored.code, restored.stderr).toBe(0);
    const report = json(restored);
    expect(report.dryRun).toBe(false);
    expect((report.counts as Record<string, number>).feed_posts).toBe(SYNTHETIC_POST_COUNT);
    expect(restored.stderr).toContain('restore_db'); // the logs went to stderr

    const copied = await files('--chown', owner);
    expect(copied.code, copied.stderr).toBe(0);
    const fileReport = json(copied);
    expect(fileReport.copied).toBe(5);
    expect(fileReport.missing).toEqual([]);
    expect((fileReport.copies as unknown[]).length).toBe(5);
    expect((fileReport.skipped as unknown[]).length).toBe(3);
    expect(await filesUnder(out.uploads)).toEqual([`${SYN.paperDefault}.pdf`, `${SYN.paperOther}.pdf`].sort());

    const verified = await verify('--embed-model', SOURCE_MODEL, '--owner', owner);
    expect(verified.code, verified.stderr).toBe(0);
    const result = json(verified);
    expect(result.ok).toBe(true);
    expect((result.checks as { name: string }[]).map((c) => c.name)).toContain('file owner');
  });

  it('a files re-run keeps what is in place and never overwrites newer media', { timeout: T }, async () => {
    expect((await db()).code).toBe(0);
    expect((await files()).code).toBe(0);
    const episode = join(out.media, 'feeds', SYN.feedEpisode, 'podcast', 'episode.mp3');
    await writeFile(episode, 'regenerated by the api');

    const again = await files();
    expect(again.code, again.stderr).toBe(0);
    const report = json(again);
    expect(report.copied).toBe(0);
    const kept = report.kept as { key: string; reason: string }[];
    expect(kept).toHaveLength(5);
    expect(kept.filter((k) => k.reason === 'target differs')).toEqual([
      { key: KEYS.episode, to: episode, reason: 'target differs' },
    ]);
    expect(again.stderr).toMatch(/kept 1 existing target that differs/);
    expect(await readFile(episode, 'utf8')).toBe('regenerated by the api');

    const forced = await files('--force');
    expect(forced.code, forced.stderr).toBe(0);
    expect(json(forced).copied).toBe(1);
    expect(await readFile(episode, 'utf8')).not.toBe('regenerated by the api');
  });

  it('files --dry-run plans without writing, and verify fails until the files are there', { timeout: T }, async () => {
    expect((await db()).code).toBe(0);

    const dry = await files('--dry-run', '--chown', `${process.getuid!()}:${process.getgid!()}`);
    expect(dry.code, dry.stderr).toBe(0);
    const plan = json(dry);
    expect(plan.copied).toBe(0);
    expect((plan.copies as unknown[]).length).toBe(5);
    expect(await filesUnder(join(base, 'out'))).toEqual([]);

    const before = await verify();
    expect(before.code).toBe(1);
    expect(json(before).ok).toBe(false);
    expect(before.stderr).toMatch(/files present/);
  });

  it('files exits 1 when a restored row has no file in the archive', { timeout: T }, async () => {
    expect((await db()).code).toBe(0);
    await unlink(join(bucket, KEYS.figure));
    await writeFile(manifestPath, JSON.stringify(manifest.filter((e) => e.name !== KEYS.figure)));

    const run = await files();
    expect(run.code).toBe(1);
    const report = json(run);
    expect(report.missing).toEqual([expect.objectContaining({ kind: 'figure', id: SYN.figure })]);
    expect(report.copied).toBe(4); // what exists is still copied; the gap is reported
    expect(run.stderr).toMatch(/1 restored row has no file|missing/);
  });

  it('files exits 1 on a checksum mismatch and writes nothing', { timeout: T }, async () => {
    expect((await db()).code).toBe(0);
    await writeFile(join(bucket, KEYS.pdfOther), 'tampered');

    const run = await files();
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/checksum mismatch/);
    expect(run.stderr).not.toMatch(/\n\s+at /); // no stack
    expect(await filesUnder(join(base, 'out'))).toEqual([]);
  });

  it('db --dry-run leaves the database empty', { timeout: T }, async () => {
    const run = await db('--dry-run');
    expect(run.code, run.stderr).toBe(0);
    const report = json(run);
    expect(report.dryRun).toBe(true);
    expect((report.counts as Record<string, number>).papers).toBe(2);
    const [users] = await sql`SELECT count(*)::int AS n FROM users`;
    expect(users!.n).toBe(0);
  });

  it('db requires --source-embed-model', { timeout: T }, async () => {
    const run = await runCli(['db', '--dump', dumpPath]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/--source-embed-model/);
    const [users] = await sql`SELECT count(*)::int AS n FROM users`;
    expect(users!.n).toBe(0);
  });

  it('rejects an unknown command, a missing --dump and a malformed --chown or --owner', { timeout: T }, async () => {
    for (const args of [
      ['restore'],
      [],
      ['db', '--source-embed-model', SOURCE_MODEL],
      ['db', '--dump', dumpPath, '--source-embed-model', SOURCE_MODEL, '--bogus'],
      ['files', '--bucket', bucket, '--manifest', manifestPath, '--chown', 'ficino'],
      ['verify', '--owner', '10001'],
    ]) {
      const run = await runCli(args);
      expect(run.code, args.join(' ')).toBe(1);
      expect(run.stdout, args.join(' ')).toBe('');
      expect(run.stderr, args.join(' ')).toMatch(/usage|--|unknown|command/i);
    }
    expect(await tableCounts()).toMatchObject({ users: 0, papers: 0 });
  });

  it('a second db run exits 1 and changes nothing', { timeout: T }, async () => {
    expect((await db()).code).toBe(0);
    const before = await tableCounts();
    const [stub] = await sql`SELECT id::text FROM users`;
    expect(stub!.id).toBe(STUB_USER_ID);

    const again = await db();
    expect(again.code).toBe(1);
    expect(again.stdout).toBe('');
    expect(again.stderr).toMatch(/not empty/);
    expect(await tableCounts()).toEqual(before);
  });

  it('never prints the archive secrets', { timeout: T }, async () => {
    await db('--dry-run');
    await db();
    await db(); // the failing re-run too
    await files('--dry-run');
    await files();
    await verify('--embed-model', 'ollama:qwen3-embedding:latest@1024'); // a failing verify
    await verify();
    expect(runs).toHaveLength(7);
    for (const run of runs) {
      expect(run.stdout).not.toContain(SECRET_MARKER);
      expect(run.stderr).not.toContain(SECRET_MARKER);
    }
  });
});
