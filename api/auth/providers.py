"""Auth provider implementations — none, basic, supabase.

Each provider is an async function with the same signature that extracts
user identity from the request and returns an AuthUser.
"""

import secrets

import asyncpg
import structlog
from fastapi import Depends, HTTPException, Request

from auth.models import AuthUser
from config import settings
from constants import STUB_USER_ID
from db.connection import get_db

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Provider: none — stub user, no auth (self-hosted default)
# ---------------------------------------------------------------------------

async def get_user_none(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
) -> AuthUser:
    """No authentication. Returns the stub user for self-hosted single-user instances."""
    return AuthUser(id=STUB_USER_ID, email="stub@ficino.dev", display_name="You")


# ---------------------------------------------------------------------------
# Provider: basic — email/password with Redis sessions
# ---------------------------------------------------------------------------

_redis_client = None


async def _get_redis():
    """Lazy-init async Redis client."""
    global _redis_client
    if _redis_client is None:
        import redis.asyncio as aioredis
        _redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


async def get_user_basic(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
) -> AuthUser:
    """Session cookie authentication. Reads ficino_session cookie, looks up in Redis."""
    token = request.cookies.get("ficino_session")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    redis = await _get_redis()
    user_id = await redis.get(f"session:{token}")
    if not user_id:
        raise HTTPException(status_code=401, detail="Session expired")

    # Refresh session TTL (sliding window)
    await redis.expire(f"session:{token}", 604800)  # 7 days

    # Fetch user from DB
    row = await db.fetchrow(
        "SELECT id, email, display_name FROM users WHERE id = $1",
        user_id,
    )
    if not row:
        raise HTTPException(status_code=401, detail="User not found")

    return AuthUser(
        id=str(row["id"]),
        email=row["email"],
        display_name=row["display_name"],
    )


async def create_session(user_id: str) -> str:
    """Create a Redis session and return the token."""
    redis = await _get_redis()
    token = secrets.token_urlsafe(32)
    await redis.set(f"session:{token}", user_id, ex=604800)  # 7 days
    return token


async def delete_session(token: str) -> None:
    """Delete a Redis session."""
    redis = await _get_redis()
    await redis.delete(f"session:{token}")


# ---------------------------------------------------------------------------
# Provider: supabase — JWT verification
# ---------------------------------------------------------------------------

# Supabase rotated default signing from legacy HS256 (shared HMAC secret) to
# asymmetric ECDSA (ES256) / RSA (RS256) tokens with keys exposed via JWKS.
# Project age decides which you get: older projects still use HS256, newer
# ones use ES256/RS256. We support both paths:
#   * If the token's header carries a `kid`, look up the key via the JWKS
#     endpoint and verify with the declared algorithm.
#   * Otherwise fall back to HS256 with SUPABASE_JWT_SECRET.
#
# PyJWKClient caches keys for an hour by default and re-fetches on a `kid`
# miss, so key rotations handle themselves without a redeploy.
_jwks_client = None


def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None and settings.supabase_url:
        import jwt as _jwt
        _jwks_client = _jwt.PyJWKClient(
            f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json",
            cache_jwk_set=True,
            lifespan=3600,
        )
    return _jwks_client


async def get_user_supabase(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
) -> AuthUser:
    """Supabase JWT authentication. Verifies token and upserts local user."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization header")

    token = auth_header[7:]

    try:
        import jwt

        # Look at the token's header to decide which verification path to
        # take. No signature check here — we just read the `kid` / `alg`.
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")
        alg = unverified_header.get("alg", "HS256")

        if kid and alg != "HS256":
            # Asymmetric path: fetch the signing key from Supabase's JWKS
            # endpoint by kid and verify with the declared algorithm.
            jwks = _get_jwks_client()
            if jwks is None:
                raise RuntimeError("SUPABASE_URL must be set to verify asymmetric tokens")
            signing_key = jwks.get_signing_key_from_jwt(token).key
            payload = jwt.decode(
                token,
                signing_key,
                algorithms=[alg],
                audience="authenticated",
            )
        else:
            # Legacy HMAC path (older Supabase projects).
            payload = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
    except Exception as e:
        logger.warn("supabase_jwt_invalid", error=str(e))
        raise HTTPException(status_code=401, detail="Invalid token")

    sub = payload.get("sub")
    email = payload.get("email", "")
    if not sub:
        raise HTTPException(status_code=401, detail="Invalid token: missing sub")

    # Upsert user in local DB (clerk_id stores the Supabase sub). xmax=0
    # in the returning row means Postgres actually inserted (vs. updated),
    # which lets us seed a default workspace exactly once per user without
    # a separate existence check or a race with concurrent first sign-ins.
    row = await db.fetchrow(
        """INSERT INTO users (clerk_id, email)
           VALUES ($1, $2)
           ON CONFLICT (clerk_id) DO UPDATE SET email = $2
           RETURNING id, email, display_name, (xmax = 0) AS inserted""",
        sub, email,
    )

    if row["inserted"]:
        # Seed a default workspace so the app has somewhere to put this
        # user's first paper — otherwise the upload route 404s on the
        # missing DEFAULT_WORKSPACE_ID lookup. Mirrors basic_routes.register.
        await db.execute(
            "INSERT INTO corpora (user_id, name) VALUES ($1, 'Default')",
            str(row["id"]),
        )
        logger.info("supabase_user_bootstrapped", user_id=str(row["id"]))

    return AuthUser(
        id=str(row["id"]),
        email=row["email"],
        display_name=row["display_name"],
    )
