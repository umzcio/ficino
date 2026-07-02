"""Load user settings from DB for use in worker tasks.

Defaults, env map, and merge/reassert logic live in ficino_shared.settings_schema
(R10 DUP-1) so the api and worker can never drift on provider defaults or
secret/override key sets. This module keeps the worker-specific, DB-touching
and process-local pieces: fetching a user's row, publishing the active
config into _active_settings, and get_active's env-fallback read.
"""

import os
import json
import threading

import structlog

from ficino_shared.constants import STUB_USER_ID  # noqa: F401  (re-export)
from ficino_shared.settings_schema import (
    DEFAULTS,  # noqa: F401  (re-export for callers)
    SETTINGS_TO_ENV,
    baseline_env,
    is_public_deployment,
    merge_settings,
    reassert_public_deployment,
    snapshot_baseline_env,
)

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


def ollama_base_url() -> str:
    """Single reader for OLLAMA_BASE_URL (R10 DUP-5, narrow consolidation).

    env-only, NOT user-overridable (SSRF defense) — every provider reader
    (claude_client, embedder, contextualizer, figure_detector,
    vision_extractor) previously hardcoded this same os.getenv line. The
    surrounding `_get_config` functions stay separate per module (they read
    different key sets); only this one line is deduplicated.
    """
    return os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")


def _fetch_user_row(user_id: str | None = None) -> dict:
    """Fetch and JSON-decode the raw settings row for a user (or {})."""
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
    return user


def get_user_settings(user_id: str | None = None) -> dict:
    """Fetch and merge user settings with defaults."""
    user = _fetch_user_row(user_id)
    merged = merge_settings(user)
    if is_public_deployment():
        merged = reassert_public_deployment(merged)
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
    # Fetch raw user settings once — used both to derive the merged
    # settings and to distinguish "user didn't set" from "DEFAULTS have
    # it" in the env-write loop below (R10 DUP-1: closes the wave-1
    # carried duplicate-fetch finding).
    user_explicit = _fetch_user_row(user_id)
    settings = merge_settings(user_explicit)

    # Under PUBLIC_DEPLOYMENT the operator's env is authoritative:
    # `settings` was already reasserted from the operator baseline above
    # (reassert_public_deployment), so the env writes must follow the
    # MERGED values or os.environ would diverge from _active_settings
    # (stale user value leaking to legacy env readers).
    public_deployment = is_public_deployment()
    if public_deployment:
        settings = reassert_public_deployment(settings)

    with _env_lock:
        snapshot_baseline_env()
        _active_settings.clear()
        _active_settings.update(settings)
        for setting_key, env_var in SETTINGS_TO_ENV.items():
            # Check user's explicitly-set value, not merged (which includes
            # DEFAULTS) — except under PUBLIC_DEPLOYMENT, where the operator
            # baseline is authoritative and must win in os.environ too.
            # Drive off _baseline_env, not merged: merged's DEFAULTS captured
            # os.environ at import, so it can re-launder a value written by a
            # previous apply (R10 WORK-3 final-review fix). In production
            # baseline == the reasserted merged values, so this is equivalent.
            if public_deployment:
                value = baseline_env().get(env_var) or user_explicit.get(setting_key)
            else:
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
                baseline = baseline_env().get(env_var)
                if baseline is None:
                    os.environ.pop(env_var, None)
                else:
                    os.environ[env_var] = baseline

    return settings
