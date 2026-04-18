"""Redis-based rate limiting for expensive endpoints.

Usage:
    from auth.rate_limit import RateLimit

    @router.post("/generate")
    async def generate(user = Depends(get_current_user), _rl = Depends(RateLimit("feed_gen", 20, 86400))):
        ...

The rate limiter uses Redis to track per-user request counts with
sliding window expiry. Returns 429 Too Many Requests when exceeded.
"""

import redis.asyncio as aioredis
import structlog
from fastapi import Depends, HTTPException, Request

from auth import AuthUser, get_current_user
from config import settings

logger = structlog.get_logger(__name__)

_redis_client = None


async def _get_redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


class RateLimit:
    """FastAPI dependency that enforces per-user rate limits via Redis.

    Args:
        key_prefix: identifies the action being limited (e.g., "feed_gen")
        max_requests: maximum requests allowed in the window
        window_seconds: time window in seconds (default 86400 = 24 hours)
    """

    def __init__(self, key_prefix: str, max_requests: int, window_seconds: int = 86400):
        self.key_prefix = key_prefix
        self.max_requests = max_requests
        self.window_seconds = window_seconds

    async def __call__(self, user: AuthUser = Depends(get_current_user)) -> None:
        # Skip rate limiting for AUTH_PROVIDER=none (self-hosted single user)
        if settings.auth_provider == "none":
            return

        redis = await _get_redis()
        key = f"ratelimit:{self.key_prefix}:{user.id}"

        # Atomic INCR-first: the returned value is the post-increment count,
        # so a race between two requests can't both read "N-1" and decide
        # they're under the limit. Only set EXPIRE on the fresh key (count==1)
        # — doing it every hit would slide the TTL forward and let a chatty
        # caller hold the key open indefinitely. Don't decrement on overflow;
        # just let the counter run over so sustained abuse stays blocked.
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, self.window_seconds)
        if count > self.max_requests:
            logger.warn("rate_limit_exceeded", user_id=user.id, action=self.key_prefix, limit=self.max_requests)
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded: {self.max_requests} {self.key_prefix} per {self.window_seconds // 3600}h. Try again later.",
            )


class IPRateLimit:
    """IP-keyed rate limiter for unauthenticated endpoints like /auth/login.

    Uses `X-Forwarded-For` (first hop) when present — Ficino runs behind an
    nginx reverse proxy which sets that header. Falls back to
    `request.client.host` if no proxy header is set.

    Always active regardless of AUTH_PROVIDER, because its primary use is
    protecting the auth endpoints themselves from brute-force.
    """

    def __init__(self, key_prefix: str, max_requests: int, window_seconds: int):
        self.key_prefix = key_prefix
        self.max_requests = max_requests
        self.window_seconds = window_seconds

    async def __call__(self, request: Request) -> None:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            ip = forwarded.split(",")[0].strip()
        else:
            ip = request.client.host if request.client else "unknown"

        redis = await _get_redis()
        key = f"ratelimit:{self.key_prefix}:ip:{ip}"

        # See RateLimit.__call__ for why this is INCR-first with EXPIRE only
        # on the fresh key (atomic + no TTL-sliding).
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, self.window_seconds)
        if count > self.max_requests:
            logger.warn("ip_rate_limit_exceeded", ip=ip, action=self.key_prefix, limit=self.max_requests)
            raise HTTPException(
                status_code=429,
                detail=f"Too many {self.key_prefix} attempts. Try again later.",
            )
