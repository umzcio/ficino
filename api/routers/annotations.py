"""Annotation endpoints — private user notes on posts."""

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import AuthUser, get_current_user
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/annotations", tags=["annotations"])


class AnnotationUpsert(BaseModel):
    body: str


@router.get("")
async def list_annotations(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all annotations for the current user."""
    rows = await db.fetch(
        """SELECT id, feed_id, post_index, body, created_at, updated_at
           FROM annotations WHERE user_id = $1
           ORDER BY updated_at DESC""",
        user.id,
    )
    return [
        {
            "id": str(r["id"]),
            "feed_id": str(r["feed_id"]),
            "post_index": r["post_index"],
            "body": r["body"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
        for r in rows
    ]


@router.get("/{feed_id}/{post_index}")
async def get_annotation(
    feed_id: str,
    post_index: int,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get annotation for a specific post."""
    row = await db.fetchrow(
        "SELECT id, body, created_at, updated_at FROM annotations WHERE user_id = $1 AND feed_id = $2 AND post_index = $3",
        user.id, feed_id, post_index,
    )
    if not row:
        raise HTTPException(status_code=404, detail="No annotation")
    return {
        "id": str(row["id"]),
        "feed_id": feed_id,
        "post_index": post_index,
        "body": row["body"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


@router.put("/{feed_id}/{post_index}")
async def upsert_annotation(
    feed_id: str,
    post_index: int,
    body: AnnotationUpsert,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Create or update an annotation on a post."""
    text = body.body.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Annotation body cannot be empty")

    row = await db.fetchrow(
        """INSERT INTO annotations (user_id, feed_id, post_index, body)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, feed_id, post_index)
           DO UPDATE SET body = $4, updated_at = NOW()
           RETURNING id, created_at, updated_at""",
        user.id, feed_id, post_index, text,
    )
    logger.info("annotation_upserted", feed_id=feed_id, post_index=post_index)
    return {
        "id": str(row["id"]),
        "feed_id": feed_id,
        "post_index": post_index,
        "body": text,
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


@router.delete("/{feed_id}/{post_index}", status_code=204)
async def delete_annotation(
    feed_id: str,
    post_index: int,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Delete an annotation."""
    result = await db.execute(
        "DELETE FROM annotations WHERE user_id = $1 AND feed_id = $2 AND post_index = $3",
        user.id, feed_id, post_index,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Annotation not found")
    logger.info("annotation_deleted", feed_id=feed_id, post_index=post_index)
