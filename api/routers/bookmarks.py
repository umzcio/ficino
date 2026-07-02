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
    # Cap at 500 to keep the list mount fast. Each bookmark carries a
    # ~2KB JSONB post_snapshot; an unbounded list at 5000 bookmarks is
    # ~10 MB per app mount. Enough headroom for a power user to scroll,
    # and a dedicated paginated view can come later if needed.
    rows = await db.fetch(
        """SELECT id, feed_id, post_index, message_index, post_snapshot, bookmarked_at
           FROM bookmarks
           WHERE user_id = $1
           ORDER BY bookmarked_at DESC
           LIMIT 500""",
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
    # Verify the feed belongs to the caller before persisting anything keyed
    # to (feed_id, post_index). Without this, a user can bookmark positions
    # in another user's feed and — because the snapshot is client-supplied —
    # stamp arbitrary content into their own bookmark list anchored to a
    # foreign feed_id.
    feed_owner = await db.fetchrow(
        "SELECT 1 FROM feeds WHERE id = $1 AND user_id = $2",
        body.feed_id, user.id,
    )
    if not feed_owner:
        raise HTTPException(status_code=404, detail="Feed not found")

    # Single-statement upsert (R10 API-10): the previous SELECT-then-INSERT
    # had a check-then-insert race — two concurrent identical POSTs both
    # pass the SELECT and the loser raises an unhandled UniqueViolation
    # 500. ON CONFLICT DO NOTHING is safe here because message_index is
    # NOT NULL DEFAULT -1 on bookmarks (infra/postgres/init.sql:150) — it
    # never carries a NULL that would silently evade the UNIQUE constraint.
    snapshot_json = json.dumps(body.post_snapshot, default=str)
    row = await db.fetchrow(
        """INSERT INTO bookmarks (user_id, feed_id, post_index, message_index, post_snapshot)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, feed_id, post_index, message_index) DO NOTHING
           RETURNING id""",
        user.id, body.feed_id, body.post_index, body.message_index, snapshot_json,
    )
    if row:
        logger.info("bookmark_created", feed_id=body.feed_id, post_index=body.post_index, message_index=body.message_index)
        return {"id": str(row["id"]), "status": "created"}

    existing = await db.fetchrow(
        "SELECT id FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        user.id, body.feed_id, body.post_index, body.message_index,
    )
    return {"id": str(existing["id"]), "status": "already_bookmarked"}


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
    # Intentionally idempotent: unlike delete_bookmark (by id) above, this
    # removes by composite key from a client that only knows "is this post
    # bookmarked", not the bookmark's id — a toggle-off on an already-absent
    # bookmark is a no-op success, not a 404 (R10 BP-3; see review/round10/
    # best-practices.md BP-3 for the coexisting-DELETE-contracts survey).
    await db.execute(
        "DELETE FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        user.id, feed_id, post_index, message_index,
    )
