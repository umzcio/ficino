"""User settings endpoints."""

import json

import asyncpg
import httpx
import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from config import settings as app_settings
from auth import AuthUser, get_current_user
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/settings", tags=["settings"])

# Default settings object — all possible settings with defaults
DEFAULTS = {
    # LLM Provider
    "llm_provider": "ollama",
    "embed_provider": "ollama",
    "ollama_llm_model": "qwen3.5:latest",
    "ollama_embed_model": "bge-m3:latest",
    "vision_provider": "ollama",
    "ollama_vision_model": "gemma4:latest",
    "claude_model": "claude-sonnet-4-6",
    "anthropic_api_key": "",
    "openai_api_key": "",
    "voyage_api_key": "",

    # Personas
    "personas_enabled": {
        "skeptic": True,
        "hype": True,
        "practitioner": True,
        "methodologist": True,
        "gradstudent": True,
    },
    "persona_temperature": 0.8,

    # Feed
    "posts_per_generation": 12,
    "post_type_weights": {
        "post": 0.35,
        "thread": 0.10,
        "quote": 0.20,
        "reply": 0.25,
        "figure": 0.10,
    },
    "auto_generate_on_upload": False,

    # Paper Processing
    "extraction_mode": "auto",  # auto, pymupdf, vision
    "chunk_max_tokens": 800,
    "show_extraction_badge": True,

    # User profile
    "user_display_name": "You",
    "user_handle": "@you",
    "user_avatar_url": "",

    # Display
    "theme": "dark",
    "font_size": "normal",  # small, normal, large
    "post_spacing": "comfortable",  # compact, comfortable
}


class SettingsUpdate(BaseModel):
    settings: dict


@router.get("")
async def get_settings(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get current settings, merged with defaults."""
    row = await db.fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        user.id,
    )

    user_settings = {}
    if row:
        user_settings = row["settings"]
        if isinstance(user_settings, str):
            user_settings = json.loads(user_settings)

    # Merge: defaults ← user overrides
    merged = {**DEFAULTS}
    for key, value in user_settings.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value

    return merged


@router.put("")
async def update_settings(
    body: SettingsUpdate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Update settings. Partial updates supported — only send changed keys."""
    # Get existing
    row = await db.fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        user.id,
    )

    existing = {}
    if row:
        existing = row["settings"]
        if isinstance(existing, str):
            existing = json.loads(existing)

    # Merge updates
    for key, value in body.settings.items():
        if key in existing and isinstance(existing[key], dict) and isinstance(value, dict):
            existing[key] = {**existing[key], **value}
        else:
            existing[key] = value

    settings_json = json.dumps(existing)

    await db.execute(
        """INSERT INTO user_settings (user_id, settings, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE SET settings = $2, updated_at = NOW()""",
        user.id, settings_json,
    )

    logger.info("settings_updated", keys=list(body.settings.keys()))

    # Return merged with defaults
    merged = {**DEFAULTS}
    for key, value in existing.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


@router.get("/ollama-models")
async def list_ollama_models() -> dict[str, list[dict[str, str]]]:
    """List available Ollama models grouped by type."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{app_settings.ollama_base_url}/api/tags")
            resp.raise_for_status()
            models = resp.json().get("models", [])
    except Exception as e:
        logger.warn("ollama_models_fetch_failed", error=str(e))
        return {"llm": [], "embed": [], "vision": []}

    llm_models = []
    embed_models = []
    vision_models = []

    for m in models:
        name = m["name"]
        size_gb = round(m.get("size", 0) / 1e9, 1)
        info = {"name": name, "size": f"{size_gb}GB", "family": m.get("details", {}).get("family", "")}
        name_lower = name.lower()

        if "embed" in name_lower or "bge" in name_lower or "nomic" in name_lower:
            embed_models.append(info)
        else:
            llm_models.append(info)
            # Models with vision capabilities
            details = m.get("details", {})
            families = details.get("families", [])
            if any("vision" in f.lower() for f in families) or "vision" in name_lower:
                vision_models.append(info)

    return {"llm": llm_models, "embed": embed_models, "vision": vision_models}


@router.post("/clear-feeds", status_code=200)
async def clear_all_feeds(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Clear all generated feeds."""
    await db.execute("DELETE FROM feeds WHERE user_id = $1", user.id)
    return {"status": "cleared"}


@router.post("/clear-summaries", status_code=200)
async def clear_all_summaries(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Clear all paper summaries (forces regeneration)."""
    await db.execute(
        "DELETE FROM paper_summaries WHERE paper_id IN (SELECT id FROM papers WHERE user_id = $1)",
        user.id,
    )
    return {"status": "cleared"}
