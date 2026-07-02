"""Workspace (corpora) management endpoints."""

from datetime import datetime, timezone

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import AuthUser, get_current_user
from constants import DEFAULT_WORKSPACE_ID
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/workspaces", tags=["workspaces"])


def _activity_sort_key(activity: dict[str, object]) -> datetime:
    """Sort key for get_workspace_activity (R10 API-13).

    Timestamps come from asyncpg as `datetime` objects; `papers.uploaded_at`
    and `feeds.generated_at` are both nullable columns. The previous
    `a["timestamp"] or ""` fallback substituted a str for a NULL timestamp,
    which raises `TypeError: '<' not supported between instances of
    'datetime.datetime' and 'str'` the moment any row's timestamp is NULL —
    the None-guard was the very thing that crashed the endpoint. Falling
    back to `datetime.min` (tz-aware, to match the tz-aware asyncpg values)
    keeps every key comparable and sorts NULL timestamps as oldest.
    """
    return activity["timestamp"] or datetime.min.replace(tzinfo=timezone.utc)


async def get_or_create_default_workspace(
    db: asyncpg.Connection, user_id: str
) -> str:
    """Return the caller's earliest workspace id, creating one if none exist.

    Used by `delete_workspace` to move orphaned papers somewhere owned by the
    same user rather than into the shared stub `DEFAULT_WORKSPACE_ID` (which
    would leak papers across users under multi-user auth).
    """
    row = await db.fetchrow(
        "SELECT id FROM corpora WHERE user_id = $1 ORDER BY created_at LIMIT 1",
        user_id,
    )
    if row:
        return str(row["id"])
    row = await db.fetchrow(
        "INSERT INTO corpora (user_id, name) VALUES ($1, 'Default') RETURNING id",
        user_id,
    )
    return str(row["id"])


class WorkspaceCreate(BaseModel):
    name: str


class WorkspaceUpdate(BaseModel):
    name: str


