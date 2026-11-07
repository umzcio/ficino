import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureStubUser } from '../../src/auth/bootstrap.js';
import { migrate } from '../../src/db/migrate.js';
import { createSql, type Sql } from '../../src/db/sql.js';
import {
  assertRestorable,
  orphanReferenceCounts,
  restoreDatabase,
  sourceIdCounts,
  type RestoreReport,
} from '../../src/restore/database.js';
import { RestoreError } from '../../src/restore/errors.js';
import { DEFAULT_WORKSPACE_ID, STUB_USER_ID } from '../../src/shared/constants.js';
import { createScratchDb } from '../helpers/db.js';
import {
  buildSyntheticDump,
  SECRET_MARKER,
  SYN,
  SYNTHETIC_POST_COUNT,
  type SyntheticDumpOptions,
} from '../helpers/syntheticArchive.js';

const SOURCE_MODEL = 'voyage:voyage-4-large@1024';
/** Every id the re-key must remove from the restored rows. */
const SOURCE_IDS = [SYN.owner, SYN.orphan, SYN.defaultCorpus, SYN.orphanCorpus];
/** The synthetic tags row (see syntheticArchive.ts `ROW(0x50)`). */
const TAG_ROW = '50000000-0000-4000-8000-000000000050';

let scratch: Awaited<ReturnType<typeof createScratchDb>>;
let sql: Sql;

async function publicTables(db: Sql): Promise<string[]> {
  const rows = await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
  return rows.map((r) => r.tablename as string);
}

async function tableCounts(db: Sql): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await publicTables(db)) {
    const [r] = await db`SELECT count(*)::int AS n FROM ${db(t)}`;
    out[t] = r!.n as number;
  }
  return out;
}

/** Row content of the tables a restore writes, so "unchanged" means more than equal counts. */
async function fingerprint(db: Sql): Promise<string> {
  const parts: string[] = [];
  for (const t of await publicTables(db)) {
    const [r] = await db`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS h
                         FROM ${db(t)} x`;
    parts.push(`${t}:${r!.h as string}`);
  }
  return parts.join(',');
}

/** Per public table, the rows whose JSON text matches `pattern` (non-zero only). */
async function rowsMatching(db: Sql, pattern: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await publicTables(db)) {
    const [r] = await db`SELECT count(*)::int AS n FROM ${db(t)} x WHERE to_jsonb(x)::text ~ ${pattern}`;
    if ((r!.n as number) > 0) out[t] = r!.n as number;
  }
  return out;
}

const restore = (
  dump: string = buildSyntheticDump(),
  opts: { dryRun?: boolean; log?: pino.Logger } = {},
): Promise<RestoreReport> => restoreDatabase(sql, dump, { sourceEmbedModel: SOURCE_MODEL, ...opts });

const dumpWith = (o: SyntheticDumpOptions): string => buildSyntheticDump(o);

/** A freshly migrated database holds only the persona seed and the migration ledger. */
async function expectUntouched(before: Record<string, number>): Promise<void> {
  expect(await tableCounts(sql)).toEqual(before);
  const [u] = await sql`SELECT count(*)::int AS n FROM users`;
  expect(u!.n).toBe(0);
}

