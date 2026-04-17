"""Basic auth routes — register, login, logout.

Only mounted when AUTH_PROVIDER=basic. Uses bcrypt for password hashing
and Redis for session storage.
"""

import bcrypt
import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from audit import record_audit
from auth.models import AuthUser
from auth.providers import create_session, delete_session, get_user_basic
from auth.rate_limit import IPRateLimit
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
    request: Request,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
    _rl: None = Depends(IPRateLimit("register", 3, 3600)),
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

    # Hash password with explicit cost factor — pin the work factor to avoid
    # surprise drops if the library default changes in a future version.
    password_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt(rounds=12)).decode()

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

    # Create session. Cookie is marked Secure in non-development environments
    # so browsers refuse to send it over HTTP; safe under the local dev HTTP
    # setup because ENVIRONMENT=development there.
    token = await create_session(user_id)
    response.set_cookie(
        key="ficino_session",
        value=token,
        httponly=True,
        samesite="lax",
        secure=settings.environment != "development",
        max_age=604800,  # 7 days
        path="/",
    )

    logger.info("user_registered", user_id=user_id, email=body.email)

    # Build an AuthUser for the audit record — this endpoint doesn't use
    # Depends(get_current_user) since the user doesn't exist yet.
    new_user = AuthUser(id=user_id, email=body.email)
    await record_audit(
        db, request, new_user,
        action="user.register", resource_type="user", resource_id=user_id,
        metadata={"email": body.email},
        status_code=201,
    )

    return {"status": "registered", "user_id": user_id}


@router.post("/login")
async def login(
    body: AuthRequest,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
    _rl: None = Depends(IPRateLimit("login", 5, 900)),
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
        secure=settings.environment != "development",
        max_age=604800,
        path="/",
    )

    logger.info("user_logged_in", user_id=user_id)
    return {"status": "logged_in", "user_id": user_id}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    user: AuthUser = Depends(get_user_basic),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Logout — delete the server-side session and clear the cookie."""
    # Read the token directly from the request so we can invalidate the
    # Redis session — not just the client cookie. Without this step a stolen
    # token stays valid until its 7-day TTL expires.
    token = request.cookies.get("ficino_session")
    if token:
        await delete_session(token)
    response.delete_cookie("ficino_session", path="/")
    logger.info("user_logged_out", user_id=user.id)

    await record_audit(
        db, request, user,
        action="user.logout", resource_type="user", resource_id=user.id,
        status_code=200,
    )

    return {"status": "logged_out"}


@router.get("/me")
async def get_me(
    user: AuthUser = Depends(get_user_basic),
) -> dict[str, object]:
    """Return the current authenticated user."""
    return {"id": user.id, "email": user.email, "display_name": user.display_name}
