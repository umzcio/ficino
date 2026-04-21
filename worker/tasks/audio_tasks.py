"""Feed audio generation — render each post to an mp3 with a persona-specific voice.

Invoked on-demand by the frontend's "Play" button; audio isn't generated
automatically with feeds because ElevenLabs costs characters and most
feeds are read, not listened to.

Flow:
  1. Claim the feed (UPDATE audio_status='generating' ... RETURNING posts)
     so concurrent click-happy users can't race two Celery workers into
     duplicate ElevenLabs spend.
  2. For each non-deleted post, synthesize text with the persona's voice,
     upload the mp3 to Supabase Storage, and patch the post's audio_key
     into the feed's posts JSONB.
  3. Flip audio_status to 'ready' (or 'failed' on exception). The API's
     GET /feed/{id} turns each audio_key into a fresh 24h signed URL at
     read time, so we don't have to worry about URL expiry.
"""

from __future__ import annotations

import json
import time

import httpx
import structlog
from celery import Task

from celery_app import app
from lib.db import execute, fetchrow
from lib.persona import get_personas
from lib.storage import storage
from lib.tts import TTSUnavailable, synthesize, voice_id_for

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
    prefix = f"{display_name}. " if display_name else ""
    joined = f"{prefix}{body}"
    if len(joined) > _MAX_TTS_CHARS:
        joined = joined[:_MAX_TTS_CHARS].rsplit(" ", 1)[0] + "…"
    return joined


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

            try:
                mp3 = synthesize(text, voice_id)
            except TTSUnavailable:
                # No API key — surface to the user and bail; no point
                # continuing the loop since every call would fail.
                raise
            except httpx.HTTPStatusError as exc:
                # Per-post failure shouldn't kill the whole feed — log,
                # skip, let other posts render.
                log.warn(
                    "post_synthesis_failed",
                    post_index=idx,
                    status_code=exc.response.status_code,
                )
                skipped += 1
                continue

            try:
                key = storage.save_audio(user_id, feed_id, idx, mp3)
            except NotImplementedError:
                raise

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
