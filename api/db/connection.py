"""PostgreSQL connection pool management using asyncpg."""

import os
from typing import AsyncGenerator

import asyncpg
import structlog

from config import settings

logger = structlog.get_logger(__name__)

_pool: asyncpg.Pool | None = None


async def create_pool() -> asyncpg.Pool:
    """Create the global connection pool.

    Pool sizes are env-configurable so a hosted deploy behind a connection
    pooler (e.g. Supabase's session pooler caps total clients at 15) can
    shrink without penalizing self-host where asyncpg talks to a local
    Postgres directly.
    """
    global _pool
    min_size = int(os.getenv("DB_POOL_MIN_SIZE", "5"))
    max_size = int(os.getenv("DB_POOL_MAX_SIZE", "20"))
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=min_size,
        max_size=max_size,
    )
    logger.info("db_pool_created", min_size=min_size, max_size=max_size)
    return _pool


async def close_pool() -> None:
    """Close the global connection pool."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("db_pool_closed")


async def get_db() -> AsyncGenerator[asyncpg.Connection, None]:
    """FastAPI dependency that yields a connection from the pool."""
    if _pool is None:
        raise RuntimeError("Database pool not initialized")
    async with _pool.acquire() as conn:
        yield conn
