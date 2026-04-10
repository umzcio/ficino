"""Synchronous database helpers for Celery worker tasks.

Uses psycopg2-style connections via asyncpg in sync mode,
or falls back to a simple connection approach.
"""

import asyncio
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import asyncpg
import structlog

logger = structlog.get_logger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://ficino:ficino@postgres:5432/ficino")


async def _get_connection() -> asyncpg.Connection:
    return await asyncpg.connect(dsn=DATABASE_URL)


async def _execute(query: str, *args: object) -> str:
    conn = await _get_connection()
    try:
        return await conn.execute(query, *args)
    finally:
        await conn.close()


async def _fetchrow(query: str, *args: object) -> asyncpg.Record | None:
    conn = await _get_connection()
    try:
        return await conn.fetchrow(query, *args)
    finally:
        await conn.close()


async def _fetch(query: str, *args: object) -> list[asyncpg.Record]:
    conn = await _get_connection()
    try:
        return await conn.fetch(query, *args)
    finally:
        await conn.close()


def execute(query: str, *args: object) -> str:
    """Execute a query (INSERT/UPDATE/DELETE). Sync wrapper."""
    return asyncio.run(_execute(query, *args))


def fetchrow(query: str, *args: object) -> asyncpg.Record | None:
    """Fetch a single row. Sync wrapper."""
    return asyncio.run(_fetchrow(query, *args))


def fetch(query: str, *args: object) -> list[asyncpg.Record]:
    """Fetch multiple rows. Sync wrapper."""
    return asyncio.run(_fetch(query, *args))


async def _store_chunks_batch(
    paper_id: str, chunks: list[dict[str, object]], embeddings: list[list[float]]
) -> int:
    """Store chunks with embeddings in a single transaction."""
    conn = await _get_connection()
    try:
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
    finally:
        await conn.close()


def store_chunks_batch(
    paper_id: str, chunks: list[dict[str, object]], embeddings: list[list[float]]
) -> int:
    """Store chunks with embeddings. Sync wrapper."""
    return asyncio.run(_store_chunks_batch(paper_id, chunks, embeddings))


async def _store_figure(
    paper_id: str, page_number: int, image_path: str,
    extraction_type: str, description: str, claim_summary: str, figure_index: int
) -> None:
    conn = await _get_connection()
    try:
        await conn.execute(
            """INSERT INTO figures (paper_id, page_number, image_path, extraction_type,
                                   description, claim_summary, figure_index, processed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())""",
            paper_id, page_number, image_path, extraction_type,
            description, claim_summary, figure_index,
        )
    finally:
        await conn.close()


def store_figure(
    paper_id: str, page_number: int, image_path: str,
    extraction_type: str, description: str, claim_summary: str, figure_index: int
) -> None:
    """Store a figure record. Sync wrapper."""
    asyncio.run(_store_figure(
        paper_id, page_number, image_path, extraction_type,
        description, claim_summary, figure_index,
    ))
