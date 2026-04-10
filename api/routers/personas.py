"""Persona endpoints — single source of truth for persona metadata."""

import asyncpg
from fastapi import APIRouter, Depends

from db.connection import get_db

router = APIRouter(prefix="/personas", tags=["personas"])


@router.get("")
async def list_personas(
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """Return all active personas with metadata."""
    rows = await db.fetch(
        """SELECT key, handle, name, initials, color
           FROM personas WHERE is_active = true ORDER BY sort_order"""
    )
    return [dict(r) for r in rows]
