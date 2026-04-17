"""Feed generation and retrieval endpoints."""

import json
from uuid import UUID

import asyncpg
import structlog
from celery import Celery
from fastapi import APIRouter, Depends, HTTPException, Request

from audit import record_audit
from config import settings
from auth import AuthUser, get_current_user
from auth.rate_limit import RateLimit
from db.connection import get_db
from models.feed import Feed, FeedGenerateRequest

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/feed", tags=["feed"])


def _get_celery() -> Celery:
    return Celery(broker=settings.redis_url, backend=settings.redis_url)


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

    celery_app = _get_celery()
    kwargs: dict[str, object] = {
        "corpus_id": str(body.corpus_id) if body.corpus_id else None,
        "tag_filter": body.tag_filter,
        "user_id": user.id,
    }
    if body.append_to_feed_id:
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
async def get_feed_status(task_id: str) -> dict[str, object]:
    """Poll the status of a feed generation task."""
    celery_app = _get_celery()
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


@router.get("/{feed_id}", response_model=Feed)
async def get_feed(
    feed_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> Feed:
    """Get a specific feed by ID."""
    row = await db.fetchrow(
        """SELECT id, user_id, corpus_id, tag_filter, posts,
                  generated_at, generation_duration_ms, paper_count, post_count
           FROM feeds WHERE id = $1 AND user_id = $2""",
        feed_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")

    # Parse posts JSON
    posts_data = row["posts"]
    if isinstance(posts_data, str):
        posts_data = json.loads(posts_data)

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
    )


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
        raise HTTPException(status_code=400, detail="Post index out of range")
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
) -> dict[str, str]:
    """Regenerate a single post in a feed. Same persona and post type, fresh chunks."""
    row = await db.fetchrow(
        "SELECT post_count FROM feeds WHERE id = $1 AND user_id = $2",
        feed_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")
    if post_index < 0 or post_index >= row["post_count"]:
        raise HTTPException(status_code=400, detail="Post index out of range")

    celery_app = _get_celery()
    task = celery_app.send_task(
        "tasks.persona_tasks.regenerate_post",
        args=[feed_id, post_index],
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
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[Feed]:
    """List generated feeds, optionally filtered by workspace."""
    if workspace_id:
        rows = await db.fetch(
            """SELECT id, user_id, corpus_id, tag_filter, posts,
                      generated_at, generation_duration_ms, paper_count, post_count
               FROM feeds WHERE user_id = $1 AND corpus_id = $2 ORDER BY generated_at DESC LIMIT 20""",
            user.id, workspace_id,
        )
    else:
        rows = await db.fetch(
            """SELECT id, user_id, corpus_id, tag_filter, posts,
                      generated_at, generation_duration_ms, paper_count, post_count
               FROM feeds WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 20""",
            user.id,
        )
    feeds = []
    for row in rows:
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
