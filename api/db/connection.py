"""PostgreSQL connection pool management using asyncpg."""

from typing import AsyncGenerator

import asyncpg
import structlog

from config import settings

logger = structlog.get_logger(__name__)

_pool: asyncpg.Pool | None = None


async def create_pool() -> asyncpg.Pool:
    """Create the global connection pool."""
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=5,
        max_size=20,
    )
    logger.info("db_pool_created", min_size=5, max_size=20)
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