@router.get("")
async def list_workspaces(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all workspaces with paper/feed counts."""
    # Previous query LEFT JOINed papers × feeds on the same corpus_id
    # and used COUNT(DISTINCT ...) to undo the cartesian product. With
    # 100 papers × 50 feeds that's 5000 intermediate rows per workspace
    # before aggregation. Split into two scalar subqueries (each goes
    # through the corpus_id index) plus a last-activity lookup.
    rows = await db.fetch(
        """SELECT c.id, c.name, c.created_at,
                  (SELECT COUNT(*) FROM papers p WHERE p.corpus_id = c.id) AS paper_count,
                  (SELECT COUNT(*) FROM feeds f WHERE f.corpus_id = c.id) AS feed_count,
                  GREATEST(
                    (SELECT MAX(generated_at) FROM feeds WHERE corpus_id = c.id),
                    (SELECT MAX(uploaded_at) FROM papers WHERE corpus_id = c.id)
                  ) AS last_activity
           FROM corpora c
           WHERE c.user_id = $1
           ORDER BY last_activity DESC NULLS LAST""",
        user.id,
    )
    return [
        {
            "id": str(row["id"]),
            "name": row["name"],
            "paper_count": row["paper_count"],
            "feed_count": row["feed_count"],
            "last_activity": row["last_activity"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


@router.post("", status_code=201)
async def create_workspace(
    body: WorkspaceCreate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Create a new workspace."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Workspace name cannot be empty")

    row = await db.fetchrow(
        "INSERT INTO corpora (user_id, name) VALUES ($1, $2) RETURNING id",
        user.id, name,
    )
    logger.info("workspace_created", name=name)
    return {"id": str(row["id"]), "name": name}


@router.put("/{workspace_id}")
async def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Rename a workspace."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Workspace name cannot be empty")

    result = await db.execute(
        "UPDATE corpora SET name = $1 WHERE id = $2 AND user_id = $3",
        name, workspace_id, user.id,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Workspace not found")
    return {"id": workspace_id, "name": name}


@router.delete("/{workspace_id}", status_code=204)
async def delete_workspace(
    workspace_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Delete a workspace. Cannot delete the last workspace."""
    if workspace_id == DEFAULT_WORKSPACE_ID:
        raise HTTPException(status_code=400, detail="Cannot delete the default workspace")

    count = await db.fetchval(
        "SELECT COUNT(*) FROM corpora WHERE user_id = $1", user.id
    )
    if count <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete your only workspace")

    # Move papers to the caller's own default workspace before deleting.
    # Previously this moved them into the global stub DEFAULT_WORKSPACE_ID,
    # which under multi-user auth would orphan one user's papers into a
    # workspace owned by the stub user (cross-tenant leak). Find-or-create
    # a per-user default instead, and scope the UPDATE by user_id so we can
    # never accidentally touch another user's papers that happen to reference
    # the same corpus_id.
    target = await get_or_create_default_workspace(db, user.id)
    if target == workspace_id:
        # The only other workspace happens to be the one being deleted. The
        # count guard above should prevent this, but belt-and-suspenders: pick
        # any other workspace owned by the caller.
        other = await db.fetchrow(
            "SELECT id FROM corpora WHERE user_id = $1 AND id != $2 "
            "ORDER BY created_at LIMIT 1",
            user.id, workspace_id,
        )
        if other:
            target = str(other["id"])
    await db.execute(
        "UPDATE papers SET corpus_id = $1 WHERE corpus_id = $2 AND user_id = $3",
        target, workspace_id, user.id,
    )
    # Intentionally idempotent on a missing/already-deleted workspace_id: the
    # guards above (default-workspace check, "only workspace" count check,
    # and the paper-move) already ran against the caller's *other* owned
    # workspaces, so a final DELETE that matches 0 rows here just means the
    # target was already gone — same "toggle off" shape as bookmarks/tags'
    # composite-key deletes, not a resource lookup that should 404 (R10 BP-3).
    await db.execute(
        "DELETE FROM corpora WHERE id = $1 AND user_id = $2",
        workspace_id, user.id,
    )
    logger.info("workspace_deleted", workspace_id=workspace_id, moved_papers_to=target)


@router.get("/{workspace_id}/activity")
async def get_workspace_activity(
    workspace_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """Get recent activity for a workspace."""
    # Verify workspace belongs to user
    owner = await db.fetchrow(
        "SELECT id FROM corpora WHERE id = $1 AND user_id = $2",
        workspace_id, user.id,
    )
    if not owner:
        raise HTTPException(status_code=404, detail="Workspace not found")

    activities: list[dict[str, object]] = []

    # Recent paper uploads
    papers = await db.fetch(
        """SELECT id, title, filename, uploaded_at, status, chunk_count
           FROM papers WHERE user_id = $2 AND corpus_id = $1
           ORDER BY uploaded_at DESC LIMIT 10""",
        workspace_id, user.id,
    )
    for p in papers:
        activities.append({
            "type": "paper_upload",
            "title": p["title"] or p["filename"],
            "detail": f"{p['chunk_count']} chunks · {p['status']}",
            "timestamp": p["uploaded_at"],
        })

    # Recent feed generations
    feeds = await db.fetch(
        """SELECT id, post_count, paper_count, generated_at, generation_duration_ms
           FROM feeds WHERE user_id = $2 AND corpus_id = $1
           ORDER BY generated_at DESC LIMIT 10""",
        workspace_id, user.id,
    )
    for f in feeds:
        duration = f["generation_duration_ms"]
        detail = f"{f['post_count']} posts · {f['paper_count']} papers"
        if duration:
            detail += f" · {duration // 1000}s"
        activities.append({
            "type": "feed_generation",
            "title": "Generated feed",
            "detail": detail,
            "timestamp": f["generated_at"],
        })

    # Sort by timestamp descending
    activities.sort(key=_activity_sort_key, reverse=True)
    return activities[:20]
