"""Load user settings from DB for use in worker tasks."""

import json
import os
import threading

import structlog

from lib.db import fetchrow

logger = structlog.get_logger(__name__)

# apply_provider_settings publishes the active user's resolved config into
# _active_settings (module-scoped, process-local). The LLM/embed/vision
# clients read from this dict first, falling back to os.environ if a key
# is missing. Under the default Celery prefork pool, tasks run sequentially
# within a worker process, so "last-applied is current" holds — no race.
# Previously we mutated os.environ, which is still done (as a fallback for
# any legacy reader) but is no longer the primary source of truth.
_env_lock = threading.Lock()
_active_settings: dict[str, object] = {}


def get_active(setting_key: str, env_key: str, default: str = "") -> str:
    """Read a provider setting, preferring the per-task apply over env.

    `setting_key` is the user-settings key (e.g. "llm_provider").
    `env_key` is the env var name (e.g. "LLM_PROVIDER") used for fallback
    so callers that haven't called apply_provider_settings still work.
    """
    value = _active_settings.get(setting_key)
    if value:
        return str(value)
    return os.getenv(env_key, default)

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
    """Load user settings and publish them as the active provider config.

    Call this at the start of any worker task that uses LLM or embeddings.
    Returns the merged settings dict.

    Writes are made under a lock to _active_settings (module-local dict)
    AND to os.environ. Clients read via `get_active()` which prefers the
    dict — so cross-process env-var bleed between different Celery worker
    processes can't charge user A's LLM call to user B's key. The os.environ
    writes remain for any legacy reader that hasn't migrated to get_active.
    """
    settings = get_user_settings(user_id)

    with _env_lock:
        _active_settings.clear()
        _active_settings.update(settings)
        for setting_key, env_var in _SETTINGS_TO_ENV.items():
            value = settings.get(setting_key)
            if value:
                os.environ[env_var] = str(value)
                logger.debug("setting_applied", key=setting_key, env=env_var)

    return settings
