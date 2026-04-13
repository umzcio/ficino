"""Like endpoints — persistent like state for feed posts."""

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
    persona_key: str | None = None
    post_type: str | None = None
    category: str | None = None


@router.get("/feed/{feed_id}")
async def list_likes_for_feed(
    feed_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> list[int]:
    """Return list of post indices the user has liked in this feed."""
    rows = await db.fetch(
        "SELECT post_index FROM user_likes WHERE user_id = $1 AND feed_id = $2",
        STUB_USER_ID, feed_id,
    )
    return [row["post_index"] for row in rows]


@router.post("", status_code=201)
async def create_like(
    body: LikeCreate,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Like a post. Idempotent — returns existing like if already liked."""
    existing = await db.fetchrow(
        "SELECT id FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = $3",
        STUB_USER_ID, body.feed_id, body.post_index,
    )
    if existing:
        return {"id": str(existing["id"]), "status": "already_liked"}

    row = await db.fetchrow(
        """INSERT INTO user_likes (user_id, feed_id, post_index, persona_key, post_type, category)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id""",
        STUB_USER_ID, body.feed_id, body.post_index,
        body.persona_key, body.post_type, body.category,
    )
    logger.info("like_created", feed_id=body.feed_id, post_index=body.post_index)
    return {"id": str(row["id"]), "status": "created"}


@router.delete("/feed/{feed_id}/{post_index}", status_code=204)
async def delete_like(
    feed_id: str,
    post_index: int,
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Unlike a post."""
    result = await db.execute(
        "DELETE FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = $3",
        STUB_USER_ID, feed_id, post_index,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Like not found")
    logger.info("like_deleted", feed_id=feed_id, post_index=post_index)


@router.get("/preferences")
async def get_preferences(
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Return computed preference profile from likes data.

    Returns the stored preferences if available, otherwise computes on the fly.
    """
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

    # No stored preferences — compute a basic summary
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
