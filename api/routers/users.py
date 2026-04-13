"""User profile and corpus management endpoints."""

import structlog
from fastapi import APIRouter, Depends, HTTPException

from auth import AuthUser, get_current_user
from db.connection import get_db
from models.user import UserUpdate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me")
async def get_current_user_profile(
    user: AuthUser = Depends(get_current_user),
    db=Depends(get_db),
):
    """Return the authenticated user's profile."""
    row = await db.fetchrow(
        "SELECT id, email, display_name, created_at FROM users WHERE id = $1",
        user.id,
    )
    if not row:
        raise HTTPException(404, "User not found")
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "display_name": row["display_name"],
        "created_at": row["created_at"],
    }


@router.put("/me")
async def update_user_profile(
    body: UserUpdate,
    user: AuthUser = Depends(get_current_user),
    db=Depends(get_db),
):
    """Update the authenticated user's profile."""
    updates = body.model_dump(exclude_unset=True)
    if "display_name" in updates:
        await db.execute(
            "UPDATE users SET display_name = $1 WHERE id = $2",
            updates["display_name"],
            user.id,
        )
    row = await db.fetchrow(
        "SELECT id, email, display_name, created_at FROM users WHERE id = $1",
        user.id,
    )
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "display_name": row["display_name"],
        "created_at": row["created_at"],
    }
