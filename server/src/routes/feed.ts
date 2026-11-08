import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app.js';
import { reclaimMinutes, type MediaColumn } from '../audio/feedAudio.js';
import { recordAudit } from '../audit.js';
import { requireUser } from '../auth/currentUser.js';
import { feedStatusFromJob } from '../feed/status.js';
import { HttpError } from '../http/errors.js';
import { chargeUserRateLimit, userRateLimit } from '../http/rateLimit.js';
import { toPydanticIso } from '../db/time.js';
import { body, params, pyBool, pyInt, pyUuid, query } from '../http/validate.js';
import { LIMITS, MAX_POSTS_PER_GENERATION } from '../shared/constants.js';
import type { LocalStorage } from '../storage/local.js';
import type { Logger } from 'pino';
import { isUuid } from '../shared/uuid.js';

// FeedGenerateRequest: every field optional/nullable, unknown keys ignored (zod strips them).
const generateSchema = z.object({
  corpus_id: pyUuid.nullish(),
  tag_filter: z.array(z.string()).nullish(),
  append_to_feed_id: z.string().nullish(),
  tab_focus: z.string().nullish(),
  persona_key: z.string().nullish(),
  // 0 is accepted and means "the default" (dropped below as falsy); above the cap is a 422.
  num_posts: pyInt.pipe(z.number().int().min(0).max(MAX_POSTS_PER_GENERATION)).nullish(),
});

const listQuery = z.object({ workspace_id: z.string().nullish(), summary: pyBool.default(false) });
const postParams = z.object({ feed_id: z.string(), post_index: pyInt });

type Post = Record<string, unknown>;
type Row = Record<string, any>;

/** Pydantic Feed model: every key always present. include_media=false is the list shape (media keys null). */
export function feedFromRow(
  row: Row,
  posts: Post[],
  opts: { includeMedia?: boolean; podcastAudioUrl?: string | null } = {},
) {
  const includeMedia = opts.includeMedia ?? true;
  let segments: unknown = includeMedia ? row.podcast_segments : null;
  if (typeof segments === 'string') segments = JSON.parse(segments);
  if (!Array.isArray(segments)) segments = null;
  return {
    id: String(row.id),
    user_id: row.user_id == null ? null : String(row.user_id),
    corpus_id: row.corpus_id == null ? null : String(row.corpus_id),
    tag_filter: row.tag_filter ?? null,
    posts,
    generated_at: toPydanticIso(row.generated_at ?? null),
    generation_duration_ms: row.generation_duration_ms ?? null,
    paper_count: row.paper_count ?? null,
    post_count: row.post_count ?? null,
    audio_status: includeMedia ? (row.audio_status ?? null) : null,
    audio_generated_at: includeMedia ? toPydanticIso(row.audio_generated_at ?? null) : null,
    podcast_status: includeMedia ? (row.podcast_status ?? null) : null,
    podcast_generated_at: includeMedia ? toPydanticIso(row.podcast_generated_at ?? null) : null,
    podcast_segments: segments,
    podcast_audio_url: includeMedia ? (opts.podcastAudioUrl ?? null) : null,
  };
}

function parsePosts(v: unknown): Post[] {
  const p = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(p) ? (p as Post[]) : [];
}

/**
 * Deliberate change 7: media URLs carry the public API base, because ListenView assigns them to `audio.src` as-is
 * (figure URLs stay relative; the frontend prefixes those). The signed resource itself stays prefix-free.
 */
function hydrateAudioUrls(posts: Post[], feedId: string, storage: LocalStorage, base: string): void {
  posts.forEach((post, idx) => {
    if (!post || typeof post !== 'object' || !post.audio_key) return;
    try {
      post.audio_url = `${base}${storage.audioUrl(feedId, idx)}`;
    } catch {
      post.audio_url = null;
    }
  });
}

async function hydrateFigureUrls(
  posts: Post[],
  userId: string,
  sql: AppDeps['sql'],
  storage: LocalStorage,
  logger: Logger,
): Promise<void> {
  const indices = posts.map((p, i) => (p && typeof p === 'object' && p.figure_id ? i : -1)).filter((i) => i >= 0);
  if (indices.length === 0) return;
  // A non-UUID id would fail the ::uuid[] cast for every post, so only well-formed ids are queried; the rest keep their persisted URL.
  const ids = indices.map((i) => String(posts[i]!.figure_id)).filter(isUuid);
  let rows: Row[] = [];
  try {
    if (ids.length > 0) rows = await sql`
      SELECT f.id, f.paper_id, f.image_path
      FROM figures f
      JOIN papers p ON f.paper_id = p.id AND p.user_id = ${userId}
      WHERE f.id = ANY(${ids}::uuid[])`;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    logger.warn({ user_id: userId, error_type: err.name, error: err.message.slice(0, 200) }, 'figure_url_resign_query_failed');
    rows = []; // e.g. a malformed persisted figure_id: keep every persisted URL
  }
  const info = new Map(rows.map((r) => [String(r.id), String(r.paper_id)]));
  for (const idx of indices) {
    const figureId = String(posts[idx]!.figure_id);
    const paperId = info.get(figureId);
    let url: string | null = null;
    if (paperId !== undefined) {
      try {
        url = storage.figureImageUrl(paperId, figureId, 600);
      } catch {
        url = null;
      }
    }
    if (url !== null) posts[idx]!.figure_url = url;
    else logger.warn({ user_id: userId, figure_id: posts[idx]!.figure_id }, 'figure_url_resign_failed');
  }
}

