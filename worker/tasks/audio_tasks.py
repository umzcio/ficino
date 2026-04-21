"""Feed audio generation — render each post to an mp3 with a persona-specific voice.

Invoked on-demand by the frontend's "Play" button; audio isn't generated
automatically with feeds because ElevenLabs costs characters and most
feeds are read, not listened to.

Flow (feed audio):
  1. Claim the feed (UPDATE audio_status='generating' ... RETURNING posts)
     so concurrent click-happy users can't race two Celery workers into
     duplicate ElevenLabs spend.
  2. For each non-deleted post, synthesize text with the persona's voice,
     upload the mp3 to Supabase Storage, and patch the post's audio_key
     into the feed's posts JSONB.
  3. Flip audio_status to 'ready' (or 'failed' on exception). The API's
     GET /feed/{id} turns each audio_key into a fresh 24h signed URL at
     read time, so we don't have to worry about URL expiry.

Flow (podcast): `generate_podcast_for_feed` at the bottom of this file.
Claims its own `podcast_status` column, builds a two-host dialogue script
via `lib.podcast`, and renders each script segment to the `podcast/` key
prefix. Same claim-then-update-JSONB shape as feed audio.
"""

from __future__ import annotations

import json
import time
from typing import Callable

import httpx
import structlog
from celery import Task

from celery_app import app
from lib.db import execute, fetchrow
from lib.persona import get_personas
from lib.podcast import build_podcast_script
from lib.storage import storage
from lib.tts import TTSUnavailable, synthesize, voice_id_for
from lib import tts as tts_module

logger = structlog.get_logger(__name__)

# Cap per post. Well below ElevenLabs' 40k-char turbo limit but above the
# app's own 2000-char post cap, so we never truncate legitimate content.
_MAX_TTS_CHARS = 4000


def _post_to_speech_text(post: dict, display_name: str) -> str | None:
    """Flatten a feed post into the text we'll hand to ElevenLabs.

    Prepends the persona's display name ("Methods Skeptic.") so a
    listener hears the speaker announced before the actual post.
    The period gives ElevenLabs a natural beat before the content.
    Thread posts are joined with blank lines (TTS renders this as a
    breath pause). Returns None for posts that shouldn't be
    synthesized (soft-deleted or empty).
    """
    if post.get("deleted"):
        return None

    content = (post.get("content") or "").strip()
    if not content:
        return None

    pieces: list[str] = [content]
    thread_posts = post.get("thread_posts") or []
    if isinstance(thread_posts, list):
        for sub in thread_posts:
            if isinstance(sub, str) and sub.strip():
                pieces.append(sub.strip())

    body = "\n\n".join(pieces)
    # "Stats Nerd says: ..." gives a clear speaker cue. The colon pause
    # is more explicit than a period; helps listeners track handoffs.
    prefix = f"{display_name} says: " if display_name else ""
    joined = f"{prefix}{body}"
    if len(joined) > _MAX_TTS_CHARS:
        joined = joined[:_MAX_TTS_CHARS].rsplit(" ", 1)[0] + "…"
    return joined


def _synthesize_with_fallback(
    text: str,
    voice_id: str,
    log: structlog.BoundLogger,
    *,
    on_error: Callable[[str, str], None],
    context: dict[str, object] | None = None,
) -> bytes | None:
    """Synthesize with automatic fallback to the default voice on HTTP 401.

    Shared by feed-audio and podcast tasks. On voice-specific 401/403
    (invalid voice for the account), retries with `_DEFAULT_VOICE` once.
    On any other exception or if the fallback also fails, calls
    `on_error(stage, detail)` so the caller can persist a per-segment
    breadcrumb, then returns None. Raises TTSUnavailable up to the caller
    because there's no point continuing a loop with a missing API key.

    `context` is merged into log events so the caller can stamp post_index
    or segment_index without this helper having to know which.
    """
    ctx = dict(context or {})
    try:
        return synthesize(text, voice_id)
    except TTSUnavailable:
        raise
    except httpx.HTTPStatusError as exc:
        body_preview = ""
        try:
            body_preview = exc.response.text[:300]
        except Exception:  # noqa: BLE001
            pass
        log.warn(
            "synthesis_voice_failed",
            **ctx,
            voice_id=voice_id,
            status_code=exc.response.status_code,
            body=body_preview,
        )
        on_error(
            f"http_{exc.response.status_code}_voice_{voice_id}",
            body_preview,
        )
        if voice_id != tts_module._DEFAULT_VOICE:
            try:
                mp3 = synthesize(text, tts_module._DEFAULT_VOICE)
                log.info("synthesis_fallback_ok", **ctx, voice_id=tts_module._DEFAULT_VOICE)
                return mp3
            except Exception as fb_exc:  # noqa: BLE001
                fb_body = ""
                if isinstance(fb_exc, httpx.HTTPStatusError):
                    try:
                        fb_body = fb_exc.response.text[:300]
                    except Exception:  # noqa: BLE001
                        pass
                log.warn(
                    "synthesis_fallback_failed",
                    **ctx,
                    error_type=type(fb_exc).__name__,
                    error=str(fb_exc)[:200],
                    body=fb_body,
                )
                on_error(
                    f"fallback_{type(fb_exc).__name__}",
                    f"{fb_exc} body={fb_body}",
                )
                return None
        return None
    except Exception as exc:  # noqa: BLE001 — network/timeouts too
        log.warn(
            "synthesis_error",
            **ctx,
            voice_id=voice_id,
            error_type=type(exc).__name__,
            error=str(exc)[:200],
        )
        on_error(
            f"exception_{type(exc).__name__}",
            str(exc),
        )
        return None


