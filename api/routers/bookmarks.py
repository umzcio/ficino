"""Bookmark endpoints — save post snapshots independent of feed lifecycle."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from audit import record_audit
from auth import AuthUser, get_current_user
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/bookmarks", tags=["bookmarks"])


class BookmarkCreate(BaseModel):
    feed_id: str
    post_index: int
    message_index: int = -1  # -1 = post-level, 0+ = reply message index
    post_snapshot: dict


@router.get("")
async def list_bookmarks(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all bookmarked posts for the current user, newest first."""
    rows = await db.fetch(
        """SELECT id, feed_id, post_index, message_index, post_snapshot, bookmarked_at
           FROM bookmarks
           WHERE user_id = $1
           ORDER BY bookmarked_at DESC""",
        user.id,
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
            "message_index": row["message_index"],
            "post": snapshot,
            "bookmarked_at": row["bookmarked_at"],
        })
    return results


@router.post("", status_code=201)
async def create_bookmark(
    body: BookmarkCreate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Bookmark a post by saving a snapshot."""
    # Check if already bookmarked
    existing = await db.fetchrow(
        "SELECT id FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        user.id, body.feed_id, body.post_index, body.message_index,
    )
    if existing:
        return {"id": str(existing["id"]), "status": "already_bookmarked"}

    snapshot_json = json.dumps(body.post_snapshot, default=str)
    row = await db.fetchrow(
        """INSERT INTO bookmarks (user_id, feed_id, post_index, message_index, post_snapshot)
           VALUES ($1, $2, $3, $4, $5) RETURNING id""",
        user.id, body.feed_id, body.post_index, body.message_index, snapshot_json,
    )
    logger.info("bookmark_created", feed_id=body.feed_id, post_index=body.post_index, message_index=body.message_index)
    return {"id": str(row["id"]), "status": "created"}


@router.delete("/{bookmark_id}", status_code=204)
async def delete_bookmark(
    bookmark_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Remove a bookmark."""
    result = await db.execute(
        "DELETE FROM bookmarks WHERE id = $1 AND user_id = $2",
        bookmark_id, user.id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Bookmark not found")
    logger.info("bookmark_deleted", bookmark_id=bookmark_id)

    await record_audit(
        db, request, user,
        action="bookmark.delete", resource_type="bookmark", resource_id=bookmark_id,
        status_code=204,
    )


@router.delete("/post/{feed_id}/{post_index}", status_code=204)
async def delete_bookmark_by_post(
    feed_id: str,
    post_index: int,
    message_index: int = -1,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Remove a bookmark by feed_id + post_index + message_index."""
    await db.execute(
        "DELETE FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        user.id, feed_id, post_index, message_index,
    )
