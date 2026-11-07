// Port of worker/tasks/audio_tasks.py: generate_audio_for_feed and generate_podcast_for_feed (W §2.7).
import type { Logger } from 'pino';
import {
  claimMedia,
  claimState,
  personaKeyOf,
  postToSpeechText,
  reclaimMinutes,
  type ClaimState,
  type MediaColumn,
} from '../audio/feedAudio.js';
import { buildPodcastScript, collectPaperIds } from '../audio/podcast.js';
import { loadPersonas } from '../feed/personas.js';
import { assertEmbedModelScope, type RetrievalCtx } from '../feed/retrieval.js';
import type { Post } from '../feed/types.js';
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { embedModelId } from '../providers/embed.js';
import { HttpStatusError } from '../providers/http.js';
import {
  DEFAULT_VOICE,
  DialogueTooLongError,
  speak,
  speakDialogue,
  ttsConfig,
  TtsUnavailableError,
  voiceIdFor,
  type TtsConfig,
} from '../providers/speak.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pyLen, pySlice, pyTitle, pyTypeName } from '../shared/pystr.js';
import { isUuid } from '../shared/uuid.js';
import type { WorkerDeps } from '../worker/handlers.js';

export type FeedMediaData = { feed_id: string };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errType = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/**
 * Deliberate change 18: a media job writes only while it still owns its claim, and stops as soon as it does not.
 * `owned()` is the SQL guard for every write after the claim; `stop()` answers null while the claim is held, or
 * ends the job: a deleted feed (`gone`) gets its media directory removed again (a save may have recreated it after
 * the delete path's cleanup) and logs `feed_<kind>_feed_deleted`; a claim taken over (`lost`) leaves the directory
 * to its new owner and logs `feed_<kind>_claim_lost`. Neither ends `failed`; nothing further is rendered.
 */
function claimGuard(deps: WorkerDeps, feedId: string, column: MediaColumn, claim: string, log: Logger) {
  const { sql } = deps;
  const event = column === 'audio' ? 'feed_audio' : 'feed_podcast';
  const owned = () =>
    column === 'audio'
      ? sql`audio_status = 'generating' AND audio_claimed_at = ${claim}::timestamptz`
      : sql`podcast_status = 'generating' AND podcast_claimed_at = ${claim}::timestamptz`;
  const end = async (state: Exclude<ClaimState, 'held'>): Promise<Record<string, unknown>> => {
    if (state === 'gone') {
      await deps.storage.deleteFeedMedia(feedId);
      log.warn(`${event}_feed_deleted`);
      return { status: 'skipped', reason: 'feed_deleted' };
    }
    log.warn(`${event}_claim_lost`);
    return { status: 'skipped', reason: 'claim_lost' };
  };
  const stop = async (): Promise<Record<string, unknown> | null> => {
    const state = await claimState(sql, feedId, column, claim);
    return state === 'held' ? null : end(state);
  };
  /** After a guarded write matched no row: the claim cannot still be held, so this always ends the job. */
  const stopAfterMiss = async (): Promise<Record<string, unknown>> => (await stop()) ?? end('lost');
  return { owned, stop, stopAfterMiss };
}

type SynthesisOpts = {
  cfg: TtsConfig;
  deps: Pick<ProviderDeps, 'fetch'>;
  signal: AbortSignal;
  log: Logger;
  /** Persist a per-post breadcrumb; best-effort, never throws. */
  onError(stage: string, detail: string): Promise<void>;
  /** Merged into every log line (post_index, persona). */
  context: Record<string, unknown>;
};

/**
 * `_synthesize_with_fallback`: render `text` in `voiceId`; on any HTTP error retry once in `DEFAULT_VOICE` (unless
 * that already was the voice). Any other failure records a stage and returns null, so the caller skips the post.
 * A missing key rethrows (no point going on), and so does anything once the job's own signal has aborted: a time
 * limit is never a per-post failure (deliberate change 16). Stages name the TS error class (deliberate change 12).
 */
