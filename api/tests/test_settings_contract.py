"""R10 DUP-1 (short-term): api DEFAULTS were hardcoded while the worker's
are env-derived, and worker-only keys (rerank_*, context_*, cohere_api_key,
voyage_embed_model) were silently dropped by the allow-list.

Characterization tests pin the behavior that must survive; the new-key
tests fail until DEFAULTS is rewritten."""
from __future__ import annotations

import pytest


# ---- characterization: current behavior that must survive the rewrite ----

@pytest.mark.asyncio
async def test_get_settings_returns_defaults_and_ui_keys(client_as_user_a, seeded_users):
    resp = await client_as_user_a.get("/settings")
    assert resp.status_code == 200
    body = resp.json()
    for key in ("llm_provider", "personas_enabled", "posts_per_generation",
                "theme", "font_size", "post_spacing", "show_extraction_badge"):
        assert key in body, f"{key} missing from GET /settings"


@pytest.mark.asyncio
async def test_put_drops_non_allowlisted_keys(client_as_user_a, seeded_users):
    # Include a valid key so the update isn't empty after filtering —
    # we're testing the drop, not the empty-update path.
    resp = await client_as_user_a.put(
        "/settings",
        json={"settings": {"ollama_base_url": "http://evil.example", "theme": "dark"}},
    )
    assert resp.status_code == 200
    assert "ollama_base_url" not in resp.json(), "SSRF allow-list must hold"


@pytest.mark.asyncio
async def test_secrets_are_redacted(client_as_user_a, seeded_users):
    resp = await client_as_user_a.put(
        "/settings", json={"settings": {"anthropic_api_key": "sk-test-123"}}
    )
    assert resp.json()["anthropic_api_key"] == "set"
    resp = await client_as_user_a.get("/settings")
    assert resp.json()["anthropic_api_key"] == "set"


# ---- new behavior: worker-known keys become settable + visible ----

@pytest.mark.asyncio
async def test_worker_keys_present_in_defaults(client_as_user_a, seeded_users):
    resp = await client_as_user_a.get("/settings")
    body = resp.json()
    for key in ("rerank_provider", "context_provider", "voyage_embed_model",
                "cohere_api_key"):
        assert key in body, (
            f"{key} is honored by the worker but was invisible to the API "
            "(R10 DUP-1) — DEFAULTS must be the worker superset"
        )


@pytest.mark.asyncio
async def test_cohere_key_is_settable_and_redacted(client_as_user_a, seeded_users):
    resp = await client_as_user_a.put(
        "/settings", json={"settings": {"cohere_api_key": "co-test-123"}}
    )
    assert resp.status_code == 200
    assert resp.json()["cohere_api_key"] == "set", (
        "cohere_api_key must be allow-listed AND in SECRET_KEYS"
    )
