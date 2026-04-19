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

# Persistent pool + event loop (thread-safe, lazy-initialized).
# Round-4: loop runs on a dedicated daemon thread; sync wrappers submit
# via run_coroutine_threadsafe so multiple Celery threads don't queue up
# behind a single run_until_complete call. The small lock only guards
# first-time loop creation.
_pool: asyncpg.Pool | None = None
_loop: asyncio.AbstractEventLoop | None = None
_lock = threading.Lock()


def _ensure_loop() -> asyncio.AbstractEventLoop:
    """Get or create a persistent event loop running on a background thread."""
    global _loop
    if _loop is not None and not _loop.is_closed():
        return _loop
    with _lock:
        if _loop is None or _loop.is_closed():
            loop = asyncio.new_event_loop()

            def _runner() -> None:
                asyncio.set_event_loop(loop)
                loop.run_forever()

            t = threading.Thread(target=_runner, name="db-loop", daemon=True)
            t.start()
            _loop = loop
        return _loop


async def _ensure_pool() -> asyncpg.Pool:
    """Create the connection pool if it doesn't exist.

    Only checks for None — don't peek at `_pool._closed` (private API that can
    disappear between asyncpg releases). If the pool was closed out from
    under us, the first acquire will raise and the wrappers below will
    rebuild the pool on demand.
    """
    global _pool
    if _pool is None:
        min_size = int(os.getenv("DB_POOL_MIN_SIZE", "2"))
        max_size = int(os.getenv("DB_POOL_MAX_SIZE", "10"))
        _pool = await asyncpg.create_pool(
            dsn=DATABASE_URL,
            min_size=min_size,
            max_size=max_size,
        )
        logger.info("worker_db_pool_created", min_size=min_size, max_size=max_size)
    return _pool


async def _reset_pool() -> None:
    """Drop the cached pool reference so the next _ensure_pool rebuilds it."""
    global _pool
    _pool = None


def _is_pool_closed_error(exc: BaseException) -> bool:
    """True if the error indicates the underlying pool has been closed.

    asyncpg signals this via InterfaceError (different messages across
    versions) or sometimes RuntimeError("pool is closed").
    """
    if isinstance(exc, asyncpg.InterfaceError):
        return True
    if isinstance(exc, RuntimeError) and "pool is closed" in str(exc).lower():
        return True
    return False


def _run(coro):
    """Submit a coroutine to the persistent loop and block for the result."""
    loop = _ensure_loop()
    return asyncio.run_coroutine_threadsafe(coro, loop).result()


async def _execute(query: str, *args: object) -> str:
    try:
        pool = await _ensure_pool()
        async with pool.acquire() as conn:
            return await conn.execute(query, *args)
    except BaseException as exc:
        if not _is_pool_closed_error(exc):
            raise
        logger.warn("worker_db_pool_closed_rebuilding", op="execute", error=str(exc))
        await _reset_pool()
        pool = await _ensure_pool()
        async with pool.acquire() as conn:
            return await conn.execute(query, *args)


async def _fetchrow(query: str, *args: object) -> asyncpg.Record | None:
    try:
        pool = await _ensure_pool()
        async with pool.acquire() as conn:
            return await conn.fetchrow(query, *args)
    except BaseException as exc:
        if not _is_pool_closed_error(exc):
            raise
        logger.warn("worker_db_pool_closed_rebuilding", op="fetchrow", error=str(exc))
        await _reset_pool()
        pool = await _ensure_pool()
        async with pool.acquire() as conn:
            return await conn.fetchrow(query, *args)


