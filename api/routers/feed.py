"""Feed generation and retrieval endpoints."""

import asyncio
import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request

from audit import record_audit
from celery_client import get_celery
from config import settings
from auth import AuthUser, get_current_user
from auth.rate_limit import RateLimit
from db.connection import get_db
from models.feed import Feed, FeedGenerateRequest

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/feed", tags=["feed"])


@router.post("/generate", status_code=202)
async def generate_feed(
    body: FeedGenerateRequest,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
    _rl: None = Depends(RateLimit("feed_generation", settings.rate_limit_generations_per_day)),
) -> dict[str, str]:
    """Trigger feed generation for a corpus.

    Returns task_id for polling and eventual feed_id.
    """
    # Check we have at least one complete paper (scoped to workspace if provided).
    # FeedGenerateRequest.corpus_id is typed as UUID so Pydantic already rejects
    # non-UUID strings before we reach here — no explicit format check needed.
    # Scope by user.id so another user's complete papers can't trigger a feed
    # generation for the caller.
    if body.corpus_id:
        count = await db.fetchval(
            "SELECT COUNT(*) FROM papers WHERE status = 'complete' AND corpus_id = $1 AND user_id = $2",
            str(body.corpus_id), user.id,
        )
    else:
        count = await db.fetchval(
            "SELECT COUNT(*) FROM papers WHERE status = 'complete' AND user_id = $1",
            user.id,
        )
    if count == 0:
        raise HTTPException(status_code=400, detail="No processed papers available. Upload and wait for processing to complete.")

    celery_app = get_celery()
    kwargs: dict[str, object] = {
        "corpus_id": str(body.corpus_id) if body.corpus_id else None,
        "tag_filter": body.tag_filter,
        "user_id": user.id,
    }
    if body.append_to_feed_id:
        # Ownership check — without this, an attacker who learns another
        # user's feed UUID could submit it here and have the worker overwrite
        # that feed with persona posts grounded in the attacker's corpus.
        owner = await db.fetchval(
            "SELECT 1 FROM feeds WHERE id = $1 AND user_id = $2",
            str(body.append_to_feed_id), user.id,
        )
        if not owner:
            raise HTTPException(status_code=404, detail="Feed not found")
        kwargs["append_to_feed_id"] = body.append_to_feed_id
    if body.tab_focus:
        kwargs["tab_focus"] = body.tab_focus
    if body.persona_key:
        kwargs["persona_key"] = body.persona_key
    if body.num_posts:
        kwargs["num_posts"] = body.num_posts
    task = celery_app.send_task(
        "tasks.persona_tasks.generate_feed",
        kwargs=kwargs,
        queue="persona",
    )

    logger.info("feed_generation_dispatched", task_id=task.id)
    return {"task_id": task.id, "status": "queued"}


@router.get("/status/{task_id}")
async def get_feed_status(
    task_id: str,
    user: AuthUser = Depends(get_current_user),
) -> dict[str, object]:
    """Poll the status of a feed generation task.

    Auth-gated (no task-id ownership check): a task_id is opaque and
    effectively unguessable, but leaving this unauthenticated would let any
    passerby poll by scraping task IDs out of logs or the network tab.
    """
    celery_app = get_celery()
    result = celery_app.AsyncResult(task_id)

    if result.state == "PENDING":
        return {"status": "pending", "task_id": task_id}
    elif result.state == "PROGRESS":
        return {"status": "generating", "task_id": task_id, "meta": result.info}
    elif result.state == "SUCCESS":
        data = result.result or {}
        return {
            "status": "complete",
            "task_id": task_id,
            "feed_id": data.get("feed_id"),
            "post_count": data.get("post_count"),
            "duration_ms": data.get("duration_ms"),
        }
    elif result.state == "FAILURE":
        return {"status": "error", "task_id": task_id, "error": str(result.result)}
    else:
        return {"status": result.state.lower(), "task_id": task_id}