async function synthesizeWithFallback(text: string, voiceId: string, o: SynthesisOpts): Promise<Uint8Array | null> {
  const { cfg, deps, signal, log, onError, context } = o;
  try {
    return await speak(cfg, deps, { text, voiceId, signal });
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof TtsUnavailableError) throw e;
    if (e instanceof HttpStatusError) {
      const bodyPreview = pySlice(e.body, 0, 300);
      log.warn({ ...context, voice_id: voiceId, status_code: e.status, body: bodyPreview }, 'synthesis_voice_failed');
      await onError(`http_${e.status}_voice_${voiceId}`, bodyPreview);
      if (voiceId !== DEFAULT_VOICE) {
        try {
          const mp3 = await speak(cfg, deps, { text, voiceId: DEFAULT_VOICE, signal });
          log.info({ ...context, voice_id: DEFAULT_VOICE }, 'synthesis_fallback_ok');
          return mp3;
        } catch (fb) {
          if (signal.aborted) throw fb;
          // Python's `fb_body = ""` for anything but an HTTP status error.
          const fbBody = fb instanceof HttpStatusError ? pySlice(fb.body, 0, 300) : '';
          log.warn(
            { ...context, error_type: errType(fb), error: pySlice(errMessage(fb), 0, 200), body: fbBody },
            'synthesis_fallback_failed',
          );
          await onError(`fallback_${errType(fb)}`, `${errMessage(fb)} body=${fbBody}`);
          return null;
        }
      }
      return null;
    }
    log.warn(
      { ...context, voice_id: voiceId, error_type: errType(e), error: pySlice(errMessage(e), 0, 200) },
      'synthesis_error',
    );
    await onError(`exception_${errType(e)}`, errMessage(e));
    return null;
  }
}

/**
 * Render each post of a feed to its own mp3 in the persona's voice, one at a time, and key it into the post
 * (`audio_key`). The claim is the only idempotency guard. The feed ends `ready` even when nothing rendered, as in
 * Python; any throw ends it `failed` and is rethrown (the queue does not retry).
 */
