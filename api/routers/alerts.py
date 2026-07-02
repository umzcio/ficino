"""Alert endpoints — learning insight notifications."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException

from auth import AuthUser, get_current_user
from constants import MAX_ALERTS_LIST
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
        f"""SELECT id, alert_type, title, body, metadata, read, created_at
           FROM alerts
           WHERE user_id = $1 AND dismissed = false
           ORDER BY created_at DESC
           LIMIT {MAX_ALERTS_LIST}""",
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


@router.delete("/{alert_id}", status_code=204)
async def dismiss_alert(
    alert_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Dismiss an alert (hide it permanently).

    R10 BP-3: was `200 {"status": "ok"}` with no existence check (one of
    three coexisting DELETE contracts in the codebase) — standardized to
    204 + 404-on-missing, matching the pattern-A peers (likes.delete_like,
    bookmarks.delete_bookmark, tags.delete_tag, etc.). Frontend gate:
    `dismissAlert` in lib/api.ts declares `Promise<void>` and its only
    caller (`useAlerts.ts`'s `dismiss`) does `await dismissAlert(id)` and
    discards the result — `request()` already special-cases 204 as
    `undefined`, so this is a non-breaking body change on the wire.
    """
    result = await db.execute(
        "UPDATE alerts SET dismissed = true WHERE id = $1 AND user_id = $2 AND dismissed = false",
        alert_id, user.id,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Alert not found")
    logger.info("alert_dismissed", alert_id=alert_id)
