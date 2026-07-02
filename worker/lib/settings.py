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

# Operator-baseline env snapshot, captured once at first apply.
# apply_provider_settings mutates os.environ per-user; without restoring
# between users, user A's key leaks into user B's task via get_active's
# env fallback (R10 WORK-3). None = the operator never set that var.
_baseline_env: dict[str, str | None] = {}


def _snapshot_baseline_env() -> None:
    if _baseline_env:
        return
    for env_var in _SETTINGS_TO_ENV.values():
        _baseline_env[env_var] = os.getenv(env_var)


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

# Provider defaults come from env, not from a hard-coded string. Docker-compose
# self-host sets LLM_PROVIDER=ollama in .env; Railway / SaaS sets it to "api".
# No deploy target biases the other — if the env is unset we fall back to
# "ollama" purely because it's the zero-config local-only option a fresh
# self-host clone is expected to run on.
DEFAULTS = {
    "llm_provider":   os.getenv("LLM_PROVIDER", "ollama"),
    "embed_provider": os.getenv("EMBED_PROVIDER", "ollama"),
    "vision_provider": os.getenv("VISION_PROVIDER", "ollama"),
    "claude_model":   os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"),
    "ollama_llm_model":    os.getenv("OLLAMA_LLM_MODEL", "qwen3.5:latest"),
    "ollama_embed_model":  os.getenv("OLLAMA_EMBED_MODEL", "bge-m3:latest"),
    "ollama_vision_model": os.getenv("OLLAMA_VISION_MODEL", "gemma4:latest"),
    "voyage_embed_model":  os.getenv("VOYAGE_EMBED_MODEL", "voyage-4-large"),
    "anthropic_api_key": os.getenv("ANTHROPIC_API_KEY", ""),
    "openai_api_key":    os.getenv("OPENAI_API_KEY", ""),
    "voyage_api_key":    os.getenv("VOYAGE_API_KEY", ""),
    "cohere_api_key":    os.getenv("COHERE_API_KEY", ""),
    # Cross-encoder rerank of retrieval candidates. "none" = off.
    "rerank_provider":    os.getenv("RERANK_PROVIDER", "none"),
    "rerank_local_model":  os.getenv("RERANK_LOCAL_MODEL", "BAAI/bge-reranker-v2-m3"),
    "rerank_voyage_model": os.getenv("RERANK_VOYAGE_MODEL", "rerank-2-lite"),
    "rerank_cohere_model": os.getenv("RERANK_COHERE_MODEL", "rerank-v3.5"),
    # Per-chunk contextual prefix generation at ingest time. "none" = off.
    "context_provider":        os.getenv("CONTEXT_PROVIDER", "none"),
    "context_anthropic_model": os.getenv("CONTEXT_ANTHROPIC_MODEL", "claude-haiku-4-5"),
    "context_ollama_model":    os.getenv("CONTEXT_OLLAMA_MODEL", "qwen3.5:latest"),
    # Non-provider settings — safe to default as data, not env.
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
    "cohere_api_key": "COHERE_API_KEY",
    "claude_model": "CLAUDE_MODEL",
    "voyage_embed_model": "VOYAGE_EMBED_MODEL",
    "rerank_provider": "RERANK_PROVIDER",
    "rerank_local_model": "RERANK_LOCAL_MODEL",
    "rerank_voyage_model": "RERANK_VOYAGE_MODEL",
    "rerank_cohere_model": "RERANK_COHERE_MODEL",
    "context_provider": "CONTEXT_PROVIDER",
    "context_anthropic_model": "CONTEXT_ANTHROPIC_MODEL",
    "context_ollama_model": "CONTEXT_OLLAMA_MODEL",
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

    # Hosted deploy: the operator's env is authoritative for provider
    # selection and API keys. DEFAULTS already read from env so a fresh
    # user (no settings row) gets env values. But an EXISTING user row
    # may carry stale "ollama" values from a prior self-host install
    # that got migrated to SaaS — reassert env over those so they can't
    # accidentally point the worker at an Ollama instance that isn't
    # reachable from the hosted runtime.
    if os.getenv("PUBLIC_DEPLOYMENT", "").lower() in ("1", "true", "yes"):
        for k, env_key in _SETTINGS_TO_ENV.items():
            env_val = os.getenv(env_key)
            if env_val:
                merged[k] = env_val
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

    # Fetch raw user settings to distinguish "user didn't set" from "DEFAULTS have it"
    uid = user_id or STUB_USER_ID
    row = fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        uid,
    )
    user_explicit = {}
    if row:
        user_explicit = row["settings"]
        if isinstance(user_explicit, str):
            user_explicit = json.loads(user_explicit)

    with _env_lock:
        _snapshot_baseline_env()
        _active_settings.clear()
        _active_settings.update(settings)
        for setting_key, env_var in _SETTINGS_TO_ENV.items():
            # Check user's explicitly-set value, not merged (which includes DEFAULTS)
            value = user_explicit.get(setting_key)
            if value:
                os.environ[env_var] = str(value)
                logger.debug("setting_applied", key=setting_key, env=env_var)
            else:
                # Restore the operator baseline instead of leaving the
                # previous user's value behind (R10 WORK-3). A paid
                # provider selected with no key now fails loudly.
                # Also remove from _active_settings if user didn't explicitly set it,
                # so get_active falls back to env (which has been restored).
                _active_settings.pop(setting_key, None)
                baseline = _baseline_env.get(env_var)
                if baseline is None:
                    os.environ.pop(env_var, None)
                else:
                    os.environ[env_var] = baseline

    return settings