/** The two media dispatch routes differ only in these. Column names come from here, never from input. */
const MEDIA_DISPATCH = {
  audio: {
    status: 'audio_status',
    claimedAt: 'audio_claimed_at',
    queue: 'generate_audio_for_feed',
    dispatched: 'feed_audio_dispatched',
    staleClaim: 'feed_audio_stale_claim',
  },
  podcast: {
    status: 'podcast_status',
    claimedAt: 'podcast_claimed_at',
    queue: 'generate_podcast_for_feed',
    dispatched: 'feed_podcast_dispatched',
    staleClaim: 'feed_podcast_stale_claim',
  },
} as const;

/**
 * POST /feed/{id}/audio|podcast. Idempotent on `ready` and a fresh `generating` claim (no charge). A `generating`
 * row whose claim is past the reclaim window (its job died before its catch ran; the audio queues never retry) is
 * charged and dispatched like NULL or `failed` (deliberate change 13); `stale` is the handler's claim predicate, so
 * the new job's claim takes the row over. The API never writes the status column. No audit, as in Python.
 */
async function dispatchMedia(c: Context<AppEnv>, column: MediaColumn) {
  const { sql, queue, logger, config } = c.var.deps;
  if (!config.elevenlabsApiKey) throw new HttpError(501, 'Audio TTS not configured');
  const m = MEDIA_DISPATCH[column];
  const feedId = c.req.param('feed_id')!;
  const minutes = reclaimMinutes(config.jobTimeLimitSec);
  const [row] = isUuid(feedId)
    ? await sql`
        SELECT ${sql(m.status)} AS status, ${sql(m.claimedAt)} AS claimed_at,
               (${sql(m.status)} = 'generating'
                AND (${sql(m.claimedAt)} IS NULL
                     OR ${sql(m.claimedAt)} < NOW() - make_interval(mins => ${minutes}::int))) AS stale
        FROM feeds WHERE id = ${feedId} AND user_id = ${c.var.user.id}`
    : [];
  if (!row) throw new HttpError(404, 'Feed not found');

  const current = row.status as string | null;
  if (current === 'ready' || (current === 'generating' && !row.stale)) return c.json({ status: current }, 202);
  if (row.stale) logger.warn({ feed_id: feedId, claimed_at: row.claimed_at ?? null }, m.staleClaim);

  // Charged only here, so the idempotent answers above never spend the budget. One bucket for both routes.
  await chargeUserRateLimit(c, 'audio');
  const taskId = await queue.send(m.queue, { feed_id: feedId });
  logger.info({ feed_id: feedId, task_id: taskId }, m.dispatched);
  return c.json({ status: 'generating', task_id: taskId }, 202);
}