export async function generateAudioForFeed(
  data: FeedMediaData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const feedId = data.feed_id;
  const log = ctx.logger.child({ feed_id: feedId, task_id: ctx.jobId });
  log.info('feed_audio_start');
  const start = Date.now();

  const claimed = await claimMedia(sql, feedId, 'audio', reclaimMinutes(deps.config.jobTimeLimitSec));
  if (!claimed) {
    log.info('feed_audio_skipped_already_claimed_or_ready');
    return { status: 'skipped', reason: 'claimed_or_ready' };
  }
  const guard = claimGuard(deps, feedId, 'audio', claimed.claim, log);

  // A DB-readable breadcrumb for a silent per-post failure; it never replaces the logs.
  const recordPostError = async (idx: number, stage: string, detail: string): Promise<void> => {
    try {
      await sql`
        UPDATE feeds
        SET posts = jsonb_set(posts, ARRAY[${String(idx)}::text, 'audio_error'],
                              to_jsonb(${`${stage}: ${pySlice(detail, 0, 300)}`}::text), true)
        WHERE id = ${feedId} AND ${guard.owned()}`;
    } catch {
      // best-effort
    }
  };

  try {
    const posts = claimed.posts;
    // Deliberate change 17c: Python failed on a non-empty object but ended `ready` on `{}`.
    if (!Array.isArray(posts)) throw new Error('feed posts is not a list');
    const personas = await loadPersonas(sql);
    const cfg = ttsConfig(deps.config);
    let rendered = 0;
    let skipped = 0;

    for (const [idx, item] of posts.entries()) {
      ctx.signal.throwIfAborted();
      // Parity: Python's `post.get` raised AttributeError on a non-dict item and failed the job there.
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new TypeError(`'${pyTypeName(item)}' object has no attribute 'get'`);
      }
      const post = item as Post;
      const personaKey = personaKeyOf(post.persona);
      const displayName = personas.get(personaKey)?.name || pyTitle(personaKey);
      const text = postToSpeechText(post, displayName);
      if (!text) {
        skipped += 1;
        continue;
      }

      // Deliberate change 18: no paid render for a feed that was deleted or taken over.
      const stopped = await guard.stop();
      if (stopped) return stopped;

      const voiceId = voiceIdFor(personaKey);
      log.info(
        { post_index: idx, persona: personaKey, voice_id: voiceId, chars: pyLen(text) },
        'post_synthesis_start',
      );
      const mp3 = await synthesizeWithFallback(text, voiceId, {
        cfg,
        deps: deps.providers,
        signal: ctx.signal,
        log,
        onError: (stage, detail) => recordPostError(idx, stage, detail),
        context: { post_index: idx, persona: personaKey },
      });
      if (mp3 === null) {
        skipped += 1;
        continue;
      }

      let key: string;
      try {
        key = await deps.storage.saveAudio(feedId, idx, mp3);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        log.warn(
          { post_index: idx, error_type: errType(e), error: pySlice(errMessage(e), 0, 200) },
          'post_audio_upload_failed',
        );
        await recordPostError(idx, `upload_${errType(e)}`, errMessage(e));
        skipped += 1;
        continue;
      }

      // jsonb_set with create_if_missing patches the one field without rewriting the array.
      const keyed = await sql`
        UPDATE feeds
        SET posts = jsonb_set(posts, ARRAY[${String(idx)}::text, 'audio_key'], to_jsonb(${key}::text), true)
        WHERE id = ${feedId} AND ${guard.owned()}
        RETURNING id`;
      if (keyed.length === 0) return await guard.stopAfterMiss();
      // A successful render clears an earlier breadcrumb.
      try {
        await sql`
          UPDATE feeds SET posts = posts #- ARRAY[${String(idx)}::text, 'audio_error']
          WHERE id = ${feedId} AND ${guard.owned()}`;
      } catch {
        // best-effort
      }
      log.info({ post_index: idx, persona: personaKey, voice_id: voiceId }, 'post_rendered');
      rendered += 1;
    }

    // An abort during the last post never ends `ready` (deliberate change 16).
    ctx.signal.throwIfAborted();
    const done = await sql`
      UPDATE feeds SET audio_status = 'ready', audio_generated_at = NOW()
      WHERE id = ${feedId} AND ${guard.owned()}
      RETURNING id`;
    if (done.length === 0) return await guard.stopAfterMiss();
    log.info({ rendered, skipped, duration_ms: Date.now() - start }, 'feed_audio_complete');
    return { status: 'complete', rendered, skipped };
  } catch (e) {
    log.error({ error: pySlice(errMessage(e), 0, 300) }, 'feed_audio_failed');
    try {
      await sql`UPDATE feeds SET audio_status = 'failed' WHERE id = ${feedId} AND ${guard.owned()}`;
    } catch {
      // best-effort
    }
    throw e;
  }
}

/**
 * A two-host episode for a feed: an LLM script grounded in the feed's papers, rendered by ONE ElevenLabs
 * text-to-dialogue call into ONE file, `feeds/<id>/podcast/episode.mp3` (the owner's audio quality bar: a script is
 * never split, concatenated or rendered per turn; one over the cap fails). The transcript is stored before
 * synthesis so it shows even when the render fails. Any throw after the claim ends `failed` and is rethrown (the
 * queue does not retry).
 */