@app.task(
    bind=True,
    max_retries=0,
    name="tasks.audio_tasks.generate_audio_for_feed",
)
def generate_audio_for_feed(self: Task, feed_id: str) -> dict[str, object]:
    log = logger.bind(feed_id=feed_id, task_id=self.request.id)
    log.info("feed_audio_start")
    start = time.time()

    # Claim the feed. Guard against re-entry: if audio_status is already
    # 'generating', another worker is in flight — bail out. If it's
    # 'ready', this is a retry after completion — also bail. Only 'failed'
    # or NULL starts a fresh run.
    claimed = fetchrow(
        """UPDATE feeds
           SET audio_status = 'generating'
           WHERE id = $1
             AND (audio_status IS NULL OR audio_status = 'failed')
           RETURNING user_id, posts""",
        feed_id,
    )
    if not claimed:
        log.info("feed_audio_skipped_already_claimed_or_ready")
        return {"status": "skipped", "reason": "claimed_or_ready"}

    user_id = str(claimed["user_id"])
    posts = claimed["posts"]
    if isinstance(posts, str):
        posts = json.loads(posts)

    def _record_post_error(idx: int, stage: str, detail: str) -> None:
        # Persist a per-post audio_error to the feed JSONB so we can
        # diagnose silent failures via SQL. Truncate aggressively — this
        # doesn't replace logs, just gives us a DB-readable breadcrumb.
        try:
            execute(
                """UPDATE feeds
                   SET posts = jsonb_set(posts, $2::text[], $3::jsonb, true)
                   WHERE id = $1""",
                feed_id,
                [str(idx), "audio_error"],
                json.dumps(f"{stage}: {detail[:300]}"),
            )
        except Exception:  # noqa: BLE001
            pass

    try:
        personas = get_personas()
        rendered = 0
        skipped = 0
        for idx, post in enumerate(posts):
            persona_key = str(post.get("persona") or "")
            display_name = personas.get(persona_key, {}).get("name", "") or persona_key.title()
            text = _post_to_speech_text(post, display_name)
            if not text:
                skipped += 1
                continue

            voice_id = voice_id_for(persona_key)
            log.info(
                "post_synthesis_start",
                post_index=idx,
                persona=persona_key,
                voice_id=voice_id,
                chars=len(text),
            )

            mp3 = _synthesize_with_fallback(
                text,
                voice_id,
                log,
                on_error=lambda stage, detail, i=idx: _record_post_error(i, stage, detail),
                context={"post_index": idx, "persona": persona_key},
            )

            if mp3 is None:
                skipped += 1
                continue

            try:
                key = storage.save_audio(user_id, feed_id, idx, mp3)
            except NotImplementedError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warn(
                    "post_audio_upload_failed",
                    post_index=idx,
                    error_type=type(exc).__name__,
                    error=str(exc)[:200],
                )
                _record_post_error(
                    idx,
                    f"upload_{type(exc).__name__}",
                    str(exc),
                )
                skipped += 1
                continue

            # Patch the post: add audio_key. jsonb_set with
            # create_if_missing=true inserts the field in place without
            # rewriting the whole array.
            execute(
                """UPDATE feeds
                   SET posts = jsonb_set(posts, $2::text[], $3::jsonb, true)
                   WHERE id = $1""",
                feed_id,
                [str(idx), "audio_key"],
                json.dumps(key),
            )
            # Clear any prior audio_error on a successful render.
            try:
                execute(
                    """UPDATE feeds
                       SET posts = posts #- $2::text[]
                       WHERE id = $1""",
                    feed_id,
                    [str(idx), "audio_error"],
                )
            except Exception:  # noqa: BLE001
                pass
            log.info("post_rendered", post_index=idx, persona=persona_key, voice_id=voice_id)
            rendered += 1

        execute(
            """UPDATE feeds
               SET audio_status = 'ready', audio_generated_at = NOW()
               WHERE id = $1""",
            feed_id,
        )
        log.info(
            "feed_audio_complete",
            rendered=rendered,
            skipped=skipped,
            duration_ms=int((time.time() - start) * 1000),
        )
        return {
            "status": "complete",
            "rendered": rendered,
            "skipped": skipped,
        }

    except Exception as exc:
        log.error("feed_audio_failed", error=str(exc)[:300])
        try:
            execute(
                "UPDATE feeds SET audio_status = 'failed' WHERE id = $1",
                feed_id,
            )
        except Exception:
            pass
        raise


