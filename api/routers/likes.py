"""Like endpoints — persistent like state for posts and reply messages."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from constants import STUB_USER_ID
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/likes", tags=["likes"])


class LikeCreate(BaseModel):
    feed_id: str
    post_index: int
    message_index: int = -1  # -1 = post-level, 0+ = reply message index
    persona_key: str | None = None
    post_type: str | None = None
    category: str | None = None


@router.get("/feed/{feed_id}")
async def list_likes_for_feed(
    feed_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Return liked post indices and reply message indices for this feed.

    Returns:
        posts: list of post indices with post-level likes
        replies: dict mapping "postIndex:messageIndex" keys to True
    """
    rows = await db.fetch(
        "SELECT post_index, message_index FROM user_likes WHERE user_id = $1 AND feed_id = $2",
        STUB_USER_ID, feed_id,
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
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Like a post or reply message. Idempotent."""
    existing = await db.fetchrow(
        "SELECT id FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        STUB_USER_ID, body.feed_id, body.post_index, body.message_index,
    )
    if existing:
        return {"id": str(existing["id"]), "status": "already_liked"}

    row = await db.fetchrow(
        """INSERT INTO user_likes (user_id, feed_id, post_index, message_index, persona_key, post_type, category)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id""",
        STUB_USER_ID, body.feed_id, body.post_index, body.message_index,
        body.persona_key, body.post_type, body.category,
    )
    logger.info("like_created", feed_id=body.feed_id, post_index=body.post_index, message_index=body.message_index)
    return {"id": str(row["id"]), "status": "created"}


@router.delete("/feed/{feed_id}/{post_index}", status_code=204)
async def delete_like(
    feed_id: str,
    post_index: int,
    message_index: int = -1,
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Unlike a post or reply message."""
    result = await db.execute(
        "DELETE FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        STUB_USER_ID, feed_id, post_index, message_index,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Like not found")
    logger.info("like_deleted", feed_id=feed_id, post_index=post_index, message_index=message_index)


@router.get("/preferences")
async def get_preferences(
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Return computed preference profile from likes data."""
    row = await db.fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        STUB_USER_ID,
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
        STUB_USER_ID,
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
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Quick stats on like activity."""
    total = await db.fetchval(
        "SELECT COUNT(*) FROM user_likes WHERE user_id = $1",
        STUB_USER_ID,
    )
    return {"total_likes": total}