export async function generatePodcastForFeed(
  data: FeedMediaData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql, config } = deps;
  const feedId = data.feed_id;
  const log = ctx.logger.child({ feed_id: feedId, task_id: ctx.jobId });
  log.info('feed_podcast_start');
  const start = Date.now();

  const claimed = await claimMedia(sql, feedId, 'podcast', reclaimMinutes(config.jobTimeLimitSec));
  if (!claimed) {
    log.info('feed_podcast_skipped_already_claimed_or_ready');
    return { status: 'skipped', reason: 'claimed_or_ready' };
  }
  const guard = claimGuard(deps, feedId, 'podcast', claimed.claim, log);
  // Parity: Python coerced a non-list `posts` to [] here (feed audio fails on one instead).
  const posts: unknown[] = Array.isArray(claimed.posts) ? claimed.posts : [];

  try {
    // Deliberate change 17: the settings load is inside the catch (a failure ends `failed`), and a NULL owner
    // reads the stub user's settings (Python passed the string 'None').
    const owner = claimed.user_id ?? STUB_USER_ID;
    const { providers } = await loadJobSettings(sql, owner, deps.env, config);
    const scriptLog = log.child({ user_id: owner, corpus_id: claimed.corpus_id });

    // Deliberate change 14: an episode whose papers were all embedded with another model fails before any spend.
    await assertEmbedModelScope(sql, collectPaperIds(posts).filter(isUuid), embedModelId(providers), log);

    const rctx: RetrievalCtx = { sql, config, providers, deps: deps.providers, logger: scriptLog, signal: ctx.signal };
    const personas = await loadPersonas(sql);
    const script = await buildPodcastScript(rctx, { posts, personas, logger: scriptLog });

    // The transcript first, so the UI can show it even if synthesis fails.
    const segmentsMeta = script.map((seg, index) => ({
      index,
      speaker: seg.speaker,
      text: seg.text,
      voice_id: voiceIdFor(seg.speaker),
    }));
    const stored = await sql`
      UPDATE feeds SET podcast_segments = ${sql.json(segmentsMeta)}
      WHERE id = ${feedId} AND ${guard.owned()}
      RETURNING id`;
    // Deliberate change 18: no dialogue render for a feed deleted (or taken over) while the script was written.
    if (stored.length === 0) return await guard.stopAfterMiss();

    const inputs = script.map((seg) => ({ text: seg.text, voice_id: voiceIdFor(seg.speaker) }));
    const totalChars = inputs.reduce((n, t) => n + pyLen(t.text), 0);
    log.info({ segments: script.length, total_chars: totalChars }, 'podcast_dialogue_start');

    let mp3: Uint8Array;
    try {
      mp3 = await speakDialogue(ttsConfig(config), deps.providers, { inputs, signal: ctx.signal });
    } catch (e) {
      if (e instanceof DialogueTooLongError) {
        log.error({ error: e.message }, 'podcast_dialogue_too_long');
      } else if (e instanceof HttpStatusError) {
        log.error({ status_code: e.status, body: pySlice(e.body, 0, 400) }, 'podcast_dialogue_http_error');
      }
      throw e;
    }

    const before = await guard.stop();
    if (before) return before;
    const key = await deps.storage.savePodcastEpisode(feedId, mp3);
    log.info({ bytes: mp3.byteLength, key }, 'podcast_episode_uploaded');

    const done = await sql`
      UPDATE feeds SET podcast_status = 'ready', podcast_generated_at = NOW()
      WHERE id = ${feedId} AND ${guard.owned()}
      RETURNING id`;
    // A delete between the check and the save: the save recreated the directory, so it is removed again.
    if (done.length === 0) return await guard.stopAfterMiss();
    log.info(
      { segments: script.length, total_chars: totalChars, bytes: mp3.byteLength, duration_ms: Date.now() - start },
      'feed_podcast_complete',
    );
    return { status: 'complete', segments: script.length, bytes: mp3.byteLength };
  } catch (e) {
    log.error({ error: pySlice(errMessage(e), 0, 300) }, 'feed_podcast_failed');
    try {
      await sql`UPDATE feeds SET podcast_status = 'failed' WHERE id = ${feedId} AND ${guard.owned()}`;
    } catch {
      // best-effort
    }
    throw e;
  }
}
