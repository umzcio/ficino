"""Bookmark endpoints — save post snapshots independent of feed lifecycle."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/bookmarks", tags=["bookmarks"])

STUB_USER_ID = "00000000-0000-0000-0000-000000000000"


class BookmarkCreate(BaseModel):
    feed_id: str
    post_index: int
    post_snapshot: dict


@router.get("")
async def list_bookmarks(
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all bookmarked posts for the current user, newest first."""
    rows = await db.fetch(
        """SELECT id, feed_id, post_index, post_snapshot, bookmarked_at
           FROM bookmarks
           WHERE user_id = $1
           ORDER BY bookmarked_at DESC""",
        STUB_USER_ID,
    )
    results = []
    for row in rows:
        snapshot = row["post_snapshot"]
        if isinstance(snapshot, str):
            snapshot = json.loads(snapshot)
        results.append({
            "id": str(row["id"]),
            "feed_id": str(row["feed_id"]),
            "post_index": row["post_index"],
            "post": snapshot,
            "bookmarked_at": row["bookmarked_at"],
        })
    return results


@router.post("", status_code=201)
async def create_bookmark(
    body: BookmarkCreate,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Bookmark a post by saving a snapshot."""
    # Check if already bookmarked
    existing = await db.fetchrow(
        "SELECT id FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = $3",
        STUB_USER_ID, body.feed_id, body.post_index,
    )
    if existing:
        return {"id": str(existing["id"]), "status": "already_bookmarked"}

    snapshot_json = json.dumps(body.post_snapshot, default=str)
    row = await db.fetchrow(
        """INSERT INTO bookmarks (user_id, feed_id, post_index, post_snapshot)
           VALUES ($1, $2, $3, $4) RETURNING id""",
        STUB_USER_ID, body.feed_id, body.post_index, snapshot_json,
    )
    logger.info("bookmark_created", feed_id=body.feed_id, post_index=body.post_index)
    return {"id": str(row["id"]), "status": "created"}


@router.delete("/{bookmark_id}", status_code=204)
async def delete_bookmark(
    bookmark_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Remove a bookmark."""
    result = await db.execute(
        "DELETE FROM bookmarks WHERE id = $1 AND user_id = $2",
        bookmark_id, STUB_USER_ID,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Bookmark not found")
    logger.info("bookmark_deleted", bookmark_id=bookmark_id)


@router.delete("/post/{feed_id}/{post_index}", status_code=204)
async def delete_bookmark_by_post(
    feed_id: str,
    post_index: int,
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Remove a bookmark by feed_id + post_index."""
    await db.execute(
        "DELETE FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = $3",
        STUB_USER_ID, feed_id, post_index,
    )