async def _hydrate_audio_urls(
    posts: list[dict[str, object]], user_id: str, feed_id: str
) -> None:
    """Turn each post's stored audio_key into a fresh 24h signed URL.

    Mutates posts in place. Skips quietly on any error (storage down,
    key missing, etc.) — a dead play button is less bad than a 500 on
    the feed GET that breaks the whole page.

    All signed-URL calls for this response are batched into ONE
    `asyncio.to_thread` hop (a sync closure that loops and returns the
    collected URLs) rather than one hop per post — each call is a
    blocking HTTP round-trip against the storage backend, and doing N of
    those directly on the event loop would stall every other in-flight
    request for the sum of their latencies (R10 API-3).
    """
    from storage import storage as storage_backend

    indices = [
        idx for idx, post in enumerate(posts)
        if isinstance(post, dict) and post.get("audio_key")
    ]
    if not indices:
        return

    def _fetch_all() -> dict[int, str | None]:
        urls: dict[int, str | None] = {}
        for idx in indices:
            try:
                urls[idx] = storage_backend.audio_url(user_id, feed_id, idx)
            except Exception:  # noqa: BLE001
                urls[idx] = None
        return urls

    urls = await asyncio.to_thread(_fetch_all)
    for idx, url in urls.items():
        posts[idx]["audio_url"] = url


async def _hydrate_podcast_episode_url(user_id: str, feed_id: str) -> str | None:
    """Sign the episode mp3 for the browser. Returns None on storage error.

    The podcast is ONE continuous file produced via v3 Dialogue Mode, so
    we sign a single URL instead of the per-segment approach feed audio
    uses. Stored at the deterministic `{user}/feeds/{feed}/podcast/episode.mp3`
    key — no JSONB lookup needed.

    Wrapped in `asyncio.to_thread` for the same reason as
    `_hydrate_audio_urls`: the storage backend's signed-URL call is a
    blocking HTTP round-trip (R10 API-3).
    """
    from storage import storage as storage_backend

    def _fetch() -> str | None:
        try:
            return storage_backend.podcast_episode_url(user_id, feed_id)
        except Exception:  # noqa: BLE001
            return None

    return await asyncio.to_thread(_fetch)


