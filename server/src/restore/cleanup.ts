import type { Logger } from 'pino';
import type postgres from 'postgres';
import type { Sql } from '../db/sql.js';
import type { Post } from '../feed/types.js';
import { writeFeedPostsIndex } from '../tasks/feed.js';
import { RestoreError } from './errors.js';

/** A pool, a transaction or a reserved connection: every restore helper that can run inside the restore transaction. */
export type RestoreDb = Sql | postgres.TransactionSql | postgres.ReservedSql;

/** The jsonb columns the TS code reads as arrays (it spreads them; a string would become one element per character). */
export const JSONB_ARRAY_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['feeds', 'posts'],
  ['feeds', 'podcast_segments'],
  ['post_replies', 'messages'],
  ['persona_dms', 'messages'],
  ['paper_summaries', 'messages'],
  ['corpus_syntheses', 'messages'],
  ['user_posts', 'replies'],
  ['user_posts', 'sources'],
  ['reading_lists', 'rationale'],
];

/**
 * Counts per transform. `figureUrlsStripped` and `audioKeysRekeyed` count posts (elements of `feeds.posts`);
 * `jsonbDecoded` counts rows per `table.column` (non-zero entries only); `feedPosts` counts the rebuilt index rows;
 * the rest count rows.
 */
export type CleanupReport = {
  paths: { papers: number; figures: number };
  jsonbDecoded: Record<string, number>;
  figureUrlsStripped: number;
  audioKeysRekeyed: number;
  legacyPodcastsCleared: number;
  userPostsErrored: number;
  synthesesHealed: number;
  synthesesErrored: number;
  summariesGenerating: number;
  chunksTagged: number;
  feedPosts: number;
};

/** The archive's storage keys started with the owner's id: `<uuid>/feeds/<feed>/audio/post_<i>.mp3`. */
const USER_PREFIX = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/';

const key = (table: string, column: string) => `${table}.${column}`;

/** Per `table.column` of `JSONB_ARRAY_COLUMNS`, the rows whose value is not NULL and not a jsonb array. */
export async function jsonbShapeViolations(sql: RestoreDb): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, column] of JSONB_ARRAY_COLUMNS) {
    const [row] = await sql`
      SELECT count(*)::int AS n FROM ${sql(table)}
      WHERE ${sql(column)} IS NOT NULL AND jsonb_typeof(${sql(column)}) <> 'array'`;
    out[key(table, column)] = row!.n as number;
  }
  return out;
}

/**
 * Post-load cleanup of a restored archive, in order: TS file paths; double-encoded jsonb arrays decoded; stale
 * `figure_url`s and user-prefixed `audio_key`s out of `feeds.posts`; legacy stitched podcasts cleared; stuck rows swept;
 * untagged chunks tagged with the archive's embedding model; `feed_posts` rebuilt from `feeds.posts`; and finally every
 * `JSONB_ARRAY_COLUMNS` value must be an array, else `RestoreError`. Run it inside the restore transaction: a throw
 * leaves the caller to roll back. Idempotent: a second run changes nothing and reports zero transforms. Logs counts only.
 */
