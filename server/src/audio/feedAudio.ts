// Port of worker/tasks/audio_tasks.py:56-104: the speech text for one feed post, the reclaim window and the media
// claim that feed audio and the podcast share (W §2.7).
import type { Sql } from '../db/sql.js';
import type { Post } from '../feed/types.js';
import { pyLen, pySlice, pyStr, pyStrip, pyTruthy, pyTypeName } from '../shared/pystr.js';
import { isUuid } from '../shared/uuid.js';

/** Cap per post, in code points: above the app's 2000-char post cap, so legitimate content is never cut. */
export const MAX_TTS_CHARS = 4000;

/** `str(post.get("persona") or "")`: `false`, `0` and `''` give `''`, not `False` or `0`. */
export function personaKeyOf(v: unknown): string {
  return pyTruthy(v) ? pyStr(v) : '';
}

/**
 * `_post_to_speech_text`: the text handed to ElevenLabs, or null for a deleted or empty post. The content and each
 * non-blank string thread part, stripped and joined by blank lines, after a `"<name> says: "` speaker cue. Over the
 * cap it is cut at the last space before code point 4000, plus `…`. A truthy non-string `content` throws Python's
 * `AttributeError` message, which fails the job as it did in Python.
 */
export function postToSpeechText(post: Post, displayName: string): string | null {
  if (pyTruthy(post.deleted)) return null;

  const raw = pyTruthy(post.content) ? post.content : '';
  if (typeof raw !== 'string') throw new TypeError(`'${pyTypeName(raw)}' object has no attribute 'strip'`);
  const content = pyStrip(raw);
  if (!content) return null;

  const pieces = [content];
  const threadPosts = pyTruthy(post.thread_posts) ? post.thread_posts : [];
  if (Array.isArray(threadPosts)) {
    for (const sub of threadPosts) {
      if (typeof sub !== 'string') continue;
      const part = pyStrip(sub);
      if (part) pieces.push(part);
    }
  }

  const body = pieces.join('\n\n');
  const prefix = displayName ? `${displayName} says: ` : '';
  let joined = `${prefix}${body}`;
  if (pyLen(joined) > MAX_TTS_CHARS) {
    // `joined[:4000].rsplit(" ", 1)[0] + "…"`
    const cut = pySlice(joined, 0, MAX_TTS_CHARS);
    const space = cut.lastIndexOf(' ');
    joined = `${space === -1 ? cut : cut.slice(0, space)}…`;
  }
  return joined;
}

/**
 * `_reclaim_minutes`: a `generating` claim older than this is abandoned (a killed job). Twice the job time limit,
 * floored at 15 minutes, so a still-running job's claim is never taken over.
 */
export function reclaimMinutes(jobTimeLimitSec: number): number {
  return Math.max(15, Math.floor((jobTimeLimitSec * 2) / 60));
}

export type MediaColumn = 'audio' | 'podcast';
/** `claim` is the claim timestamp as Postgres text: the job's token, compared exactly (`::timestamptz`). */
export type MediaClaim = { user_id: string | null; corpus_id: string | null; posts: unknown; claim: string };

/**
 * The claim `UPDATE` both media jobs open with, and their only idempotency guard: NULL, `failed` or an abandoned
 * `generating` row becomes `generating` with a fresh claim; `ready` and a fresh claim are left alone (undefined).
 * The column comes from this fixed pair, never from input. A non-UUID id claims nothing.
 */
export async function claimMedia(
  sql: Sql,
  feedId: string,
  column: MediaColumn,
  minutes: number,
): Promise<MediaClaim | undefined> {
  if (!isUuid(feedId)) return undefined;
  const rows =
    column === 'audio'
      ? await sql<MediaClaim[]>`
          UPDATE feeds
          SET audio_status = 'generating', audio_claimed_at = NOW()
          WHERE id = ${feedId}
            AND (audio_status IS NULL OR audio_status = 'failed'
                 OR (audio_status = 'generating'
                     AND (audio_claimed_at IS NULL
                          OR audio_claimed_at < NOW() - make_interval(mins => ${minutes}::int))))
          RETURNING user_id, corpus_id, posts, audio_claimed_at::text AS claim`
      : await sql<MediaClaim[]>`
          UPDATE feeds
          SET podcast_status = 'generating', podcast_claimed_at = NOW()
          WHERE id = ${feedId}
            AND (podcast_status IS NULL OR podcast_status = 'failed'
                 OR (podcast_status = 'generating'
                     AND (podcast_claimed_at IS NULL
                          OR podcast_claimed_at < NOW() - make_interval(mins => ${minutes}::int))))
          RETURNING user_id, corpus_id, posts, podcast_claimed_at::text AS claim`;
  const row = rows[0];
  return row ? { user_id: row.user_id, corpus_id: row.corpus_id, posts: row.posts, claim: row.claim } : undefined;
}

/**
 * Whether a media job still owns its feed: `held` while the row is `generating` on this job's claim, `gone` once
 * the feed row is deleted, `lost` when anything else rewrote the claim (a reclaim, a regenerated chapter's reset).
 */
export type ClaimState = 'held' | 'lost' | 'gone';

export async function claimState(sql: Sql, feedId: string, column: MediaColumn, claim: string): Promise<ClaimState> {
  const [row] =
    column === 'audio'
      ? await sql<{ held: boolean }[]>`
          SELECT COALESCE(audio_status = 'generating' AND audio_claimed_at = ${claim}::timestamptz, false) AS held
          FROM feeds WHERE id = ${feedId}`
      : await sql<{ held: boolean }[]>`
          SELECT COALESCE(podcast_status = 'generating' AND podcast_claimed_at = ${claim}::timestamptz, false) AS held
          FROM feeds WHERE id = ${feedId}`;
  if (!row) return 'gone';
  return row.held ? 'held' : 'lost';
}