@router.get("/{feed_id}", response_model=Feed)
async def get_feed(
    feed_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> Feed:
    """Get a specific feed by ID."""
    row = await db.fetchrow(
        """SELECT id, user_id, corpus_id, tag_filter, posts,
                  generated_at, generation_duration_ms, paper_count, post_count,
                  audio_status, audio_generated_at,
                  podcast_status, podcast_generated_at, podcast_segments
           FROM feeds WHERE id = $1 AND user_id = $2""",
        feed_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")

    # Parse posts JSON
    posts_data = row["posts"]
    if isinstance(posts_data, str):
        posts_data = json.loads(posts_data)

    if row["audio_status"] == "ready":
        await _hydrate_audio_urls(posts_data, user.id, feed_id)

    podcast_segments = row["podcast_segments"]
    if isinstance(podcast_segments, str):
        podcast_segments = json.loads(podcast_segments)
    if not isinstance(podcast_segments, list):
        podcast_segments = None

    podcast_audio_url: str | None = None
    if row["podcast_status"] == "ready":
        podcast_audio_url = await _hydrate_podcast_episode_url(user.id, feed_id)

    return Feed(
        id=row["id"],
        user_id=row["user_id"],
        corpus_id=row["corpus_id"],
        tag_filter=row["tag_filter"],
        posts=posts_data,
        generated_at=row["generated_at"],
        generation_duration_ms=row["generation_duration_ms"],
        paper_count=row["paper_count"],
        post_count=row["post_count"],
        audio_status=row["audio_status"],
        audio_generated_at=row["audio_generated_at"],
        podcast_status=row["podcast_status"],
        podcast_generated_at=row["podcast_generated_at"],
        podcast_segments=podcast_segments,
        podcast_audio_url=podcast_audio_url,
    )


@router.post("/{feed_id}/audio", status_code=202)
async def request_feed_audio(
    feed_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Dispatch a Celery task to generate ElevenLabs audio for every
    post in the feed. Idempotent: returns the current status if audio is
    already generating or ready.

    Returns 501 when ELEVENLABS_API_KEY is unset — self-hosters without
    a key shouldn't see the play button at all (the frontend uses this
    status code to hide the UI).
    """
    if not settings.elevenlabs_api_key:
        raise HTTPException(status_code=501, detail="Audio TTS not configured")

    row = await db.fetchrow(
        "SELECT audio_status FROM feeds WHERE id = $1 AND user_id = $2",
        feed_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")

    current = row["audio_status"]
    if current in ("generating", "ready"):
        # Idempotent: the player will poll /feed/{id} and pick up the
        # existing status/URLs without us spinning up a duplicate task.
        return {"status": current}

    celery_app = get_celery()
    task = celery_app.send_task(
        "tasks.audio_tasks.generate_audio_for_feed",
        args=[feed_id],
        queue="persona",
    )
    logger.info("feed_audio_dispatched", feed_id=feed_id, task_id=task.id)
    return {"status": "generating", "task_id": task.id}


@router.post("/{feed_id}/podcast", status_code=202)
async def request_feed_podcast(
    feed_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Dispatch a Celery task to generate a two-host NotebookLM-style
    podcast for this feed. Same idempotency + 501 semantics as
    `request_feed_audio`: returns the current status if already
    generating/ready, 501 when ElevenLabs isn't configured.
    """
    if not settings.elevenlabs_api_key:
        raise HTTPException(status_code=501, detail="Audio TTS not configured")

    row = await db.fetchrow(
        "SELECT podcast_status FROM feeds WHERE id = $1 AND user_id = $2",
        feed_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")

    current = row["podcast_status"]
    if current in ("generating", "ready"):
        return {"status": current}

    celery_app = get_celery()
    task = celery_app.send_task(
        "tasks.audio_tasks.generate_podcast_for_feed",
        args=[feed_id],
        queue="persona",
    )
    logger.info("feed_podcast_dispatched", feed_id=feed_id, task_id=task.id)
    return {"status": "generating", "task_id": task.id}


@router.delete("/{feed_id}/posts/{post_index}", status_code=204)
async def delete_post(
    feed_id: str,
    post_index: int,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Soft-delete a post in a feed by marking it `deleted: true` in the JSONB.

    Preserves post_index stability so bookmarks, annotations, likes, and
    reply conversations keyed by (feed_id, post_index) remain valid.

    Implemented as a single `jsonb_set` UPDATE rather than read-modify-write,
    so concurrent deletes on different posts in the same feed can't stomp
    each other. The WHERE clause enforces ownership + valid index in one
    pass; RETURNING id lets us distinguish 404-feed from 400-bad-index.
    """
    result = await db.fetchrow(
        """UPDATE feeds
           SET posts = jsonb_set(
               posts,
               ARRAY[$2::text, 'deleted'],
               'true'::jsonb,
               true
           )
           WHERE id = $1
             AND user_id = $3
             AND $2 >= 0
             AND $2 < jsonb_array_length(posts)
           RETURNING id""",
        feed_id, post_index, user.id,
    )
    if not result:
        # Either feed-not-found/wrong-user, or index out of range.
        # Separate query to give the precise status code.
        length = await db.fetchval(
            "SELECT jsonb_array_length(posts) FROM feeds WHERE id = $1 AND user_id = $2",
            feed_id, user.id,
        )
        if length is None:
            raise HTTPException(status_code=404, detail="Feed not found")
        # R10 BP-2: was 400 "Post index out of range" — an out-of-range
        # index into a JSONB array is a missing sub-resource, same as
        # personas.delete_persona_dm_message (404 "Message index out of
        # range") and replies.delete_reply_message (404 "Message not
        # found"). Aligned to 404 so clients don't special-case this one
        # sibling. Phrasing matches user_posts.py's "Post not found" 404s
        # (the closest peer working on posts, not messages).
        raise HTTPException(status_code=404, detail="Post not found")
    logger.info("post_soft_deleted", feed_id=feed_id, post_index=post_index)

    # Sync the feed_posts search index (2.19). Best-effort — the JSONB
    # is the source of truth; backfill script can repair drift.
    try:
        await db.execute(
            "UPDATE feed_posts SET deleted = true WHERE feed_id = $1 AND post_index = $2",
            feed_id, post_index,
        )
    except Exception as e:
        logger.warn(
            "feed_posts_deleted_sync_failed",
            feed_id=feed_id, post_index=post_index,
            error_type=type(e).__name__, error=str(e)[:200],
        )

    await record_audit(
        db, request, user,
        action="feed.post.delete", resource_type="feed", resource_id=feed_id,
        metadata={"post_index": post_index},
        status_code=204,
    )


@router.post("/{feed_id}/regenerate/{post_index}", status_code=202)
async def regenerate_post(
    feed_id: str,
    post_index: int,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
    # Each regeneration is one LLM call; without a cap a user could
    # regenerate every post in a 20-post feed repeatedly and bypass the
    # per-day generations budget entirely. Share that budget here.
    _rl: None = Depends(RateLimit("feed_generation", settings.rate_limit_generations_per_day)),
) -> dict[str, str]:
    """Regenerate a single post in a feed. Same persona and post type, fresh chunks."""
    row = await db.fetchrow(
        "SELECT post_count FROM feeds WHERE id = $1 AND user_id = $2",
        feed_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")
    if post_index < 0 or post_index >= row["post_count"]:
        # R10 BP-2: aligned to 404 "Post not found", same rationale as
        # delete_post above.
        raise HTTPException(status_code=404, detail="Post not found")

    celery_app = get_celery()
    task = celery_app.send_task(
        "tasks.persona_tasks.regenerate_post",
        args=[feed_id, post_index],
        kwargs={"user_id": user.id},
        queue="persona",
    )
    logger.info("regenerate_post_dispatched", feed_id=feed_id, post_index=post_index, task_id=task.id)

    await record_audit(
        db, request, user,
        action="feed.post.regenerate", resource_type="feed", resource_id=feed_id,
        metadata={"post_index": post_index, "task_id": task.id},
        status_code=202,
    )

    return {"task_id": task.id, "status": "queued"}


@router.get("", response_model=list[Feed])
async def list_feeds(
    workspace_id: str | None = None,
    summary: bool = False,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[Feed]:
    """List generated feeds, optionally filtered by workspace.

    With `summary=true`, the `posts` column is not selected — callers that
    only need metadata (FeedHistory, useFeed's mount-time "is there a
    latest feed?" check) avoid shipping up to 20 × 300–800 KB JSONB
    blobs that they never read. Hydrate full posts via `GET /feed/{id}`.
    """
    if summary:
        select_cols = (
            "id, user_id, corpus_id, tag_filter, "
            "generated_at, generation_duration_ms, paper_count, post_count"
        )
    else:
        select_cols = (
            "id, user_id, corpus_id, tag_filter, posts, "
            "generated_at, generation_duration_ms, paper_count, post_count"
        )
    if workspace_id:
        rows = await db.fetch(
            f"""SELECT {select_cols}
               FROM feeds WHERE user_id = $1 AND corpus_id = $2 ORDER BY generated_at DESC LIMIT 20""",
            user.id, workspace_id,
        )
    else:
        rows = await db.fetch(
            f"""SELECT {select_cols}
               FROM feeds WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 20""",
            user.id,
        )
    feeds = []
    for row in rows:
        if summary:
            posts_data: list[dict[str, object]] = []
        else:
            posts_data = row["posts"]
            if isinstance(posts_data, str):
                posts_data = json.loads(posts_data)
        feeds.append(Feed(
            id=row["id"],
            user_id=row["user_id"],
            corpus_id=row["corpus_id"],
            tag_filter=row["tag_filter"],
            posts=posts_data,
            generated_at=row["generated_at"],
            generation_duration_ms=row["generation_duration_ms"],
            paper_count=row["paper_count"],
            post_count=row["post_count"],
        ))
    return feeds