export async function cleanupRestoredData(
  tx: RestoreDb,
  opts: { sourceEmbedModel: string; log?: Logger },
): Promise<CleanupReport> {
  // 1. Paths as the TS storage writes them. Both columns are write-only metadata: storage derives paths from ids.
  const papers = await tx`
    UPDATE papers SET file_path = '/app/uploads/' || id || '.pdf'
    WHERE file_path IS DISTINCT FROM '/app/uploads/' || id || '.pdf'`;
  const figures = await tx`
    UPDATE figures SET image_path = '/app/figures/' || paper_id || '/' || regexp_replace(image_path, '^.*/', '')
    WHERE image_path IS DISTINCT FROM '/app/figures/' || paper_id || '/' || regexp_replace(image_path, '^.*/', '')`;

  // 2. A string whose text is a JSON array is a double-encoded array. The CASE keeps the cast from running on text that
  //    is not JSON (AND gives no evaluation order); anything else stays as it is for step 8 to report.
  const jsonbDecoded: Record<string, number> = {};
  for (const [table, column] of JSONB_ARRAY_COLUMNS) {
    const c = tx(column);
    const res = await tx`
      UPDATE ${tx(table)} SET ${c} = (${c} #>> '{}')::jsonb
      WHERE jsonb_typeof(${c}) = 'string'
        AND CASE WHEN pg_input_is_valid(${c} #>> '{}', 'jsonb')
                 THEN jsonb_typeof((${c} #>> '{}')::jsonb) = 'array'
                 ELSE false END`;
    if (res.count > 0) jsonbDecoded[key(table, column)] = res.count;
  }

  // 3. Posts: drop the stale signed `figure_url` (the API re-signs figures by id) and the user prefix of `audio_key`.
  //    Only object posts are edited; the counts are posts, summed over the changed elements.
  const [posts] = await tx`
    WITH e AS (
      SELECT f.id, x.p, x.o,
             CASE WHEN jsonb_typeof(x.p) = 'object' THEN x.p ? 'figure_url' ELSE false END AS fig,
             CASE WHEN jsonb_typeof(x.p) = 'object' AND jsonb_typeof(x.p -> 'audio_key') = 'string'
                  THEN (x.p ->> 'audio_key') ~ ${USER_PREFIX} ELSE false END AS pre
      FROM feeds f, jsonb_array_elements(f.posts) WITH ORDINALITY AS x(p, o)
      WHERE jsonb_typeof(f.posts) = 'array'
    ), changed AS (
      SELECT id,
             jsonb_agg(CASE
                         WHEN pre THEN jsonb_set(p - 'figure_url', '{audio_key}',
                                                 to_jsonb(regexp_replace(p ->> 'audio_key', ${USER_PREFIX}, '')))
                         WHEN fig THEN p - 'figure_url'
                         ELSE p END ORDER BY o) AS posts,
             count(*) FILTER (WHERE fig) AS figs,
             count(*) FILTER (WHERE pre) AS keys
      FROM e GROUP BY id HAVING bool_or(fig OR pre)
    ), upd AS (
      UPDATE feeds f SET posts = c.posts FROM changed c WHERE f.id = c.id RETURNING f.id
    )
    SELECT coalesce(sum(c.figs), 0)::int AS figs, coalesce(sum(c.keys), 0)::int AS keys
    FROM changed c JOIN upd u ON u.id = c.id`;

  // 4. A legacy stitched podcast (per-segment audio keys, no episode.mp3) must not be played: it regenerates as one.
  const podcasts = await tx`
    UPDATE feeds SET podcast_status = NULL, podcast_generated_at = NULL, podcast_segments = NULL,
                     podcast_claimed_at = NULL
    WHERE jsonb_typeof(podcast_segments) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(podcast_segments) s
                  WHERE CASE WHEN jsonb_typeof(s) = 'object' THEN s ? 'audio_key' ELSE false END)`;

  // 5. Rows stuck on jobs that will never run (their ids were Celery's).
  const userPosts = await tx`UPDATE user_posts SET status = 'error' WHERE status = 'pending'`;
  const healed = await tx`
    UPDATE corpus_syntheses SET status = 'complete', task_id = NULL
    WHERE status IN ('pending', 'generating')
      AND CASE WHEN jsonb_typeof(messages) = 'array' THEN jsonb_array_length(messages) > 0 ELSE false END`;
  const errored = await tx`
    UPDATE corpus_syntheses SET status = 'error', task_id = NULL WHERE status IN ('pending', 'generating')`;
  const [summaries] = await tx`SELECT count(*)::int AS n FROM paper_summaries WHERE status = 'generating'`;

  // 6. Provenance for chunks without a model tag (the re-embed replaces it). A SQL or JSON null counts as `{}`; any
  //    other non-object is left alone (`||` would turn it into an array) and shows up in the re-embed's remaining.
  const chunks = await tx`
    UPDATE chunks
    SET metadata = (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END)
                   || jsonb_build_object('embed_model', ${opts.sourceEmbedModel}::text)
    WHERE CASE WHEN metadata IS NULL OR jsonb_typeof(metadata) = 'null' THEN true
               WHEN jsonb_typeof(metadata) = 'object' THEN NOT metadata ? 'embed_model'
               ELSE false END`;

  // 7. The search index, rebuilt from the cleaned posts (the archive's had drifted). Like the Python backfill, a
  //    non-object post gets no row and the others keep their array index.
  await tx`DELETE FROM feed_posts`;
  const feeds = await tx`
    SELECT id, user_id, posts FROM feeds WHERE jsonb_typeof(posts) = 'array' ORDER BY id`;
  let nonObjectPosts = 0;
  let feedsWithoutUser = 0;
  for (const feed of feeds) {
    const all = feed.posts as unknown[];
    if (feed.user_id === null) {
      if (all.length > 0) feedsWithoutUser++;
      continue;
    }
    let run: Post[] = [];
    let base = 0;
    for (let i = 0; i <= all.length; i++) {
      const p = all[i];
      if (i < all.length && isObject(p)) {
        if (run.length === 0) base = i;
        run.push(p);
        continue;
      }
      if (i < all.length) nonObjectPosts++;
      if (run.length > 0) await writeFeedPostsIndex(tx, feed.id as string, run, base, feed.user_id as string);
      run = [];
    }
  }
  if (nonObjectPosts > 0 || feedsWithoutUser > 0) {
    opts.log?.warn({ non_object_posts: nonObjectPosts, feeds_without_user: feedsWithoutUser }, 'restore_feed_posts_skipped');
  }
  const [indexed] = await tx`SELECT count(*)::int AS n FROM feed_posts`;

  const report: CleanupReport = {
    paths: { papers: papers.count, figures: figures.count },
    jsonbDecoded,
    figureUrlsStripped: posts!.figs as number,
    audioKeysRekeyed: posts!.keys as number,
    legacyPodcastsCleared: podcasts.count,
    userPostsErrored: userPosts.count,
    synthesesHealed: healed.count,
    synthesesErrored: errored.count,
    summariesGenerating: summaries!.n as number,
    chunksTagged: chunks.count,
    feedPosts: indexed!.n as number,
  };
  opts.log?.info(report, 'restore_cleanup');

  // 8. Every array column must now hold arrays; the TS would spread anything else.
  const bad = Object.entries(await jsonbShapeViolations(tx)).filter(([, n]) => n > 0);
  if (bad.length > 0) throw new RestoreError(`jsonb shape: ${bad.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  return report;
}

function isObject(v: unknown): v is Post {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
