"""Single source of truth for user settings: defaults, env map, key sets,
merge, baseline, and reassert.

This IS the single source (R10 DUP-1 complete). Both the api and the
worker import from here so provider defaults (same env var, same
fallback) and secret/override key sets can never drift between the two
services again.
"""

import os
import threading

# Default settings object — all possible settings with defaults.
#
# Provider defaults come from env, not from a hard-coded string. Docker-compose
# self-host sets LLM_PROVIDER=ollama in .env; Railway / SaaS sets it to "api".
# No deploy target biases the other — if the env is unset we fall back to
# "ollama" purely because it's the zero-config local-only option a fresh
# self-host clone is expected to run on.
DEFAULTS = {
    # LLM / embedding / vision providers
    "llm_provider": os.getenv("LLM_PROVIDER", "ollama"),
    "embed_provider": os.getenv("EMBED_PROVIDER", "ollama"),
    "vision_provider": os.getenv("VISION_PROVIDER", "ollama"),
    "claude_model": os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"),
    "ollama_llm_model": os.getenv("OLLAMA_LLM_MODEL", "qwen3.5:latest"),
    "ollama_embed_model": os.getenv("OLLAMA_EMBED_MODEL", "bge-m3:latest"),
    "ollama_vision_model": os.getenv("OLLAMA_VISION_MODEL", "gemma4:latest"),
    "voyage_embed_model": os.getenv("VOYAGE_EMBED_MODEL", "voyage-4-large"),
    "anthropic_api_key": os.getenv("ANTHROPIC_API_KEY", ""),
    "openai_api_key": os.getenv("OPENAI_API_KEY", ""),
    "voyage_api_key": os.getenv("VOYAGE_API_KEY", ""),
    "cohere_api_key": os.getenv("COHERE_API_KEY", ""),
    # Cross-encoder rerank of retrieval candidates. "none" = off.
    "rerank_provider": os.getenv("RERANK_PROVIDER", "none"),
    "rerank_local_model": os.getenv("RERANK_LOCAL_MODEL", "BAAI/bge-reranker-v2-m3"),
    "rerank_voyage_model": os.getenv("RERANK_VOYAGE_MODEL", "rerank-2-lite"),
    "rerank_cohere_model": os.getenv("RERANK_COHERE_MODEL", "rerank-v3.5"),
    # Per-chunk contextual prefix generation at ingest time. "none" = off.
    "context_provider": os.getenv("CONTEXT_PROVIDER", "none"),
    "context_anthropic_model": os.getenv("CONTEXT_ANTHROPIC_MODEL", "claude-haiku-4-5"),
    "context_ollama_model": os.getenv("CONTEXT_OLLAMA_MODEL", "qwen3.5:latest"),
    # Figure-detection vision provider (R10 wave 2 — moved into the shared
    # schema alongside the other provider knobs it mirrors).
    "figure_detect_provider": os.getenv("FIGURE_DETECT_PROVIDER", "anthropic"),
    "figure_detect_ollama_model": os.getenv("FIGURE_DETECT_OLLAMA_MODEL", "qwen2.5vl:latest"),
    "figure_detect_anthropic_model": os.getenv("FIGURE_DETECT_ANTHROPIC_MODEL", "claude-sonnet-4-6"),
    # OpenAI embedding model, used when embed_provider == "openai".
    "openai_embed_model": os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small"),

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

    # User profile
    "user_display_name": "You",
    "user_handle": "@you",
    "user_avatar_url": "",

    # UI-only (api-only; the worker does not read these)
    "show_extraction_badge": True,
    "theme": "dark",
    "font_size": "normal",  # small, normal, large
    "post_spacing": "comfortable",  # compact, comfortable
}

# Keys that exist only for the frontend's benefit — documented here so
# both services can see, at a glance, which keys the worker ignores even
# though both services share one DEFAULTS dict.
UI_ONLY_KEYS = frozenset({"show_extraction_badge", "theme", "font_size", "post_spacing"})

# Settings keys that map directly to env vars
SETTINGS_TO_ENV = {
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
    "figure_detect_provider": "FIGURE_DETECT_PROVIDER",
    "figure_detect_ollama_model": "FIGURE_DETECT_OLLAMA_MODEL",
    "figure_detect_anthropic_model": "FIGURE_DETECT_ANTHROPIC_MODEL",
    "openai_embed_model": "OPENAI_EMBED_MODEL",
}

