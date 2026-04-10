"""User profile and corpus management endpoints."""

from datetime import datetime, timezone
from uuid import uuid4

import structlog
from fastapi import APIRouter

from models.user import User, UserUpdate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=User)
async def get_current_user() -> User:
    """Return the authenticated user's profile."""
    logger.info("user_me_stub")
    return User(
        id=uuid4(),
        email="stub@ficino.dev",
        display_name="Stub User",
        corpora=[],
        created_at=datetime.now(timezone.utc),
    )


@router.put("/me", response_model=User)
async def update_current_user(body: UserUpdate) -> User:
    """Update the authenticated user's profile."""
    logger.info("user_update_stub", updates=body.model_dump(exclude_unset=True))
    return User(
        id=uuid4(),
        email="stub@ficino.dev",
        display_name=body.display_name or "Stub User",
        default_corpus_id=body.default_corpus_id,
        corpora=[],
        created_at=datetime.now(timezone.utc),
    )
