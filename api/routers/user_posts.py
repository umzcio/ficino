"""User post endpoints — user-authored posts with Archivist responses."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from celery_client import get_celery
from config import settings
from auth import AuthUser, get_current_user
from auth.rate_limit import RateLimit
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/user-posts", tags=["user-posts"])


class UserPostCreate(BaseModel):
    # Matches the max_length used for ReplyRequest / ZapRequest in replies.py
    # so every body string shipped to a paid LLM has a per-request size cap.
    # Without this, 30 multi-MB posts/day (the existing rate limit) can still
    # burn arbitrarily large input-token bills on Claude.
    content: str = Field(max_length=4000)
    corpus_id: str | None = None


class UserPostFollowUp(BaseModel):
    content: str = Field(max_length=4000)


@router.get("")
async def list_user_posts(
    workspace_id: str | None = None,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List user posts, optionally scoped to a workspace. Newest first."""
    if workspace_id:
        rows = await db.fetch(
            """SELECT id, content, replies, sources, status, created_at
               FROM user_posts
               WHERE user_id = $1 AND corpus_id = $2
               ORDER BY created_at DESC LIMIT 50""",
            user.id, workspace_id,
        )
    else:
        rows = await db.fetch(
            """SELECT id, content, replies, sources, status, created_at
               FROM user_posts
               WHERE user_id = $1
               ORDER BY created_at DESC LIMIT 50""",
            user.id,
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
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get a single user post with its Archivist reply."""
    row = await db.fetchrow(
        """SELECT id, content, replies, sources, status, created_at
           FROM user_posts WHERE id = $1 AND user_id = $2""",
        post_id, user.id,
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
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
    _rl: None = Depends(RateLimit("user_post", settings.rate_limit_user_posts_per_day)),
) -> dict[str, str]:
    """Create a user post and dispatch The Archivist to respond."""
    # If a corpus is specified, it must belong to the caller. Without this
    # check, a user can stage an Archivist run over another user's corpus.
    if body.corpus_id:
        owner = await db.fetchval(
            "SELECT 1 FROM corpora WHERE id = $1 AND user_id = $2",
            body.corpus_id, user.id,
        )
        if not owner:
            raise HTTPException(status_code=404, detail="Workspace not found")

    row = await db.fetchrow(
        """INSERT INTO user_posts (user_id, corpus_id, content, status)
           VALUES ($1, $2, $3, 'pending') RETURNING id""",
        user.id, body.corpus_id, body.content,
    )
    post_id = str(row["id"])

    # Dispatch archivist response
    celery_app = get_celery()
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


@router.post("/{post_id}/replies", status_code=202)
async def reply_to_user_post(
    post_id: str,
    body: UserPostFollowUp,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
    _rl: None = Depends(RateLimit("user_post", settings.rate_limit_user_posts_per_day)),
) -> dict[str, str]:
    """Append a follow-up turn to an existing user post and dispatch The
    Archivist to respond. Threads build up in the `replies` JSONB column
    as alternating user / archivist turns, so the existing list_user_posts
    payload reflects the whole conversation without schema changes.
    """
    # Ownership + state check: only the post owner can append, and we only
    # accept follow-ups once the prior Archivist response has landed — an
    # orphan user turn ahead of the initial archivist reply would make the
    # thread rendering nonsensical.
    row = await db.fetchrow(
        "SELECT status, corpus_id FROM user_posts WHERE id = $1 AND user_id = $2",
        post_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Post not found")
    if row["status"] != "complete":
        raise HTTPException(status_code=409, detail="Previous reply not ready yet")

    # Atomically append the new user turn and flip status to pending so
    # the client's existing poll loop picks up the new Archivist reply.
    user_turn_json = json.dumps([{"role": "user", "content": body.content}])
    await db.execute(
        """UPDATE user_posts
           SET replies = replies || $1::jsonb, status = 'pending'
           WHERE id = $2""",
        user_turn_json, post_id,
    )

    celery_app = get_celery()
    task = celery_app.send_task(
        "tasks.archivist_tasks.respond_to_user_post_followup",
        args=[post_id],
        queue="persona",
    )
    await db.execute(
        "UPDATE user_posts SET task_id = $1 WHERE id = $2",
        task.id, post_id,
    )

    logger.info("user_post_followup", post_id=post_id, task_id=task.id)
    return {"id": post_id, "task_id": task.id, "status": "pending"}


@router.delete("/{post_id}", status_code=204)
async def delete_user_post(
    post_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Delete a user post."""
    result = await db.execute(
        "DELETE FROM user_posts WHERE id = $1 AND user_id = $2",
        post_id, user.id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Post not found")


@router.get("/{post_id}/status")
async def get_user_post_status(
    post_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Check status of archivist response generation."""
    row = await db.fetchrow(
        "SELECT status, task_id FROM user_posts WHERE id = $1 AND user_id = $2",
        post_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Post not found")
    return {"status": row["status"], "task_id": row["task_id"] or ""}