describe('restoreDatabase on a migrated database', () => {
  beforeEach(async () => {
    scratch = await createScratchDb();
    sql = createSql(scratch.url, { max: 3 });
    await migrate(sql);
  });

  afterEach(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('restores the synthetic dump re-keyed to the stub user and the default workspace', async () => {
    const report = await restore();

    expect(await sql`SELECT id::text, clerk_id, email FROM users`).toEqual([
      { id: STUB_USER_ID, clerk_id: 'stub', email: 'owner@example.com' },
    ]);
    const corpora = await sql`SELECT id::text, user_id::text, name FROM corpora ORDER BY id`;
    expect(corpora.map((c) => c.id)).toEqual([DEFAULT_WORKSPACE_ID, SYN.otherCorpus]);
    expect(corpora.map((c) => [c.user_id, c.name])).toEqual([[STUB_USER_ID, 'Default'], [STUB_USER_ID, 'Other']]);
    for (const t of ['papers', 'feeds', 'chunks', 'user_settings', 'tags', 'alerts', 'audit_log', 'feed_posts']) {
      const rows = await sql`SELECT DISTINCT user_id::text AS u FROM ${sql(t)}`;
      expect(rows.map((r) => r.u), t).toEqual([STUB_USER_ID]);
    }
    const [paper] = await sql`SELECT corpus_id::text FROM papers WHERE id = ${SYN.paperDefault}`;
    expect(paper!.corpus_id).toBe(DEFAULT_WORKSPACE_ID);
    const [other] = await sql`SELECT corpus_id::text FROM papers WHERE id = ${SYN.paperOther}`;
    expect(other!.corpus_id).toBe(SYN.otherCorpus);
    const feedCorpora = await sql`SELECT DISTINCT corpus_id::text AS c FROM feeds`;
    expect(feedCorpora.map((r) => r.c)).toEqual([DEFAULT_WORKSPACE_ID]);

    // Ids outside id columns.
    const [deleted] = await sql`SELECT metadata->>'corpus_id' AS c FROM audit_log WHERE action = 'paper.delete'`;
    expect(deleted!.c).toBe(DEFAULT_WORKSPACE_ID);
    const [renamed] = await sql`SELECT resource_id FROM audit_log WHERE resource_type = 'corpus'`;
    expect(renamed!.resource_id).toBe(DEFAULT_WORKSPACE_ID);
    // The dump spells this one in upper case: the re-key matches ids case-insensitively.
    const [userRow] = await sql`SELECT resource_id FROM audit_log WHERE resource_type = 'user'`;
    expect(userRow!.resource_id).toBe(STUB_USER_ID);

    // No restored row anywhere still carries a source id.
    expect(await rowsMatching(sql, SOURCE_IDS.join('|'))).toEqual({});

    const refs = await orphanReferenceCounts(sql);
    expect(refs).toHaveProperty(['reading_list_chapters.reading_list_id']);
    expect(refs).toHaveProperty(['post_replies.persona_key']);
    expect(refs).toHaveProperty(['user_likes.persona_key']);
    expect(refs).toHaveProperty(['sessions.user_id']);
    expect(Object.values(refs).every((n) => n === 0)).toBe(true);

    expect(report.dryRun).toBe(false);
    expect(report.ids).toEqual({
      owner: SYN.owner,
      orphans: [SYN.orphan],
      orphanCorpora: [SYN.orphanCorpus],
      sourceDefaultCorpus: SYN.defaultCorpus,
    });
    expect(report.loaded).toMatchObject({ users: 2, corpora: 3, papers: 2, chunks: 3, feeds: 3, feed_posts: 1 });
    expect(report.loaded).not.toHaveProperty('personas');
    expect(report.counts.feed_posts).toBe(SYNTHETIC_POST_COUNT);
    expect(report.counts).toMatchObject({ users: 1, corpora: 2, papers: 2, chunks: 3, figures: 1, feeds: 3 });
    expect(report.counts).not.toHaveProperty('personas');
    expect(report.counts).not.toHaveProperty('sessions');
    expect(report.cleanup.feedPosts).toBe(SYNTHETIC_POST_COUNT);
    expect(report.cleanup.jsonbDecoded).toEqual({ 'post_replies.messages': 1 });
    expect(await sql`SELECT count(*)::int AS n FROM chunks WHERE metadata->>'embed_model' = ${SOURCE_MODEL}`)
      .toEqual([{ n: 3 }]);
  });

  it('restores a dump without an orphan user', async () => {
    const dump = buildSyntheticDump()
      .split('\n')
      .filter((line) => !line.startsWith(`${SYN.orphan}\t`) && !line.startsWith(`${SYN.orphanCorpus}\t`))
      .join('\n');
    const report = await restore(dump);
    expect(report.loaded).toMatchObject({ users: 1, corpora: 2 });
    expect(report.ids).toEqual({
      owner: SYN.owner,
      orphans: [],
      orphanCorpora: [],
      sourceDefaultCorpus: SYN.defaultCorpus,
    });
    expect(report.counts).toMatchObject({ users: 1, corpora: 2 });
    expect(await rowsMatching(sql, SOURCE_IDS.join('|'))).toEqual({});
  });

  it('aborts on an orphan reference', async () => {
    const before = await tableCounts(sql);
    await expect(restore(dumpWith({ orphanChapter: true }))).rejects.toThrow(/reading_list_chapters\.reading_list_id=1/);
    await expectUntouched(before);
  });

  it('aborts on a persona key the seed lacks', async () => {
    const before = await tableCounts(sql);
    const dump = buildSyntheticDump().replace('\thype\tpost\tfindings\t', '\tnot-a-persona\tpost\tfindings\t');
    await expect(restore(dump)).rejects.toThrow(/user_likes\.persona_key=1/);
    await expectUntouched(before);
  });

  it('never loads auth, storage or personas', async () => {
    const seed = await sql`SELECT * FROM personas ORDER BY key`;
    const report = await restore();

    const personas = await sql`SELECT * FROM personas ORDER BY key`;
    expect(personas).toEqual(seed);
    expect(personas.every((p) => String(p.avatar_url).startsWith('/ficino/personas/'))).toBe(true);
    expect(await rowsMatching(sql, SECRET_MARKER)).toEqual({});
    expect(JSON.stringify(report)).not.toContain(SECRET_MARKER);
    expect(report.skippedSchemas).toEqual(expect.arrayContaining(['auth', 'storage']));
    expect(report.skippedSchemas).not.toContain('public');
    expect(report.skippedTables).toEqual(['personas']);
    const [ns] = await sql`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('auth', 'storage')`;
    expect(ns!.n).toBe(0);
  });

  it('leaves schema_migrations as the runner wrote it', async () => {
    const before = await sql`SELECT version, applied_at FROM schema_migrations ORDER BY version`;
    await restore();
    expect(await sql`SELECT version, applied_at FROM schema_migrations ORDER BY version`).toEqual(before);
  });

  it('aborts on a second run without writing', async () => {
    await restore();
    const counts = await tableCounts(sql);
    const print = await fingerprint(sql);
    await expect(restore()).rejects.toThrow(/not empty/);
    expect(await tableCounts(sql)).toEqual(counts);
    expect(await fingerprint(sql)).toBe(print);
  });

  it('replaces an untouched stub user and Default workspace from an early API boot', async () => {
    await ensureStubUser(sql);
    expect(await assertRestorable(sql)).toEqual({ stubToReplace: true });
    const report = await restore();

    expect(await sql`SELECT id::text, clerk_id, email FROM users`).toEqual([
      { id: STUB_USER_ID, clerk_id: 'stub', email: 'owner@example.com' },
    ]);
    const corpora = await sql`SELECT id::text, name FROM corpora ORDER BY id`;
    expect(corpora).toEqual([
      { id: DEFAULT_WORKSPACE_ID, name: 'Default' },
      { id: SYN.otherCorpus, name: 'Other' },
    ]);
    expect(await rowsMatching(sql, SOURCE_IDS.join('|'))).toEqual({});
    expect(report.counts.feed_posts).toBe(SYNTHETIC_POST_COUNT);
  });

  it('aborts when the stub owns data', async () => {
    await ensureStubUser(sql);
    await sql`
      INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
      VALUES (${SYN.paperDefault}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, 'mine.pdf', '/app/uploads/x.pdf', 'complete')`;
    const print = await fingerprint(sql);
    await expect(restore()).rejects.toThrow(/not empty: corpora=1, papers=1, users=1$/);
    expect(await sql`SELECT id::text, filename FROM papers`).toEqual([{ id: SYN.paperDefault, filename: 'mine.pdf' }]);
    expect(await fingerprint(sql)).toBe(print);
  });

  it('aborts when the stub has a session', async () => {
    await ensureStubUser(sql);
    await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h', ${STUB_USER_ID}, now() + interval '1 day')`;
    await expect(assertRestorable(sql)).rejects.toThrow(/not empty: corpora=1, sessions=1, users=1$/);
    await expect(restore()).rejects.toThrow(RestoreError);
  });

  it('aborts when another user exists beside the stub', async () => {
    await ensureStubUser(sql);
    await sql`INSERT INTO users (id, email) VALUES (${SYN.orphan}, 'someone@example.com')`;
    await expect(restore()).rejects.toThrow(/not empty: corpora=1, users=2$/);
  });

  it('accepts an empty database without a stub', async () => {
    expect(await assertRestorable(sql)).toEqual({ stubToReplace: false });
  });

  it('aborts when a migration is missing from schema_migrations', async () => {
    const last = (await sql`SELECT max(version) AS v FROM schema_migrations`)[0]!.v as string;
    await sql`DELETE FROM schema_migrations WHERE version = ${last}`;
    await expect(restore()).rejects.toThrow(new RegExp(`schema_migrations does not match the migrations: missing ${last}`));
  });

  it('aborts on two candidate owners', async () => {
    const before = await tableCounts(sql);
    await expect(restore(dumpWith({ secondOwner: true }))).rejects.toThrow(/exactly one owner, found 2/);
    await expectUntouched(before);
  });

  it('aborts when an orphan user owns data', async () => {
    const before = await tableCounts(sql);
    const dump = buildSyntheticDump().replace(`${TAG_ROW}\t${SYN.owner}\t`, `${TAG_ROW}\t${SYN.orphan}\t`);
    await expect(restore(dump)).rejects.toThrow(new RegExp(`user ${SYN.orphan} owns data`));
    await expectUntouched(before);
  });

  it('aborts on a dump column the schema lacks', async () => {
    const before = await tableCounts(sql);
    await expect(restore(dumpWith({ extraColumn: true }))).rejects.toThrow(/users\.legacy_col/);
    await expectUntouched(before);
  });

  it('aborts on a dump table the schema lacks or the restore does not load', async () => {
    const before = await tableCounts(sql);
    const extra = 'COPY "public"."legacy_things" ("id") FROM stdin;\nx\n\\.\nCOPY "public"."sessions" ("token_hash") FROM stdin;\ny\n\\.\n';
    await expect(restore(buildSyntheticDump() + extra)).rejects.toThrow(/legacy_things.*sessions|sessions.*legacy_things/);
    await expectUntouched(before);
  });

  it('aborts without a Default corpus for the owner', async () => {
    const before = await tableCounts(sql);
    await expect(restore(dumpWith({ omitDefaultCorpus: true }))).rejects.toThrow(/Default/);
    await expectUntouched(before);
  });

  // alerts.dedupe_hash is text the re-key never touches, so each id planted there must survive to the final check.
  it.each([
    ['the owner', SYN.owner],
    ['the owner in upper case', SYN.owner.toUpperCase()],
    ['an orphan', SYN.orphan],
    ['an orphan in upper case', SYN.orphan.toUpperCase()],
    ['the source Default corpus', SYN.defaultCorpus],
    ["an orphan's corpus", SYN.orphanCorpus],
  ])('aborts when a source id remains where the re-key does not reach: %s', async (_name, id) => {
    const before = await tableCounts(sql);
    const dump = buildSyntheticDump().replace('\tsynthetic-hash\t', `\t${id}\t`);
    await expect(restore(dump)).rejects.toThrow(/source ids remain: alerts=1$/);
    await expectUntouched(before);
  });

  it("aborts when an orphan's corpus holds data", async () => {
    const before = await tableCounts(sql);
    // The feed stays the owner's (user_id), but now sits in the orphan's corpus.
    const row = `${SYN.feedPlain}\t${SYN.owner}\t${SYN.defaultCorpus}\t`;
    const dump = buildSyntheticDump();
    expect(dump).toContain(row);
    const moved = dump.replace(row, `${SYN.feedPlain}\t${SYN.owner}\t${SYN.orphanCorpus}\t`);
    await expect(restore(moved)).rejects.toThrow(new RegExp(`^user ${SYN.orphan} owns data$`));
    await expectUntouched(before);
  });

  /** `sql`, except that `begin` first runs `before` (after restoreDatabase's own pre-transaction check). */
  const withBeforeBegin = (before: () => Promise<void>): Sql =>
    new Proxy(sql, {
      get(target, prop, receiver) {
        if (prop !== 'begin') return Reflect.get(target, prop, receiver);
        return async (...args: unknown[]) => {
          await before();
          return (target.begin as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      },
    });

  it('re-checks inside the transaction: a stub created after the first check is replaced', async () => {
    let calls = 0;
    const racing = withBeforeBegin(async () => {
      calls += 1;
      await ensureStubUser(sql); // an api booting between the first check and the transaction
    });
    const report = await restoreDatabase(racing, buildSyntheticDump(), { sourceEmbedModel: SOURCE_MODEL });
    expect(calls).toBe(1);
    expect(await sql`SELECT id::text, clerk_id, email FROM users`).toEqual([
      { id: STUB_USER_ID, clerk_id: 'stub', email: 'owner@example.com' },
    ]);
    expect(await rowsMatching(sql, SOURCE_IDS.join('|'))).toEqual({});
    expect(report.counts.feed_posts).toBe(SYNTHETIC_POST_COUNT);
  });

  it('re-checks inside the transaction: data written after the first check aborts the restore', async () => {
    const racing = withBeforeBegin(async () => {
      await ensureStubUser(sql);
      await sql`
        INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
        VALUES (${SYN.paperDefault}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, 'mine.pdf', '/app/uploads/x.pdf', 'complete')`;
    });
    await expect(
      restoreDatabase(racing, buildSyntheticDump(), { sourceEmbedModel: SOURCE_MODEL }),
    ).rejects.toThrow(/not empty: corpora=1, papers=1, users=1$/);
    expect(await sql`SELECT id::text, filename FROM papers`).toEqual([{ id: SYN.paperDefault, filename: 'mine.pdf' }]);
    expect(await sql`SELECT id::text FROM users`).toEqual([{ id: STUB_USER_ID }]);
  });

  it('a dry run reports and rolls back', async () => {
    const before = await tableCounts(sql);
    const report = await restore(undefined, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.counts.papers).toBe(2);
    expect(report.counts.feed_posts).toBe(SYNTHETIC_POST_COUNT);
    await expectUntouched(before);
    // A dry run leaves the database restorable.
    expect((await restore()).counts.papers).toBe(2);
  });

  it('logs counts only, never row content', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'debug' }, { write: (s: string) => void lines.push(s) });
    await restore(undefined, { log });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const needle of [SECRET_MARKER, 'Synthetic', 'owner@example.com', 'supabase', ...SOURCE_IDS]) {
      expect(text).not.toContain(needle);
    }
    expect(text).toContain('restore_db');
  });
});

