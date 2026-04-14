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
from fastapi import Depends, HTTPException

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

        current = await redis.get(key)
        if current is not None and int(current) >= self.max_requests:
            logger.warn("rate_limit_exceeded", user_id=user.id, action=self.key_prefix, limit=self.max_requests)
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded: {self.max_requests} {self.key_prefix} per {self.window_seconds // 3600}h. Try again later.",
            )

        pipe = redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, self.window_seconds)
        await pipe.execute()
