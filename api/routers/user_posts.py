"""User post endpoints — user-authored posts with Archivist responses."""

import json

import asyncpg
import structlog
from celery import Celery
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import settings
from constants import STUB_USER_ID
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/user-posts", tags=["user-posts"])


def _get_celery() -> Celery:
    return Celery(broker=settings.redis_url, backend=settings.redis_url)


class UserPostCreate(BaseModel):
    content: str
    corpus_id: str | None = None


@router.get("")
async def list_user_posts(
    workspace_id: str | None = None,
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List user posts, optionally scoped to a workspace. Newest first."""
    if workspace_id:
        rows = await db.fetch(
            """SELECT id, content, replies, sources, status, created_at
               FROM user_posts
               WHERE user_id = $1 AND corpus_id = $2
               ORDER BY created_at DESC LIMIT 50""",
            STUB_USER_ID, workspace_id,
        )
    else:
        rows = await db.fetch(
            """SELECT id, content, replies, sources, status, created_at
               FROM user_posts
               WHERE user_id = $1
               ORDER BY created_at DESC LIMIT 50""",
            STUB_USER_ID,
        )

    results = []
    for row in rows:
        replies = row["replies"]
        if isinstance(replies, str):
            replies = json.loads(replies)
        sources = row["sources"]
        if isinstance(sources, str):
            sources = json.loads(sources)
        results.append({
            "id": str(row["id"]),
            "content": row["content"],
            "replies": replies,
            "sources": sources,
            "status": row["status"],
            "created_at": row["created_at"],
        })
    return results


@router.get("/{post_id}")
async def get_user_post(
    post_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get a single user post with its Archivist reply."""
    row = await db.fetchrow(
        """SELECT id, content, replies, sources, status, created_at
           FROM user_posts WHERE id = $1 AND user_id = $2""",
        post_id, STUB_USER_ID,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Post not found")

    replies = row["replies"]
    if isinstance(replies, str):
        replies = json.loads(replies)
    sources = row["sources"]
    if isinstance(sources, str):
        sources = json.loads(sources)

    return {
        "id": str(row["id"]),
        "content": row["content"],
        "replies": replies,
        "sources": sources,
        "status": row["status"],
        "created_at": row["created_at"],
    }


@router.post("", status_code=201)
async def create_user_post(
    body: UserPostCreate,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Create a user post and dispatch The Archivist to respond."""
    row = await db.fetchrow(
        """INSERT INTO user_posts (user_id, corpus_id, content, status)
           VALUES ($1, $2, $3, 'pending') RETURNING id""",
        STUB_USER_ID, body.corpus_id, body.content,
    )
    post_id = str(row["id"])

    # Dispatch archivist response
    celery_app = _get_celery()
    task = celery_app.send_task(
        "tasks.archivist_tasks.respond_to_user_post",
        args=[post_id, body.corpus_id],
        queue="persona",
    )

    await db.execute(
        "UPDATE user_posts SET task_id = $1 WHERE id = $2",
        task.id, post_id,
    )

    logger.info("user_post_created", post_id=post_id, task_id=task.id)
    return {"id": post_id, "task_id": task.id, "status": "pending"}


@router.delete("/{post_id}", status_code=204)
async def delete_user_post(
    post_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Delete a user post."""
    result = await db.execute(
        "DELETE FROM user_posts WHERE id = $1 AND user_id = $2",
        post_id, STUB_USER_ID,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Post not found")


@router.get("/{post_id}/status")
async def get_user_post_status(
    post_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Check status of archivist response generation."""
    row = await db.fetchrow(
        "SELECT status, task_id FROM user_posts WHERE id = $1",
        post_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Post not found")
    return {"status": row["status"], "task_id": row["task_id"] or ""}
