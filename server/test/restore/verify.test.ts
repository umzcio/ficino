import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createSql, type Sql } from '../../src/db/sql.js';
import { restoreDatabase } from '../../src/restore/database.js';
import { copyStorage, planStorageCopy } from '../../src/restore/files.js';
import { verifyRestore, type VerifyCheck, type VerifyResult } from '../../src/restore/verify.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import type { StorageDirs } from '../../src/storage/local.js';
import { createScratchDb } from '../helpers/db.js';
import { buildSyntheticDump, buildSyntheticStorage, SYN } from '../helpers/syntheticArchive.js';

const SOURCE_MODEL = 'voyage:voyage-4-large@1024';
const TARGET_MODEL = 'ollama:qwen3-embedding:latest@1024';
const CHECK_NAMES = [
  'single stub user',
  'default workspace',
  'orphan references',
  'jsonb shapes',
  'no supabase urls',
  'no user-prefixed audio keys',
  'feed_posts match posts',
  'embed model',
  'files present',
];

let scratch: Awaited<ReturnType<typeof createScratchDb>>;
let sql: Sql;
let base: string;
let dirs: StorageDirs;

const check = (r: VerifyResult, name: string): VerifyCheck => {
  const c = r.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c;
};

/** Every check that failed, by name. */
const failed = (r: VerifyResult): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);

/** Runs `fn` against the restored feeds, then puts `posts` and `feed_posts` back as they were. */
async function withFeedsRestoredAfter(fn: () => Promise<void>): Promise<void> {
  const feeds = await sql`SELECT id, posts, podcast_segments FROM feeds`;
  const index = await sql`SELECT id, data FROM feed_posts`;
  try {
    await fn();
  } finally {
    for (const f of feeds) {
      await sql`UPDATE feeds SET posts = ${sql.json(f.posts as never)}, podcast_segments = ${
        f.podcast_segments === null ? null : sql.json(f.podcast_segments as never)
      } WHERE id = ${f.id as string}`;
    }
    const ids = index.map((r) => r.id as string);
    await sql`DELETE FROM feed_posts WHERE NOT (id = ANY(${ids}::uuid[]))`;
    for (const r of index) await sql`UPDATE feed_posts SET data = ${sql.json(r.data as never)} WHERE id = ${r.id as string}`;
  }
}

