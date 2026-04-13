"""Workspace (corpora) management endpoints."""

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import AuthUser, get_current_user
from constants import DEFAULT_WORKSPACE_ID
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/workspaces", tags=["workspaces"])


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
    rows = await db.fetch(
        """SELECT c.id, c.name, c.created_at,
                  COUNT(DISTINCT p.id) FILTER (WHERE p.id IS NOT NULL) AS paper_count,
                  COUNT(DISTINCT f.id) FILTER (WHERE f.id IS NOT NULL) AS feed_count,
                  MAX(COALESCE(f.generated_at, p.uploaded_at)) AS last_activity
           FROM corpora c
           LEFT JOIN papers p ON p.corpus_id = c.id
           LEFT JOIN feeds f ON f.corpus_id = c.id
           WHERE c.user_id = $1
           GROUP BY c.id
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

    # Move papers to default before deleting
    await db.execute(
        "UPDATE papers SET corpus_id = $1 WHERE corpus_id = $2",
        DEFAULT_WORKSPACE_ID, workspace_id,
    )
    await db.execute(
        "DELETE FROM corpora WHERE id = $1 AND user_id = $2",
        workspace_id, user.id,
    )
    logger.info("workspace_deleted", workspace_id=workspace_id)


@router.get("/{workspace_id}/activity")
async def get_workspace_activity(
    workspace_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """Get recent activity for a workspace."""
    activities: list[dict[str, object]] = []

    # Recent paper uploads
    papers = await db.fetch(
        """SELECT id, title, filename, uploaded_at, status, chunk_count
           FROM papers WHERE corpus_id = $1
           ORDER BY uploaded_at DESC LIMIT 10""",
        workspace_id,
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
           FROM feeds WHERE corpus_id = $1
           ORDER BY generated_at DESC LIMIT 10""",
        workspace_id,
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
    activities.sort(key=lambda a: a["timestamp"] or "", reverse=True)
    return activities[:20]
