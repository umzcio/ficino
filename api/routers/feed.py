"""Feed generation and retrieval endpoints."""

import json
from uuid import UUID

import asyncpg
import structlog
from celery import Celery
from fastapi import APIRouter, Depends, HTTPException

from config import settings
from db.connection import get_db
from models.feed import Feed, FeedGenerateRequest

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/feed", tags=["feed"])


def _get_celery() -> Celery:
    return Celery(broker=settings.redis_url, backend=settings.redis_url)


@router.post("/generate", status_code=202)
async def generate_feed(
    body: FeedGenerateRequest,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Trigger feed generation for a corpus.

    Returns task_id for polling and eventual feed_id.
    """
    # Check we have at least one complete paper
    count = await db.fetchval("SELECT COUNT(*) FROM papers WHERE status = 'complete'")
    if count == 0:
        raise HTTPException(status_code=400, detail="No processed papers available. Upload and wait for processing to complete.")

    celery_app = _get_celery()
    task = celery_app.send_task(
        "tasks.persona_tasks.generate_feed",
        kwargs={
            "corpus_id": str(body.corpus_id) if body.corpus_id else None,
            "tag_filter": body.tag_filter,
            "user_id": "00000000-0000-0000-0000-000000000000",  # stub until auth
        },
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
    db: asyncpg.Connection = Depends(get_db),
) -> Feed:
    """Get a specific feed by ID."""
    row = await db.fetchrow(
        """SELECT id, user_id, corpus_id, tag_filter, posts,
                  generated_at, generation_duration_ms, paper_count, post_count
           FROM feeds WHERE id = $1""",
        feed_id,
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


@router.get("", response_model=list[Feed])
async def list_feeds(
    db: asyncpg.Connection = Depends(get_db),
) -> list[Feed]:
    """List all generated feeds for the current user."""
    rows = await db.fetch(
        """SELECT id, user_id, corpus_id, tag_filter, posts,
                  generated_at, generation_duration_ms, paper_count, post_count
           FROM feeds ORDER BY generated_at DESC LIMIT 20"""
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
