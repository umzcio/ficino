"""Tag management and paper tagging endpoints."""

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from audit import record_audit
from auth import AuthUser, get_current_user
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/tags", tags=["tags"])


class TagCreate(BaseModel):
    name: str


class PaperTagRequest(BaseModel):
    paper_id: str
    tag_name: str


@router.get("")
async def list_tags(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all tags with paper counts."""
    rows = await db.fetch(
        """SELECT t.id, t.name, COUNT(pt.paper_id) AS paper_count
           FROM tags t
           LEFT JOIN paper_tags pt ON t.id = pt.tag_id
           WHERE t.user_id = $1
           GROUP BY t.id, t.name
           ORDER BY t.name""",
        user.id,
    )
    return [
        {"id": str(row["id"]), "name": row["name"], "paper_count": row["paper_count"]}
        for row in rows
    ]


@router.post("", status_code=201)
async def create_tag(
    body: TagCreate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Create a new tag."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tag name cannot be empty")

    existing = await db.fetchrow(
        "SELECT id FROM tags WHERE user_id = $1 AND name = $2",
        user.id, name,
    )
    if existing:
        return {"id": str(existing["id"]), "name": name}

    row = await db.fetchrow(
        "INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id",
        user.id, name,
    )
    logger.info("tag_created", name=name)
    return {"id": str(row["id"]), "name": name}


@router.delete("/{tag_id}", status_code=204)
async def delete_tag(
    tag_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Delete a tag."""
    result = await db.execute("DELETE FROM tags WHERE id = $1 AND user_id = $2", tag_id, user.id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Tag not found")
    logger.info("tag_deleted", tag_id=tag_id)

    await record_audit(
        db, request, user,
        action="tag.delete", resource_type="tag", resource_id=tag_id,
        status_code=204,
    )


@router.post("/assign", status_code=201)
async def assign_tag(
    body: PaperTagRequest,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Add a tag to a paper. Creates the tag if it doesn't exist."""
    name = body.tag_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tag name cannot be empty")

    # Verify the paper belongs to the caller — prevents tagging other users' papers
    owned_paper = await db.fetchrow(
        "SELECT id FROM papers WHERE id = $1 AND user_id = $2",
        body.paper_id, user.id,
    )
    if not owned_paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    # Get or create tag
    tag = await db.fetchrow(
        "SELECT id FROM tags WHERE user_id = $1 AND name = $2",
        user.id, name,
    )
    if not tag:
        tag = await db.fetchrow(
            "INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id",
            user.id, name,
        )

    tag_id = str(tag["id"])

    # Assign to paper (ignore if already assigned)
    await db.execute(
        "INSERT INTO paper_tags (paper_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        body.paper_id, tag_id,
    )
    logger.info("tag_assigned", paper_id=body.paper_id, tag=name)
    return {"paper_id": body.paper_id, "tag_id": tag_id, "tag_name": name}


@router.delete("/assign/{paper_id}/{tag_id}", status_code=204)
async def unassign_tag(
    paper_id: str,
    tag_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Remove a tag from a paper."""
    # Intentionally idempotent: same "toggle off a composite-key membership
    # row" shape as bookmarks.delete_bookmark_by_post — the caller is
    # un-tagging a paper it believes is tagged, so a paper/tag pair that's
    # already untagged is a no-op success, not a 404 (R10 BP-3).
    await db.execute(
        """DELETE FROM paper_tags
           WHERE paper_id = $1 AND tag_id = $2
             AND paper_id IN (SELECT id FROM papers WHERE user_id = $3)
             AND tag_id IN (SELECT id FROM tags WHERE user_id = $3)""",
        paper_id, tag_id, user.id,
    )
    logger.info("tag_unassigned", paper_id=paper_id, tag_id=tag_id)

    await record_audit(
        db, request, user,
        action="tag.unassign", resource_type="paper", resource_id=paper_id,
        metadata={"tag_id": tag_id},
        status_code=204,
    )


@router.get("/paper/{paper_id}")
async def get_paper_tags(
    paper_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, str]]:
    """Get all tags for a paper."""
    rows = await db.fetch(
        """SELECT t.id, t.name FROM tags t
           JOIN paper_tags pt ON t.id = pt.tag_id
           JOIN papers p ON pt.paper_id = p.id AND p.user_id = $2
           WHERE pt.paper_id = $1
           ORDER BY t.name""",
        paper_id, user.id,
    )
    return [{"id": str(row["id"]), "name": row["name"]} for row in rows]