async def _fetch(query: str, *args: object) -> list[asyncpg.Record]:
    try:
        pool = await _ensure_pool()
        async with pool.acquire() as conn:
            return await conn.fetch(query, *args)
    except BaseException as exc:
        if not _is_pool_closed_error(exc):
            raise
        logger.warn("worker_db_pool_closed_rebuilding", op="fetch", error=str(exc))
        await _reset_pool()
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
    paper_id: str,
    chunks: list[dict[str, object]],
    embeddings: list[list[float]],
    user_id: str,
) -> int:
    """Store chunks with embeddings in a single transaction.

    Uses executemany to reduce round-trip overhead — a 500-chunk paper used to
    do 500 separate INSERT round-trips inside the transaction, which is the
    dominant cost during ingestion. executemany ships them as one batched
    command. A full COPY would be faster still but requires manual formatting
    of the pgvector literal and the jsonb — executemany is a near drop-in.

    user_id is denormalized onto chunks so full-text search can filter by
    owner before hitting the GIN index (see
    infra/postgres/add_user_id_to_chunks_feed_posts.sql).
    """
    if not chunks:
        return 0
    pool = await _ensure_pool()
    rows = [
        (
            paper_id,
            user_id,
            chunk["section"],
            chunk["content"],
            "text",
            chunk["chunk_index"],
            chunk.get("token_count"),
            str(embedding),  # pgvector accepts string representation
            "{}",
            chunk.get("contextual_prefix") or None,
        )
        for chunk, embedding in zip(chunks, embeddings)
    ]
    # Retry-safety: if the pipeline is re-run (Celery retry after a post-chunk
    # failure), existing chunks for this paper are flushed first so we don't
    # end up with rows from a prior chunker config sitting alongside the
    # current run's indices. The ON CONFLICT on (paper_id, chunk_index) then
    # makes the insert itself idempotent.
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM chunks WHERE paper_id = $1",
                paper_id,
            )
            await conn.executemany(
                """INSERT INTO chunks (paper_id, user_id, section, content, chunk_type, chunk_index, token_count, embedding, metadata, contextual_prefix)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                   ON CONFLICT (paper_id, chunk_index) DO UPDATE SET
                     user_id = EXCLUDED.user_id,
                     section = EXCLUDED.section,
                     content = EXCLUDED.content,
                     chunk_type = EXCLUDED.chunk_type,
                     token_count = EXCLUDED.token_count,
                     embedding = EXCLUDED.embedding,
                     metadata = EXCLUDED.metadata,
                     contextual_prefix = EXCLUDED.contextual_prefix""",
                rows,
            )
        return len(rows)


def store_chunks_batch(
    paper_id: str,
    chunks: list[dict[str, object]],
    embeddings: list[list[float]],
    user_id: str,
) -> int:
    """Store chunks with embeddings. Sync wrapper."""
    return _run(_store_chunks_batch(paper_id, chunks, embeddings, user_id))


async def _store_figure(
    paper_id: str, page_number: int, image_path: str,
    extraction_type: str, description: str, claim_summary: str, figure_index: int,
    *,
    figure_type: str | None = None,
    caption: str | None = None,
    figure_number: str | None = None,
    data_claim: str | None = None,
    referenced_paragraph: str | None = None,
    bbox: dict | None = None,
    detector_confidence: float | None = None,
) -> None:
    # ON CONFLICT makes this idempotent under `process_paper` retries —
    # without it, a failure *after* figure storage but before
    # `_update_paper_status("complete")` re-runs extraction and leaves
    # duplicate rows, plus wastes vision-LLM spend.
    import json as _json
    bbox_json = _json.dumps(bbox) if bbox is not None else None
    pool = await _ensure_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO figures (
                 paper_id, page_number, image_path, extraction_type,
                 description, claim_summary, figure_index, processed_at,
                 figure_type, caption, figure_number, data_claim,
                 referenced_paragraph, bbox, detector_confidence
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(),
                       $8, $9, $10, $11, $12, $13::jsonb, $14)
               ON CONFLICT (paper_id, figure_index) DO UPDATE
                 SET page_number          = EXCLUDED.page_number,
                     image_path           = EXCLUDED.image_path,
                     extraction_type      = EXCLUDED.extraction_type,
                     description          = EXCLUDED.description,
                     claim_summary        = EXCLUDED.claim_summary,
                     processed_at         = EXCLUDED.processed_at,
                     figure_type          = EXCLUDED.figure_type,
                     caption              = EXCLUDED.caption,
                     figure_number        = EXCLUDED.figure_number,
                     data_claim           = EXCLUDED.data_claim,
                     referenced_paragraph = EXCLUDED.referenced_paragraph,
                     bbox                 = EXCLUDED.bbox,
                     detector_confidence  = EXCLUDED.detector_confidence""",
            paper_id, page_number, image_path, extraction_type,
            description, claim_summary, figure_index,
            figure_type, caption, figure_number, data_claim,
            referenced_paragraph, bbox_json, detector_confidence,
        )


def store_figure(
    paper_id: str, page_number: int, image_path: str,
    extraction_type: str, description: str, claim_summary: str, figure_index: int,
    *,
    figure_type: str | None = None,
    caption: str | None = None,
    figure_number: str | None = None,
    data_claim: str | None = None,
    referenced_paragraph: str | None = None,
    bbox: dict | None = None,
    detector_confidence: float | None = None,
) -> None:
    """Store a figure record with typed metadata. Sync wrapper."""
    _run(_store_figure(
        paper_id, page_number, image_path, extraction_type,
        description, claim_summary, figure_index,
        figure_type=figure_type,
        caption=caption,
        figure_number=figure_number,
        data_claim=data_claim,
        referenced_paragraph=referenced_paragraph,
        bbox=bbox,
        detector_confidence=detector_confidence,
    ))
