"""Tests for the PUBLIC_DEPLOYMENT flag.

Covers:
  * /auth/provider surfaces public_deployment so the frontend can discover it
  * PUT /settings silently drops provider-override keys when public
  * PUT /settings still accepts non-provider keys under the same request
  * Non-public installs still accept provider keys (default behaviour)
"""
from __future__ import annotations

import pytest

from routers.settings import DEFAULTS


@pytest.mark.asyncio
async def test_auth_provider_exposes_public_deployment(client_as_user_a, monkeypatch):
    from config import settings
    monkeypatch.setattr(settings, "public_deployment", True)
    r = await client_as_user_a.get("/auth/provider")
    assert r.status_code == 200
    body = r.json()
    assert body.get("public_deployment") is True
    # Field still carries the auth provider alongside the new flag.
    assert "provider" in body


@pytest.mark.asyncio
async def test_auth_provider_defaults_public_deployment_false(client_as_user_a):
    r = await client_as_user_a.get("/auth/provider")
    assert r.status_code == 200
    # Default public_deployment is False — self-host installs unchanged.
    assert r.json().get("public_deployment") is False


@pytest.mark.asyncio
async def test_public_deployment_drops_provider_overrides(
    client_as_user_a, monkeypatch,
):
    """When public_deployment=true, a user PUT to /settings with provider
    keys must leave those keys at their configured defaults — the operator's
    env config is authoritative."""
    from config import settings
    monkeypatch.setattr(settings, "public_deployment", True)

    r = await client_as_user_a.put(
        "/settings",
        json={
            "settings": {
                "llm_provider": "ollama",           # should be dropped
                "anthropic_api_key": "sk-evil",     # should be dropped
                "auto_generate_on_upload": True,    # non-provider, keeps
            }
        },
    )
    assert r.status_code == 200

    # Fetch and confirm the locked keys did NOT change but the allowed one did.
    g = await client_as_user_a.get("/settings")
    body = g.json()
    assert body["auto_generate_on_upload"] is True
    # anthropic_api_key is redacted as 'set'/'' — it must reflect the
    # operator-configured DEFAULT (env-derived, R10 DUP-1), not the
    # attacker-supplied "sk-evil" that PROVIDER_OVERRIDE_KEYS dropped. We
    # compare against DEFAULTS directly rather than hardcoding "" so this
    # test doesn't assume a particular deployment's env has no key set.
    expected_anthropic_redacted = "set" if DEFAULTS["anthropic_api_key"] else ""
    assert body["anthropic_api_key"] == expected_anthropic_redacted
    # llm_provider comes back as the DEFAULTS value, not the override.
    assert body["llm_provider"] in ("ollama", "api")


@pytest.mark.asyncio
async def test_self_host_accepts_provider_overrides(client_as_user_a, monkeypatch):
    """With public_deployment=false (default / self-host), the same request
    is accepted end-to-end."""
    from config import settings
    monkeypatch.setattr(settings, "public_deployment", False)

    r = await client_as_user_a.put(
        "/settings",
        json={"settings": {"llm_provider": "api"}},
    )
    assert r.status_code == 200

    g = await client_as_user_a.get("/settings")
    assert g.json()["llm_provider"] == "api"
