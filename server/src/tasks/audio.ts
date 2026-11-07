// Port of worker/tasks/audio_tasks.py: generate_audio_for_feed (W §2.7).
import type { Logger } from 'pino';
import { claimMedia, personaKeyOf, postToSpeechText, reclaimMinutes } from '../audio/feedAudio.js';
import { loadPersonas } from '../feed/personas.js';
import type { Post } from '../feed/types.js';
import type { JobContext } from '../jobs/context.js';
import type { ProviderDeps } from '../providers/deps.js';
import { HttpStatusError } from '../providers/http.js';
import { DEFAULT_VOICE, speak, ttsConfig, TtsUnavailableError, voiceIdFor, type TtsConfig } from '../providers/speak.js';
import { pyLen, pySlice, pyTitle, pyTypeName } from '../shared/pystr.js';
import type { WorkerDeps } from '../worker/handlers.js';

export type FeedMediaData = { feed_id: string };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errType = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

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

  // A DB-readable breadcrumb for a silent per-post failure; it never replaces the logs.
  const recordPostError = async (idx: number, stage: string, detail: string): Promise<void> => {
    try {
      await sql`
        UPDATE feeds
        SET posts = jsonb_set(posts, ARRAY[${String(idx)}::text, 'audio_error'],
                              to_jsonb(${`${stage}: ${pySlice(detail, 0, 300)}`}::text), true)
        WHERE id = ${feedId}`;
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
      await sql`
        UPDATE feeds
        SET posts = jsonb_set(posts, ARRAY[${String(idx)}::text, 'audio_key'], to_jsonb(${key}::text), true)
        WHERE id = ${feedId}`;
      // A successful render clears an earlier breadcrumb.
      try {
        await sql`UPDATE feeds SET posts = posts #- ARRAY[${String(idx)}::text, 'audio_error'] WHERE id = ${feedId}`;
      } catch {
        // best-effort
      }
      log.info({ post_index: idx, persona: personaKey, voice_id: voiceId }, 'post_rendered');
      rendered += 1;
    }

    // An abort during the last post never ends `ready` (deliberate change 16).
    ctx.signal.throwIfAborted();
    await sql`UPDATE feeds SET audio_status = 'ready', audio_generated_at = NOW() WHERE id = ${feedId}`;
    log.info({ rendered, skipped, duration_ms: Date.now() - start }, 'feed_audio_complete');
    return { status: 'complete', rendered, skipped };
  } catch (e) {
    log.error({ error: pySlice(errMessage(e), 0, 300) }, 'feed_audio_failed');
    try {
      await sql`UPDATE feeds SET audio_status = 'failed' WHERE id = ${feedId}`;
    } catch {
      // best-effort
    }
    throw e;
  }
}
