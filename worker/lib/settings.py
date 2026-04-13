"""Load user settings from DB for use in worker tasks."""

import json
import os

import structlog

from lib.db import fetchrow

logger = structlog.get_logger(__name__)

STUB_USER_ID = "00000000-0000-0000-0000-000000000000"

DEFAULTS = {
    "llm_provider": "ollama",
    "embed_provider": "ollama",
    "claude_model": "claude-sonnet-4-6",
    "ollama_llm_model": "qwen3.5:latest",
    "ollama_embed_model": "bge-m3:latest",
    "vision_provider": "ollama",
    "ollama_vision_model": "gemma4:latest",
    "personas_enabled": {
        "skeptic": True,
        "hype": True,
        "practitioner": True,
        "methodologist": True,
        "gradstudent": True,
    },
    "persona_temperature": 0.8,
    "posts_per_generation": 12,
    "post_type_weights": {
        "post": 0.35,
        "thread": 0.10,
        "quote": 0.20,
        "reply": 0.25,
        "figure": 0.10,
    },
    "auto_generate_on_upload": False,
    "extraction_mode": "auto",
    "chunk_max_tokens": 800,
    "user_display_name": "You",
    "user_handle": "@you",
    "user_avatar_url": "",
}

# Settings keys that map directly to env vars
_SETTINGS_TO_ENV = {
    "llm_provider": "LLM_PROVIDER",
    "embed_provider": "EMBED_PROVIDER",
    "ollama_llm_model": "OLLAMA_LLM_MODEL",
    "ollama_embed_model": "OLLAMA_EMBED_MODEL",
    "ollama_vision_model": "OLLAMA_VISION_MODEL",
    "vision_provider": "VISION_PROVIDER",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "voyage_api_key": "VOYAGE_API_KEY",
    "claude_model": "CLAUDE_MODEL",
    "voyage_embed_model": "VOYAGE_EMBED_MODEL",
}


def get_user_settings(user_id: str | None = None) -> dict:
    """Fetch and merge user settings with defaults."""
    uid = user_id or STUB_USER_ID
    row = fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        uid,
    )
    user = {}
    if row:
        user = row["settings"]
        if isinstance(user, str):
            user = json.loads(user)

    merged = {**DEFAULTS}
    for key, value in user.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def apply_provider_settings(user_id: str | None = None) -> dict:
    """Load user settings and apply provider config to env vars.

    Call this at the start of any worker task that uses LLM or embeddings.
    Returns the merged settings dict.
    """
    settings = get_user_settings(user_id)

    for setting_key, env_var in _SETTINGS_TO_ENV.items():
        value = settings.get(setting_key)
        if value:
            os.environ[env_var] = str(value)
            logger.debug("setting_applied", key=setting_key, env=env_var)

    return settings