describe('sourceIdCounts', () => {
  beforeEach(async () => {
    scratch = await createScratchDb();
    sql = createSql(scratch.url, { max: 3 });
    await migrate(sql);
  });

  afterEach(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('names each table holding a source id anywhere in a row', async () => {
    await ensureStubUser(sql);
    await sql`INSERT INTO alerts (user_id, alert_type, title, body, metadata)
              VALUES (${STUB_USER_ID}, 'gap', 't', 'b', ${sql.json({ x: SYN.orphanCorpus })})`;
    const ids = { owner: SYN.owner, orphans: [SYN.orphan], orphanCorpora: [SYN.orphanCorpus], sourceDefaultCorpus: SYN.defaultCorpus };
    expect(await sourceIdCounts(sql, ids)).toEqual({ alerts: 1 });
    await sql`DELETE FROM alerts`;
    expect(await sourceIdCounts(sql, ids)).toEqual({});
  });
});

describe('restoreDatabase on an unmigrated database', () => {
  beforeEach(async () => {
    scratch = await createScratchDb();
    sql = createSql(scratch.url, { max: 3 });
  });

  afterEach(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('aborts when migrations are not all applied', async () => {
    await expect(restore()).rejects.toThrow(/schema_migrations/);
    const [t] = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
    expect(t!.n).toBe(0);
  });
});
