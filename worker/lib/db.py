"""Synchronous database helpers for Celery worker tasks.

Uses a persistent asyncpg connection pool (created on first use,
reused across all queries). Sync wrappers use a shared event loop
to avoid the overhead of asyncio.run() creating a new loop per call.
"""

import asyncio
import os
import threading

import asyncpg
import structlog

logger = structlog.get_logger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://ficino:ficino@postgres:5432/ficino")

# Persistent pool + event loop (thread-safe, lazy-initialized)
_pool: asyncpg.Pool | None = None
_loop: asyncio.AbstractEventLoop | None = None
_lock = threading.Lock()


def _get_loop() -> asyncio.AbstractEventLoop:
    """Get or create a persistent event loop for DB operations."""
    global _loop
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
    return _loop


async def _ensure_pool() -> asyncpg.Pool:
    """Create the connection pool if it doesn't exist."""
    global _pool
    if _pool is None or _pool._closed:
        _pool = await asyncpg.create_pool(
            dsn=DATABASE_URL,
            min_size=2,
            max_size=10,
        )
        logger.info("worker_db_pool_created", min_size=2, max_size=10)
    return _pool


def _run(coro):
    """Run an async coroutine on the persistent event loop."""
    with _lock:
        loop = _get_loop()
        return loop.run_until_complete(coro)


async def _execute(query: str, *args: object) -> str:
    pool = await _ensure_pool()
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)


async def _fetchrow(query: str, *args: object) -> asyncpg.Record | None:
    pool = await _ensure_pool()
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def _fetch(query: str, *args: object) -> list[asyncpg.Record]:
    pool = await _ensure_pool()
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


def execute(query: str, *args: object) -> str:
    """Execute a query (INSERT/UPDATE/DELETE). Sync wrapper."""
    return _run(_execute(query, *args))


def fetchrow(query: str, *args: object) -> asyncpg.Record | None:
    """Fetch a single row. Sync wrapper."""
    return _run(_fetchrow(query, *args))


def fetch(query: str, *args: object) -> list[asyncpg.Record]:
    """Fetch multiple rows. Sync wrapper."""
    return _run(_fetch(query, *args))


async def _store_chunks_batch(
    paper_id: str, chunks: list[dict[str, object]], embeddings: list[list[float]]
) -> int:
    """Store chunks with embeddings in a single transaction."""
    pool = await _ensure_pool()
    async with pool.acquire() as conn:
        stored = 0
        async with conn.transaction():
            for chunk, embedding in zip(chunks, embeddings):
                await conn.execute(
                    """INSERT INTO chunks (paper_id, section, content, chunk_type, chunk_index, token_count, embedding, metadata)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                    paper_id,
                    chunk["section"],
                    chunk["content"],
                    "text",
                    chunk["chunk_index"],
                    chunk.get("token_count"),
                    str(embedding),  # pgvector accepts string representation
                    "{}",
                )
                stored += 1
        return stored


def store_chunks_batch(
    paper_id: str, chunks: list[dict[str, object]], embeddings: list[list[float]]
) -> int:
    """Store chunks with embeddings. Sync wrapper."""
    return _run(_store_chunks_batch(paper_id, chunks, embeddings))


async def _store_figure(
    paper_id: str, page_number: int, image_path: str,
    extraction_type: str, description: str, claim_summary: str, figure_index: int
) -> None:
    pool = await _ensure_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO figures (paper_id, page_number, image_path, extraction_type,
                                   description, claim_summary, figure_index, processed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())""",
            paper_id, page_number, image_path, extraction_type,
            description, claim_summary, figure_index,
        )


def store_figure(
    paper_id: str, page_number: int, image_path: str,
    extraction_type: str, description: str, claim_summary: str, figure_index: int
) -> None:
    """Store a figure record. Sync wrapper."""
    _run(_store_figure(
        paper_id, page_number, image_path, extraction_type,
        description, claim_summary, figure_index,
    ))
