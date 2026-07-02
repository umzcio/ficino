"""Like endpoints — persistent like state for posts and reply messages."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request

from audit import record_audit
from auth import AuthUser, get_current_user
from db.connection import get_db
from models.requests import LikeCreate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/likes", tags=["likes"])


@router.get("/feed/{feed_id}")
async def list_likes_for_feed(
    feed_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Return liked post indices and reply message indices for this feed.

    Returns:
        posts: list of post indices with post-level likes
        replies: dict mapping "postIndex:messageIndex" keys to True
    """
    rows = await db.fetch(
        "SELECT post_index, message_index FROM user_likes WHERE user_id = $1 AND feed_id = $2",
        user.id, feed_id,
    )
    posts = []
    replies: dict[str, bool] = {}
    for row in rows:
        if row["message_index"] == -1:
            posts.append(row["post_index"])
        else:
            replies[f"{row['post_index']}:{row['message_index']}"] = True
    return {"posts": posts, "replies": replies}


@router.post("", status_code=201)
async def create_like(
    body: LikeCreate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Like a post or reply message. Idempotent."""
    # Verify the feed belongs to the caller before persisting any like-state
    # keyed to (feed_id, post_index). Without this, a user who guesses
    # another user's feed_id can seed like rows against it — which then
    # show up in our preference-learning and post-feed alert passes.
    feed_owner = await db.fetchrow(
        "SELECT 1 FROM feeds WHERE id = $1 AND user_id = $2",
        body.feed_id, user.id,
    )
    if not feed_owner:
        raise HTTPException(status_code=404, detail="Feed not found")

    # Single-statement upsert (R10 API-10): the previous SELECT-then-INSERT
    # had a check-then-insert race — two concurrent identical POSTs (a
    # haptic double-fire, or the swipe gutter racing the heart button) both
    # pass the SELECT and the loser raises an unhandled UniqueViolation
    # 500, despite this handler's own docstring promising "Idempotent."
    # ON CONFLICT DO NOTHING is safe here because message_index is
    # NOT NULL DEFAULT -1 on user_likes (infra/postgres/init.sql:239) — it
    # never carries a NULL that would silently evade the UNIQUE constraint.
    row = await db.fetchrow(
        """INSERT INTO user_likes (user_id, feed_id, post_index, message_index, persona_key, post_type, category)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, feed_id, post_index, message_index) DO NOTHING
           RETURNING id""",
        user.id, body.feed_id, body.post_index, body.message_index,
        body.persona_key, body.post_type, body.category,
    )
    if row:
        logger.info("like_created", feed_id=body.feed_id, post_index=body.post_index, message_index=body.message_index)
        return {"id": str(row["id"]), "status": "created"}

    existing = await db.fetchrow(
        "SELECT id FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        user.id, body.feed_id, body.post_index, body.message_index,
    )
    return {"id": str(existing["id"]), "status": "already_liked"}


@router.delete("/feed/{feed_id}/{post_index}", status_code=204)
async def delete_like(
    feed_id: str,
    post_index: int,
    request: Request,
    message_index: int = -1,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Unlike a post or reply message."""
    result = await db.execute(
        "DELETE FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        user.id, feed_id, post_index, message_index,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Like not found")
    logger.info("like_deleted", feed_id=feed_id, post_index=post_index, message_index=message_index)

    await record_audit(
        db, request, user,
        action="like.delete", resource_type="like",
        metadata={
            "feed_id": feed_id,
            "post_index": post_index,
            "message_index": message_index,
        },
        status_code=204,
    )


@router.get("/preferences")
async def get_preferences(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Return computed preference profile from likes data."""
    row = await db.fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        user.id,
    )
    if row:
        settings = row["settings"]
        if isinstance(settings, str):
            settings = json.loads(settings)
        prefs = settings.get("preferences")
        if prefs:
            return prefs

    likes = await db.fetch(
        "SELECT persona_key, post_type, category FROM user_likes WHERE user_id = $1",
        user.id,
    )
    total = len(likes)
    return {
        "persona_weights": {},
        "post_type_weights": {},
        "category_weights": {},
        "liked_paper_titles": [],
        "total_likes": total,
        "has_signal": False,
    }


@router.get("/stats")
async def get_like_stats(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Quick stats on like activity."""
    total = await db.fetchval(
        "SELECT COUNT(*) FROM user_likes WHERE user_id = $1",
        user.id,
    )
    return {"total_likes": total}
