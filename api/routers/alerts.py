"""Alert endpoints — learning insight notifications."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends

from auth import AuthUser, get_current_user
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("")
async def list_alerts(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all non-dismissed alerts, newest first."""
    rows = await db.fetch(
        """SELECT id, alert_type, title, body, metadata, read, created_at
           FROM alerts
           WHERE user_id = $1 AND dismissed = false
           ORDER BY created_at DESC
           LIMIT 50""",
        user.id,
    )
    results = []
    for row in rows:
        meta = row["metadata"]
        if isinstance(meta, str):
            meta = json.loads(meta)
        results.append({
            "id": str(row["id"]),
            "type": row["alert_type"],
            "title": row["title"],
            "body": row["body"],
            "metadata": meta,
            "read": row["read"],
            "created_at": row["created_at"],
        })
    return results


@router.get("/unread-count")
async def get_unread_count(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, int]:
    """Get count of unread alerts."""
    count = await db.fetchval(
        "SELECT COUNT(*) FROM alerts WHERE user_id = $1 AND read = false AND dismissed = false",
        user.id,
    )
    return {"count": count}


@router.put("/{alert_id}/read")
async def mark_read(
    alert_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Mark an alert as read."""
    await db.execute(
        "UPDATE alerts SET read = true WHERE id = $1 AND user_id = $2",
        alert_id, user.id,
    )
    return {"status": "ok"}


@router.put("/read-all")
async def mark_all_read(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Mark all alerts as read."""
    await db.execute(
        "UPDATE alerts SET read = true WHERE user_id = $1 AND dismissed = false",
        user.id,
    )
    return {"status": "ok"}


@router.delete("/{alert_id}")
async def dismiss_alert(
    alert_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Dismiss an alert (hide it permanently)."""
    await db.execute(
        "UPDATE alerts SET dismissed = true WHERE id = $1 AND user_id = $2",
        alert_id, user.id,
    )
    return {"status": "ok"}
