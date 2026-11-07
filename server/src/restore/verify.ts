// Post-restore checks: the database is re-keyed and clean, the feed index matches the posts, the chunks carry the
// expected embedding model, every file a restored row points at is on disk, and (optionally) the app user owns the
// storage trees. Read-only. Details name tables, ids, paths and counts, never row content.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from '../db/sql.js';
import { DEFAULT_WORKSPACE_ID, STUB_USER_ID } from '../shared/constants.js';
import type { StorageDirs } from '../storage/local.js';
import { embedModelCounts } from '../tasks/reembed.js';
import { jsonbShapeViolations } from './cleanup.js';
import { orphanReferenceCounts } from './database.js';
import { missingFiles } from './files.js';

export type VerifyCheck = { name: string; ok: boolean; detail: unknown };
export type VerifyResult = { ok: boolean; checks: VerifyCheck[] };

/** Lists in a detail stop at this many entries; `total` gives the full count. */
const LIST_CAP = 20;

/** An archive storage key's leading owner id (`<uuid>/feeds/…`), which TS keys never carry. */
const USER_PREFIX = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/';

const nonZero = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

const capped = <T>(items: T[], key: string): Record<string, unknown> => ({
  [key]: items.slice(0, LIST_CAP),
  total: items.length,
});

/** The root and every path below it whose owner is not `uid:gid` (lstat: a link is judged as itself). */
async function wrongOwner(root: string, uid: number, gid: number): Promise<string[]> {
  const st = await lstat(root).catch(() => null);
  if (!st) return [root];
  const out = st.uid === uid && st.gid === gid ? [] : [root];
  if (!st.isDirectory()) return out;
  for (const e of await readdir(root, { withFileTypes: true })) {
    out.push(...(await wrongOwner(join(root, e.name), uid, gid)));
  }
  return out;
}

/**
 * Checks, in this order: `single stub user`, `default workspace`, `orphan references`, `jsonb shapes`,
 * `no supabase urls`, `no user-prefixed audio keys`, `feed_posts match posts`, `embed model` (with `embedModel`, every
 * chunk must carry it; without, ok with the counts as detail), `files present`, and with `owner`, `file owner` (the
 * three storage roots and everything below them). `ok` is true when every check is.
 */
export async function verifyRestore(
  sql: Sql,
  dirs: StorageDirs,
  opts: { embedModel?: string; owner?: { uid: number; gid: number } } = {},
): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];
  const add = (name: string, ok: boolean, detail: unknown) => checks.push({ name, ok, detail });

  const [users] = await sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE id = ${STUB_USER_ID})::int AS stub FROM users`;
  add('single stub user', users!.n === 1 && users!.stub === 1, { users: users!.n, stub: users!.stub === 1 });

  const [ws] = await sql`SELECT user_id::text AS user_id FROM corpora WHERE id = ${DEFAULT_WORKSPACE_ID}`;
  const ownedByStub = ws?.user_id === STUB_USER_ID;
  add('default workspace', ownedByStub, { present: ws !== undefined, ownedByStub });

  const dangling = nonZero(await orphanReferenceCounts(sql));
  add('orphan references', Object.keys(dangling).length === 0, dangling);

  const shapes = nonZero(await jsonbShapeViolations(sql));
  add('jsonb shapes', Object.keys(shapes).length === 0, shapes);

  const [urls] = await sql`
    SELECT (SELECT count(*)::int FROM feeds WHERE posts::text ILIKE '%supabase.co%') AS feeds,
           (SELECT count(*)::int FROM feed_posts WHERE data::text ILIKE '%supabase.co%') AS feed_posts`;
  add('no supabase urls', urls!.feeds === 0 && urls!.feed_posts === 0, { feeds: urls!.feeds, feed_posts: urls!.feed_posts });

  const [keys] = await sql`
    SELECT
      (SELECT count(*)::int FROM feeds f,
         jsonb_array_elements(CASE WHEN jsonb_typeof(f.posts) = 'array' THEN f.posts ELSE '[]'::jsonb END) e
       WHERE e ->> 'audio_key' ~ ${USER_PREFIX}) AS posts,
      (SELECT count(*)::int FROM feeds f,
         jsonb_array_elements(CASE WHEN jsonb_typeof(f.podcast_segments) = 'array' THEN f.podcast_segments
                                   ELSE '[]'::jsonb END) e
       WHERE e ->> 'audio_key' ~ ${USER_PREFIX}) AS segments`;
  add('no user-prefixed audio keys', keys!.posts === 0 && keys!.segments === 0, {
    posts: keys!.posts,
    segments: keys!.segments,
  });

  const drift = await sql<{ feed: string; posts: number; rows: number }[]>`
    SELECT * FROM (
      SELECT f.id::text AS feed,
             CASE WHEN jsonb_typeof(f.posts) = 'array' THEN jsonb_array_length(f.posts) ELSE 0 END AS posts,
             (SELECT count(*)::int FROM feed_posts fp WHERE fp.feed_id = f.id) AS rows
      FROM feeds f) x
    WHERE posts <> rows ORDER BY feed`;
  add('feed_posts match posts', drift.length === 0, capped([...drift], 'feeds'));

  const models = await embedModelCounts(sql, STUB_USER_ID);
  const embedOk = opts.embedModel === undefined || Object.keys(models).every((m) => m === opts.embedModel);
  add('embed model', embedOk, models);

  const missing = await missingFiles(sql, dirs);
  add('files present', missing.length === 0, capped(missing, 'missing'));

  if (opts.owner) {
    const { uid, gid } = opts.owner;
    const wrong: string[] = [];
    for (const root of [dirs.uploadDir, dirs.figuresDir, dirs.mediaDir]) wrong.push(...(await wrongOwner(root, uid, gid)));
    add('file owner', wrong.length === 0, capped(wrong, 'paths'));
  }

  return { ok: checks.every((c) => c.ok), checks };
}
