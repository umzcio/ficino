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


async def _enforce_rate_limit(key_prefix: str, max_requests: int, window_seconds: int, user_id: str) -> None:
    """Shared body for both the FastAPI dependency (`RateLimit`) and the
    imperative twin (`check_rate_limit`, R10 API-2) — one implementation,
    two call shapes, so they can't drift.
    """
    # Skip rate limiting for AUTH_PROVIDER=none (self-hosted single user)
    if settings.auth_provider == "none":
        return

    redis = await _get_redis()
    key = f"ratelimit:{key_prefix}:{user_id}"

    # Atomic INCR-first: the returned value is the post-increment count,
    # so a race between two requests can't both read "N-1" and decide
    # they're under the limit. Only set EXPIRE on the fresh key (count==1)
    # — doing it every hit would slide the TTL forward and let a chatty
    # caller hold the key open indefinitely. Don't decrement on overflow;
    # just let the counter run over so sustained abuse stays blocked.
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, window_seconds)
    if count > max_requests:
        logger.warning("rate_limit_exceeded", user_id=user_id, action=key_prefix, limit=max_requests)
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: {max_requests} {key_prefix} per {window_seconds // 3600}h. Try again later.",
        )


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
        await _enforce_rate_limit(self.key_prefix, self.max_requests, self.window_seconds, user.id)


async def check_rate_limit(user: AuthUser, key_prefix: str, max_requests: int, window_seconds: int = 86400) -> None:
    """Imperative twin of the RateLimit dependency — for handlers that must
    charge the limit only on specific branches (R10 API-2: charging cached
    reads throttled pure browsing).

    Unlike `RateLimit`, which fires as a FastAPI dependency before the
    handler body runs (so it can't distinguish a cheap cached-read branch
    from an expensive dispatch branch), this is called explicitly from
    inside the handler, right before the code path that actually needs
    the charge.
    """
    await _enforce_rate_limit(key_prefix, max_requests, window_seconds, user.id)


class IPRateLimit:
    """IP-keyed rate limiter for unauthenticated endpoints like /auth/login.

    Reads `X-Real-IP` set by nginx to `$remote_addr` (the real TCP peer).
    Do NOT trust the first hop of `X-Forwarded-For` — nginx uses
    `$proxy_add_x_forwarded_for` which preserves any client-supplied value
    and appends the real IP, so `split(",")[0]` is attacker-controlled and
    lets a caller rotate that header to bypass brute-force limits.

    Always active regardless of AUTH_PROVIDER, because its primary use is
    protecting the auth endpoints themselves from brute-force.
    """

    def __init__(self, key_prefix: str, max_requests: int, window_seconds: int):
        self.key_prefix = key_prefix
        self.max_requests = max_requests
        self.window_seconds = window_seconds

    async def __call__(self, request: Request) -> None:
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            ip = real_ip
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
            logger.warning("ip_rate_limit_exceeded", ip=ip, action=self.key_prefix, limit=self.max_requests)
            raise HTTPException(
                status_code=429,
                detail=f"Too many {self.key_prefix} attempts. Try again later.",
            )