describe('verifyRestore', () => {
  beforeAll(async () => {
    scratch = await createScratchDb();
    sql = createSql(scratch.url, { max: 3 });
    await migrate(sql);
    await restoreDatabase(sql, buildSyntheticDump(), { sourceEmbedModel: SOURCE_MODEL });
  });

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ficino-restore-verify-'));
    const bucket = join(base, 'bucket');
    const out = join(base, 'out');
    dirs = { uploadDir: join(out, 'uploads'), figuresDir: join(out, 'figures'), mediaDir: join(out, 'media') };
    const manifest = await buildSyntheticStorage(bucket);
    await copyStorage(await planStorageCopy(sql, bucket, manifest, dirs), dirs);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('passes on a complete restore', async () => {
    const r = await verifyRestore(sql, dirs);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(CHECK_NAMES);
    expect(check(r, 'embed model').detail).toEqual({ [SOURCE_MODEL]: 3 });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // the CLI prints it as is
  });

  it('fails embed model until the chunks match', async () => {
    const before = await verifyRestore(sql, dirs, { embedModel: TARGET_MODEL });
    expect(before.ok).toBe(false);
    expect(failed(before)).toEqual(['embed model']);
    expect(check(before, 'embed model').detail).toEqual({ [SOURCE_MODEL]: 3 });

    // What a finished re-embed leaves (vectors aside): every chunk tagged with the target.
    await sql`UPDATE chunks SET metadata = metadata || ${sql.json({ embed_model: TARGET_MODEL })}`;
    try {
      const after = await verifyRestore(sql, dirs, { embedModel: TARGET_MODEL });
      expect(after.ok).toBe(true);
      expect(check(after, 'embed model').detail).toEqual({ [TARGET_MODEL]: 3 });

      // A partial re-embed is two groups: still a failure.
      await sql`
        UPDATE chunks SET metadata = metadata || ${sql.json({ embed_model: SOURCE_MODEL })}
        WHERE id = (SELECT id FROM chunks ORDER BY id LIMIT 1)`;
      expect(check(await verifyRestore(sql, dirs, { embedModel: TARGET_MODEL }), 'embed model').ok).toBe(false);
    } finally {
      await sql`UPDATE chunks SET metadata = metadata || ${sql.json({ embed_model: SOURCE_MODEL })}`;
    }
  });

  it('fails files present when a file is gone', async () => {
    await unlink(join(dirs.figuresDir, SYN.paperDefault, 'fig_p1_1.png'));
    const r = await verifyRestore(sql, dirs);
    expect(failed(r)).toEqual(['files present']);
    const detail = check(r, 'files present').detail as { missing: { kind: string; id: string }[]; total: number };
    expect(detail.total).toBe(1);
    expect(detail.missing).toEqual([expect.objectContaining({ kind: 'figure', id: SYN.figure })]);
  });

  it('fails files present for a missing PDF, audio and episode too', async () => {
    await unlink(join(dirs.uploadDir, `${SYN.paperOther}.pdf`));
    await unlink(join(dirs.mediaDir, 'feeds', SYN.feedPlain, 'audio', 'post_0.mp3'));
    await unlink(join(dirs.mediaDir, 'feeds', SYN.feedEpisode, 'podcast', 'episode.mp3'));
    const detail = check(await verifyRestore(sql, dirs), 'files present').detail as {
      missing: { kind: string; id: string }[];
    };
    expect(detail.missing.map((m) => [m.kind, m.id]).sort()).toEqual(
      [
        ['pdf', SYN.paperOther],
        ['audio', `${SYN.feedPlain}/post_0`],
        ['episode', SYN.feedEpisode],
      ].sort(),
    );
  });

  it('fails no supabase urls on a stale signed URL', async () => {
    await withFeedsRestoredAfter(async () => {
      await sql`
        UPDATE feeds SET posts = jsonb_set(posts, '{0,figure_url}', '"https://x.supabase.co/storage/v1/s?t=1"')
        WHERE id = ${SYN.feedPlain}`;
      const r = await verifyRestore(sql, dirs);
      expect(failed(r)).toEqual(['no supabase urls']);
      expect(check(r, 'no supabase urls').detail).toEqual({ feeds: 1, feed_posts: 0 });
    });
  });

  it('fails no supabase urls on a stale URL in the feed_posts index', async () => {
    await withFeedsRestoredAfter(async () => {
      await sql`
        UPDATE feed_posts SET data = data || '{"figure_url": "https://x.supabase.co/s"}'::jsonb
        WHERE id = (SELECT id FROM feed_posts ORDER BY id LIMIT 1)`;
      expect(check(await verifyRestore(sql, dirs), 'no supabase urls').detail).toEqual({ feeds: 0, feed_posts: 1 });
    });
  });

  it('fails no user-prefixed audio keys on a post or a segment that still has one', async () => {
    await withFeedsRestoredAfter(async () => {
      await sql`
        UPDATE feeds SET posts = jsonb_set(posts, '{0,audio_key}', to_jsonb(${`${SYN.owner}/feeds/${SYN.feedPlain}/audio/post_0.mp3`}::text))
        WHERE id = ${SYN.feedPlain}`;
      await sql`
        UPDATE feeds SET podcast_segments = ${sql.json([{ speaker: 'host_a', audio_key: `${SYN.owner}/x/seg_0.mp3` }])}
        WHERE id = ${SYN.feedEpisode}`;
      const r = await verifyRestore(sql, dirs);
      expect(failed(r)).toEqual(['no user-prefixed audio keys']);
      expect(check(r, 'no user-prefixed audio keys').detail).toEqual({ posts: 1, segments: 1 });
    });
  });

  it('fails feed_posts match posts when the index drifts', async () => {
    await withFeedsRestoredAfter(async () => {
      await sql`DELETE FROM feed_posts WHERE feed_id = ${SYN.feedPlain} AND post_index = 0`;
      const r = await verifyRestore(sql, dirs);
      expect(failed(r)).toEqual(['feed_posts match posts']);
      const detail = check(r, 'feed_posts match posts').detail as {
        feeds: { feed: string; posts: number; rows: number }[];
        total: number;
      };
      expect(detail.total).toBe(1);
      expect(detail.feeds).toHaveLength(1);
      expect(detail.feeds[0]!.feed).toBe(SYN.feedPlain);
      expect(detail.feeds[0]!.rows).toBe(detail.feeds[0]!.posts - 1);
    });
    // Put the deleted index row back the way the restore built it.
    const [feed] = await sql`SELECT posts FROM feeds WHERE id = ${SYN.feedPlain}`;
    const { writeFeedPostsIndex } = await import('../../src/tasks/feed.js');
    await sql`DELETE FROM feed_posts WHERE feed_id = ${SYN.feedPlain}`;
    await writeFeedPostsIndex(sql, SYN.feedPlain, feed!.posts as never, 0, STUB_USER_ID);
    expect((await verifyRestore(sql, dirs)).ok).toBe(true);
  });

  it('fails single stub user and default workspace when the re-key did not happen', async () => {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO users (id, email) VALUES (${SYN.orphan}, 'other@example.com')`;
    });
    try {
      const r = await verifyRestore(sql, dirs);
      expect(failed(r)).toEqual(['single stub user']);
      expect(check(r, 'single stub user').detail).toEqual({ users: 2, stub: true });
    } finally {
      await sql`DELETE FROM users WHERE id = ${SYN.orphan}`;
    }
  });

  it('checks file owner on directories as well as files', async () => {
    const uid = process.getuid!();
    const gid = process.getgid!();
    const ok = await verifyRestore(sql, dirs, { owner: { uid, gid } });
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.name)).toEqual([...CHECK_NAMES, 'file owner']);
    expect(check(ok, 'file owner').detail).toEqual({ paths: [], total: 0 });

    const bad = await verifyRestore(sql, dirs, { owner: { uid: uid + 1, gid } });
    expect(failed(bad)).toEqual(['file owner']);
    const detail = check(bad, 'file owner').detail as { paths: string[]; total: number };
    expect(detail.paths).toEqual(expect.arrayContaining([
      dirs.uploadDir,
      dirs.figuresDir,
      dirs.mediaDir,
      join(dirs.mediaDir, 'feeds'),
      join(dirs.mediaDir, 'feeds', SYN.feedPlain, 'audio'),
      join(dirs.figuresDir, SYN.paperDefault),
      join(dirs.figuresDir, SYN.paperDefault, 'fig_p1_1.png'),
    ]));
    // 3 roots + 2 PDFs + figure dir and file + feeds, 2 feed dirs, audio, podcast and their 2 files.
    expect(detail.total).toBe(14);
    expect(detail.paths).toHaveLength(14);

    expect(check(await verifyRestore(sql, dirs, { owner: { uid, gid: gid + 1 } }), 'file owner').ok).toBe(false);
  });

  it('caps the file owner list at 20 paths and reports the total', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    for (let i = 0; i < 25; i++) await writeFile(join(dirs.uploadDir, `extra-${i}.bin`), 'x');
    await mkdir(join(dirs.mediaDir, 'empty'));
    const detail = check(
      await verifyRestore(sql, dirs, { owner: { uid: process.getuid!() + 1, gid: process.getgid!() } }),
      'file owner',
    ).detail as { paths: string[]; total: number };
    expect(detail.paths).toHaveLength(20);
    expect(detail.total).toBe(14 + 25 + 1);
  });

  it('fails file owner when a storage root does not exist', async () => {
    await rm(dirs.mediaDir, { recursive: true });
    const r = await verifyRestore(sql, dirs, { owner: { uid: process.getuid!(), gid: process.getgid!() } });
    expect(check(r, 'file owner').ok).toBe(false);
    expect((check(r, 'file owner').detail as { paths: string[] }).paths).toEqual([dirs.mediaDir]);
  });
});