@app.task(
    bind=True,
    max_retries=0,
    name="tasks.audio_tasks.generate_podcast_for_feed",
)
def generate_podcast_for_feed(self: Task, feed_id: str) -> dict[str, object]:
    """Build a NotebookLM-style two-host podcast episode for a feed.

    Same claim-then-render-then-update pattern as `generate_audio_for_feed`,
    but the script is a two-host dialogue (produced by `lib.podcast`) and
    segments live in the dedicated `podcast_segments` JSONB column.
    Each segment is an mp3 at `{user_id}/feeds/{feed_id}/podcast/seg_{i}.mp3`.
    """
    log = logger.bind(feed_id=feed_id, task_id=self.request.id)
    log.info("feed_podcast_start")
    start = time.time()

    claimed = fetchrow(
        """UPDATE feeds
           SET podcast_status = 'generating'
           WHERE id = $1
             AND (podcast_status IS NULL OR podcast_status = 'failed')
           RETURNING user_id, corpus_id, posts""",
        feed_id,
    )
    if not claimed:
        log.info("feed_podcast_skipped_already_claimed_or_ready")
        return {"status": "skipped", "reason": "claimed_or_ready"}

    user_id = str(claimed["user_id"])
    corpus_id = str(claimed["corpus_id"]) if claimed["corpus_id"] else None
    posts = claimed["posts"]
    if isinstance(posts, str):
        posts = json.loads(posts)
    if not isinstance(posts, list):
        posts = []

    def _record_segment_error(idx: int, stage: str, detail: str) -> None:
        """Write an audio_error onto a single podcast_segments[i] JSONB entry."""
        try:
            execute(
                """UPDATE feeds
                   SET podcast_segments = jsonb_set(
                     podcast_segments, $2::text[], $3::jsonb, true
                   )
                   WHERE id = $1""",
                feed_id,
                [str(idx), "audio_error"],
                json.dumps(f"{stage}: {detail[:300]}"),
            )
        except Exception:  # noqa: BLE001
            pass

    try:
        script = build_podcast_script(
            feed_id=feed_id,
            posts=posts,
            corpus_id=corpus_id,
            user_id=user_id,
        )

        # Persist the script shell first — populate text/voice_id/index on
        # every segment so even if synthesis dies partway, the API
        # response hydrates what it can. audio_key gets added per-segment
        # as TTS completes.
        initial_segments: list[dict[str, object]] = []
        for idx, seg in enumerate(script):
            initial_segments.append({
                "index": idx,
                "speaker": seg["speaker"],
                "text": seg["text"],
                "voice_id": voice_id_for(seg["speaker"]),
            })
        execute(
            "UPDATE feeds SET podcast_segments = $2::jsonb WHERE id = $1",
            feed_id,
            json.dumps(initial_segments),
        )

        rendered = 0
        skipped = 0
        for idx, seg in enumerate(script):
            speaker = seg["speaker"]
            text = seg["text"]
            voice_id = voice_id_for(speaker)
            log.info(
                "podcast_segment_start",
                segment_index=idx,
                speaker=speaker,
                voice_id=voice_id,
                chars=len(text),
            )

            mp3 = _synthesize_with_fallback(
                text,
                voice_id,
                log,
                on_error=lambda stage, detail, i=idx: _record_segment_error(i, stage, detail),
                context={"segment_index": idx, "speaker": speaker},
            )

            if mp3 is None:
                skipped += 1
                continue

            try:
                key = storage.save_podcast_segment(user_id, feed_id, idx, mp3)
            except NotImplementedError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warn(
                    "podcast_segment_upload_failed",
                    segment_index=idx,
                    error_type=type(exc).__name__,
                    error=str(exc)[:200],
                )
                _record_segment_error(
                    idx,
                    f"upload_{type(exc).__name__}",
                    str(exc),
                )
                skipped += 1
                continue

            execute(
                """UPDATE feeds
                   SET podcast_segments = jsonb_set(
                     podcast_segments, $2::text[], $3::jsonb, true
                   )
                   WHERE id = $1""",
                feed_id,
                [str(idx), "audio_key"],
                json.dumps(key),
            )
            # Clear any prior audio_error breadcrumb on this segment.
            try:
                execute(
                    """UPDATE feeds
                       SET podcast_segments = podcast_segments #- $2::text[]
                       WHERE id = $1""",
                    feed_id,
                    [str(idx), "audio_error"],
                )
            except Exception:  # noqa: BLE001
                pass
            log.info("podcast_segment_rendered", segment_index=idx, speaker=speaker)
            rendered += 1

        execute(
            """UPDATE feeds
               SET podcast_status = 'ready', podcast_generated_at = NOW()
               WHERE id = $1""",
            feed_id,
        )
        log.info(
            "feed_podcast_complete",
            segments=len(script),
            rendered=rendered,
            skipped=skipped,
            duration_ms=int((time.time() - start) * 1000),
        )
        return {
            "status": "complete",
            "segments": len(script),
            "rendered": rendered,
            "skipped": skipped,
        }

    except Exception as exc:
        log.error("feed_podcast_failed", error=str(exc)[:300])
        try:
            execute(
                "UPDATE feeds SET podcast_status = 'failed' WHERE id = $1",
                feed_id,
            )
        except Exception:
            pass
        raise
