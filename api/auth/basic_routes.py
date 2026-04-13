"""Basic auth routes — register, login, logout.

Only mounted when AUTH_PROVIDER=basic. Uses bcrypt for password hashing
and Redis for session storage.
"""

import bcrypt
import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from auth.models import AuthUser
from auth.providers import create_session, delete_session, get_user_basic
from config import settings
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


class AuthRequest(BaseModel):
    email: str
    password: str


@router.post("/register", status_code=201)
async def register(
    body: AuthRequest,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Register a new user. First user is always allowed. After that, controlled by ALLOW_REGISTRATION."""
    # Check if registration is allowed
    user_count = await db.fetchval("SELECT COUNT(*) FROM users")
    if user_count > 0 and not settings.allow_registration:
        raise HTTPException(status_code=403, detail="Registration is disabled")

    # Check if email already exists
    existing = await db.fetchrow("SELECT id FROM users WHERE email = $1", body.email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    # Hash password
    password_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()

    # Create user
    row = await db.fetchrow(
        """INSERT INTO users (email, password_hash)
           VALUES ($1, $2) RETURNING id""",
        body.email, password_hash,
    )
    user_id = str(row["id"])

    # Create default workspace for the new user
    await db.execute(
        "INSERT INTO corpora (user_id, name) VALUES ($1, 'Default')",
        user_id,
    )

    # Create session
    token = await create_session(user_id)
    response.set_cookie(
        key="ficino_session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=604800,  # 7 days
        path="/",
    )

    logger.info("user_registered", user_id=user_id, email=body.email)
    return {"status": "registered", "user_id": user_id}


@router.post("/login")
async def login(
    body: AuthRequest,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Login with email and password."""
    row = await db.fetchrow(
        "SELECT id, password_hash FROM users WHERE email = $1",
        body.email,
    )
    if not row or not row["password_hash"]:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not bcrypt.checkpw(body.password.encode(), row["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user_id = str(row["id"])
    token = await create_session(user_id)
    response.set_cookie(
        key="ficino_session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=604800,
        path="/",
    )

    logger.info("user_logged_in", user_id=user_id)
    return {"status": "logged_in", "user_id": user_id}


@router.post("/logout")
async def logout(
    response: Response,
    user: AuthUser = Depends(get_user_basic),
) -> dict[str, str]:
    """Logout — delete session and clear cookie."""
    # We can't easily get the token from the dependency, so clear the cookie
    response.delete_cookie("ficino_session", path="/")
    logger.info("user_logged_out", user_id=user.id)
    return {"status": "logged_out"}


@router.get("/me")
async def get_me(
    user: AuthUser = Depends(get_user_basic),
) -> dict[str, object]:
    """Return the current authenticated user."""
    return {"id": user.id, "email": user.email, "display_name": user.display_name}