export function feedRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.post('/generate', userRateLimit('feed_generation'), body(generateSchema), async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const user = c.var.user;
    const req = c.req.valid('json');

    const [{ n }] = req.corpus_id
      ? await sql`SELECT COUNT(*)::int AS n FROM papers WHERE status = 'complete' AND corpus_id = ${req.corpus_id} AND user_id = ${user.id}`
      : await sql`SELECT COUNT(*)::int AS n FROM papers WHERE status = 'complete' AND user_id = ${user.id}`;
    if (n === 0) {
      throw new HttpError(400, 'No processed papers available. Upload and wait for processing to complete.');
    }

    const data: Record<string, unknown> = {
      corpus_id: req.corpus_id ? req.corpus_id : null,
      tag_filter: req.tag_filter ?? null,
      user_id: user.id,
    };
    if (req.append_to_feed_id) {
      // Ownership check: without it another user's feed id could be submitted and overwritten.
      // A non-UUID id cannot match a uuid column (Python 500s on the cast); answer 404 instead.
      const [owned] = isUuid(req.append_to_feed_id)
        ? await sql`SELECT 1 AS ok FROM feeds WHERE id = ${req.append_to_feed_id} AND user_id = ${user.id}`
        : [];
      if (!owned) throw new HttpError(404, 'Feed not found');
      data.append_to_feed_id = req.append_to_feed_id;
    }
    if (req.tab_focus) data.tab_focus = req.tab_focus;
    if (req.persona_key) data.persona_key = req.persona_key;
    if (req.num_posts) data.num_posts = req.num_posts;

    const taskId = await queue.send('generate_feed', data);
    logger.info({ task_id: taskId }, 'feed_generation_dispatched');
    return c.json({ task_id: taskId, status: 'queued' }, 202);
  });

  // No ownership check, as in Python: auth-gated only.
  r.get('/status/:task_id', async (c) => {
    const taskId = c.req.param('task_id');
    return c.json(feedStatusFromJob(taskId, await c.var.deps.queue.getJobState(taskId)));
  });

  r.get('/', query(listQuery), async (c) => {
    const { sql } = c.var.deps;
    const { workspace_id, summary } = c.req.valid('query');
    const cols = summary
      ? sql`id, user_id, corpus_id, tag_filter, generated_at, generation_duration_ms, paper_count, post_count`
      : sql`id, user_id, corpus_id, tag_filter, posts, generated_at, generation_duration_ms, paper_count, post_count`;
    const rows = workspace_id
      ? await sql`SELECT ${cols} FROM feeds WHERE user_id = ${c.var.user.id} AND corpus_id = ${workspace_id}
                  ORDER BY generated_at DESC LIMIT ${LIMITS.FEEDS}`
      : await sql`SELECT ${cols} FROM feeds WHERE user_id = ${c.var.user.id}
                  ORDER BY generated_at DESC LIMIT ${LIMITS.FEEDS}`;
    return c.json(rows.map((row) => feedFromRow(row, summary ? [] : parsePosts(row.posts), { includeMedia: false })));
  });

  r.get('/:feed_id', async (c) => {
    const { sql, storage, logger, config } = c.var.deps;
    const userId = c.var.user.id;
    const feedId = c.req.param('feed_id');
    const [row] = await sql`
      SELECT id, user_id, corpus_id, tag_filter, posts,
             generated_at, generation_duration_ms, paper_count, post_count,
             audio_status, audio_generated_at,
             podcast_status, podcast_generated_at, podcast_segments
      FROM feeds WHERE id = ${feedId} AND user_id = ${userId}`;
    if (!row) throw new HttpError(404, 'Feed not found');
    const posts = parsePosts(row.posts);
    if (row.audio_status === 'ready') hydrateAudioUrls(posts, feedId, storage, config.publicApiBase);
    await hydrateFigureUrls(posts, userId, sql, storage, logger);
    let podcastAudioUrl: string | null = null;
    if (row.podcast_status === 'ready') {
      try {
        podcastAudioUrl = `${config.publicApiBase}${storage.podcastEpisodeUrl(feedId)}`;
      } catch {
        podcastAudioUrl = null;
      }
    }
    return c.json(feedFromRow(row, posts, { podcastAudioUrl }));
  });

  r.post('/:feed_id/audio', (c) => dispatchMedia(c, 'audio'));
  r.post('/:feed_id/podcast', (c) => dispatchMedia(c, 'podcast'));

  r.delete('/:feed_id/posts/:post_index', params(postParams), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const { feed_id, post_index } = c.req.valid('param');
    // Single jsonb_set UPDATE: concurrent deletes on different posts can't stomp each other.
    const [updated] = await sql`
      UPDATE feeds
      SET posts = jsonb_set(posts, ARRAY[${String(post_index)}::text, 'deleted'], 'true'::jsonb, true)
      WHERE id = ${feed_id}
        AND user_id = ${userId}
        AND ${post_index}::int >= 0
        AND ${post_index}::int < jsonb_array_length(posts)
      RETURNING id`;
    if (!updated) {
      const [len] = await sql`SELECT jsonb_array_length(posts) AS n FROM feeds WHERE id = ${feed_id} AND user_id = ${userId}`;
      if (!len) throw new HttpError(404, 'Feed not found');
      throw new HttpError(404, 'Post not found');
    }
    logger.info({ feed_id, post_index }, 'post_soft_deleted');
    try {
      await sql`UPDATE feed_posts SET deleted = true WHERE feed_id = ${feed_id} AND post_index = ${post_index}`;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.warn({ feed_id, post_index, error_type: err.name, error: err.message.slice(0, 200) }, 'feed_posts_deleted_sync_failed');
    }
    await recordAudit(c, {
      action: 'feed.post.delete',
      resourceType: 'feed',
      resourceId: feed_id,
      metadata: { post_index },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  r.post('/:feed_id/regenerate/:post_index', userRateLimit('feed_generation'), params(postParams), async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const userId = c.var.user.id;
    const { feed_id, post_index } = c.req.valid('param');
    const [row] = await sql`SELECT post_count FROM feeds WHERE id = ${feed_id} AND user_id = ${userId}`;
    if (!row) throw new HttpError(404, 'Feed not found');
    if (post_index < 0 || post_index >= row.post_count) throw new HttpError(404, 'Post not found');
    const taskId = await queue.send('regenerate_post', { feed_id, post_index, user_id: userId });
    logger.info({ feed_id, post_index, task_id: taskId }, 'regenerate_post_dispatched');
    await recordAudit(c, {
      action: 'feed.post.regenerate',
      resourceType: 'feed',
      resourceId: feed_id,
      metadata: { post_index, task_id: taskId },
      statusCode: 202,
    });
    return c.json({ task_id: taskId, status: 'queued' }, 202);
  });

  return r;
}
