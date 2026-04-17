"""Authenticated + signed figure download."""
from __future__ import annotations

import os
from pathlib import Path

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from auth import AuthUser, get_current_user
from config import settings
from db.connection import get_db
from signed_url import verify_token

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/figures", tags=["figures"])


@router.get("/{paper_id}/{figure_id}")
async def serve_figure(
    paper_id: str,
    figure_id: str,
    token: str = Query(..., min_length=10, max_length=200),
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> FileResponse:
    # 1) Token must cover this figure_id and not be expired
    if not verify_token(figure_id, token):
        raise HTTPException(status_code=403, detail="Invalid or expired figure token")

    # 2) Paper must belong to the authenticated user
    row = await db.fetchrow(
        """SELECT f.image_path FROM figures f
           JOIN papers p ON f.paper_id = p.id AND p.user_id = $1
           WHERE f.id = $2 AND f.paper_id = $3""",
        user.id, figure_id, paper_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Figure not found")

    # 3) Resolve on disk; reject any path escape.
    filename = os.path.basename(row["image_path"])
    if not filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid image path")
    full_path = Path(settings.figures_dir).resolve() / filename
    base = Path(settings.figures_dir).resolve()
    try:
        full_path.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path escape detected")
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail="Figure file missing")

    return FileResponse(path=str(full_path), media_type="image/png")