# Numeric bounds for keys that feed into cost-sensitive paths. Without these
# a client could PUT `posts_per_generation: 10000` or `chunk_max_tokens: 1_000_000`
# and fan out enormous LLM spend on a single dispatch. Keys not listed here
# are still bounded by their default type (e.g. strings pass through the
# ALLOWED set) — this dict only applies to numeric knobs that drive loops
# or token budgets.
NUMERIC_BOUNDS: dict[str, tuple[type, float, float]] = {
    "posts_per_generation": (int, 1, 50),
    "persona_temperature": (float, 0.0, 1.5),
    "chunk_max_tokens": (int, 100, 4000),
}

# Keys whose values are secrets. GET /settings returns them as a boolean-ish
# "set" / "" string so an XSS or browser-extension snoop can't exfiltrate
# the actual key from a response body.
SECRET_KEYS = frozenset({"anthropic_api_key", "openai_api_key", "voyage_api_key", "cohere_api_key"})

# Keys that override the admin-configured LLM / embedding / vision stack.
# Under PUBLIC_DEPLOYMENT=true these are rejected on write so hosted users
# can't point the app at their own keys or swap models — the operator's
# env config is the only source of truth. On self-host (default) these
# remain user-configurable.
PROVIDER_OVERRIDE_KEYS = frozenset({
    "llm_provider",
    "embed_provider",
    "vision_provider",
    "ollama_llm_model",
    "ollama_embed_model",
    "ollama_vision_model",
    "claude_model",
    "anthropic_api_key",
    "openai_api_key",
    "voyage_api_key",
    "cohere_api_key",
    "voyage_embed_model",
    "rerank_provider",
    "rerank_local_model",
    "rerank_voyage_model",
    "rerank_cohere_model",
    "context_provider",
    "context_anthropic_model",
    "context_ollama_model",
    "figure_detect_provider",
    "figure_detect_ollama_model",
    "figure_detect_anthropic_model",
    "openai_embed_model",
})

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
    for env_var in SETTINGS_TO_ENV.values():
        _baseline_env[env_var] = os.getenv(env_var)


def snapshot_baseline_env() -> None:
    """Public wrapper around the baseline snapshot (idempotent, no-op if
    already captured)."""
    _snapshot_baseline_env()


def baseline_env() -> dict[str, str | None]:
    """Return the operator-baseline env snapshot."""
    return _baseline_env


def reset_baseline_for_tests() -> None:
    """Clear the baseline snapshot and immediately re-capture it from the
    CURRENT os.environ.

    Test-only: this simulates a fresh process's pristine-env snapshot at
    the moment the test calls it. It must snapshot immediately rather than
    merely clearing and deferring to the next lazy `_snapshot_baseline_env()`
    call, because that next call (inside `reassert_public_deployment`) may
    run after the test has already poisoned os.environ — which would
    capture the poison as if it were the operator baseline and defeat the
    point of the test. Production code must never call this mid-process.
    """
    _baseline_env.clear()
    _snapshot_baseline_env()


def is_public_deployment() -> bool:
    return os.getenv("PUBLIC_DEPLOYMENT", "").lower() in ("1", "true", "yes")


def merge_settings(user: dict) -> dict:
    """Merge a user's settings dict over DEFAULTS, dict-aware."""
    merged = {**DEFAULTS}
    for key, value in user.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def reassert_public_deployment(merged: dict) -> dict:
    """Under PUBLIC_DEPLOYMENT, reassert the operator baseline over merged.

    Hosted deploy: the operator's env is authoritative for provider
    selection and API keys. DEFAULTS already read from env so a fresh
    user (no settings row) gets env values. But an EXISTING user row
    may carry stale "ollama" values from a prior self-host install
    that got migrated to SaaS — reassert env over those so they can't
    accidentally point the worker at an Ollama instance that isn't
    reachable from the hosted runtime.

    Read from baseline_env(), NOT live os.getenv: apply_provider_settings
    writes per-user values into os.environ, so a live read would launder
    a previous user's key into this user's merged config as if the
    OPERATOR had configured it (R10 WORK-3 final-review fix).
    """
    if is_public_deployment():
        _snapshot_baseline_env()
        for k, env_key in SETTINGS_TO_ENV.items():
            env_val = _baseline_env.get(env_key)
            if env_val:
                merged[k] = env_val
    return merged


def default_for(setting_key: str) -> str:
    return str(DEFAULTS.get(setting_key, ""))


# Capture the operator baseline at import time, while os.environ is still
# pristine in each prefork child — before any apply_provider_settings call
# has written per-user values into it. The lazy call inside
# apply_provider_settings remains as a re-snapshot hook (tests clear
# _baseline_env to simulate a fresh process).
snapshot_baseline_env()
