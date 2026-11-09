import type { Context } from 'hono';
import type { Logger } from 'pino';
import type { AppDeps, AppEnv } from '../app.js';
import type { LocalStorage } from '../storage/local.js';
import { isUuid } from '../shared/uuid.js';

type Post = Record<string, unknown>;

/** One stored `feeds.posts` element on its way out, with where it sits. */
export type StoredPostRef = {
  post: unknown;
  feedId: string;
  index: number;
  /** The feed's audio_status is 'ready' and the route returns media (the list shape does not). */
  audioReady: boolean;
};

export type PostMediaDeps = Pick<AppDeps, 'sql' | 'storage' | 'logger'> & { publicApiBase: string };

/** What presentStoredPosts needs from a request. Media URLs carry the public API base (deliberate change 7). */
export function mediaDeps(c: Context<AppEnv>): PostMediaDeps {
  const { sql, storage, logger, config } = c.var.deps;
  return { sql, storage, logger, publicApiBase: config.publicApiBase };
}

const isObjectPost = (p: unknown): p is Post => p !== null && typeof p === 'object' && !Array.isArray(p);

/** The key the audio task writes for post `index` of `feedId` (LocalStorage.saveAudio; restore maps Python's to it). */
const ownAudioKey = (feedId: string, index: number): string => `feeds/${feedId}/audio/post_${index}.mp3`;

function audioUrlFor(ref: StoredPostRef, post: Post, storage: LocalStorage, base: string): string | null | undefined {
  if (!ref.audioReady) return undefined;
  const key = post.audio_key;
  if (typeof key !== 'string' || key.toLowerCase() !== ownAudioKey(ref.feedId, ref.index).toLowerCase()) return undefined;
  try {
    return `${base}${storage.audioUrl(ref.feedId, ref.index)}`;
  } catch {
    return null;
  }
}

/** figure_id -> paper_id for the ids that name a figure of one of `userId`'s papers; null when the lookup failed. */
async function ownedFigurePapers(
  ids: string[],
  userId: string,
  sql: AppDeps['sql'],
  logger: Logger,
): Promise<Map<string, string> | null> {
  if (ids.length === 0) return new Map();
  try {
    const rows = await sql`
      SELECT f.id, f.paper_id
      FROM figures f
      JOIN papers p ON f.paper_id = p.id AND p.user_id = ${userId}
      WHERE f.id = ANY(${ids}::uuid[])`;
    return new Map(rows.map((r) => [String(r.id).toLowerCase(), String(r.paper_id)]));
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    logger.warn({ user_id: userId, error_type: err.name, error: err.message.slice(0, 200) }, 'figure_url_resign_query_failed');
    return null;
  }
}

/**
 * The posts as a route returns them (deliberate change 29). A stored `figure_url` or `audio_url` is never echoed:
 * posts stored before startPost kept only the model's text fields, or restored from older data, can hold URLs the
 * model wrote. Each object post is copied without both; `figure_url` is then a fresh signature for a `figure_id`
 * naming one of the caller's figures, and `audio_url` a fresh signature when the feed's audio is ready and the post's
 * `audio_key` is the one the audio task writes for that post. A `figure` post whose `figure_id` is not the caller's
 * is returned as a `post`; one whose figure is the caller's but could not be signed (or whose lookup failed) keeps
 * its type with no URL, which the client shows as "Figure not available". Non-object elements pass through. The
 * stored rows are not changed.
 */
export async function presentStoredPosts(refs: StoredPostRef[], userId: string, deps: PostMediaDeps): Promise<unknown[]> {
  const { sql, storage, logger, publicApiBase } = deps;
  const ids = [
    ...new Set(
      refs.flatMap((r) => (isObjectPost(r.post) && isUuid(r.post.figure_id) ? [r.post.figure_id.toLowerCase()] : [])),
    ),
  ];
  const owned = await ownedFigurePapers(ids, userId, sql, logger);

  return refs.map((ref) => {
    if (!isObjectPost(ref.post)) return ref.post;
    const post: Post = { ...ref.post };
    delete post.figure_url;
    delete post.audio_url;

    const audioUrl = audioUrlFor(ref, post, storage, publicApiBase);
    if (audioUrl !== undefined) post.audio_url = audioUrl;

    const figureId = post.figure_id;
    const paperId = isUuid(figureId) ? owned?.get(figureId.toLowerCase()) : undefined;
    if (paperId !== undefined) {
      try {
        post.figure_url = storage.figureImageUrl(paperId, figureId as string, 600);
      } catch {
        logger.warn({ user_id: userId, figure_id: figureId }, 'figure_url_resign_failed');
      }
    } else if (owned !== null && post.post_type === 'figure') {
      // Not one of the caller's figures (or no figure at all): nothing to show, so not a figure post.
      post.post_type = 'post';
    }
    return post;
  });
}

/** One feed's posts through presentStoredPosts. */
export function presentFeedPosts(
  posts: unknown[],
  feedId: string,
  audioReady: boolean,
  userId: string,
  deps: PostMediaDeps,
): Promise<unknown[]> {
  return presentStoredPosts(
    posts.map((post, index) => ({ post, feedId, index, audioReady })),
    userId,
    deps,
  );
}
