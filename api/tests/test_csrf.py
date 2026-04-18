"""CSRF double-submit enforcement.

Round 4 removed the AUTH_PROVIDER=none bypass — the middleware now enforces
regardless of auth provider, because a self-hosted single-user deployment is
still reachable from any origin the logged-in user's browser visits.
"""
from __future__ import annotations

import httpx
import pytest
import pytest_asyncio

from main import app
from config import settings


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        yield c


@pytest.mark.asyncio
async def test_csrf_enforced_in_auth_none(client):
    """Even under auth=none the middleware rejects unprotected mutations.
    (The /feed/generate route requires auth for real, but CSRF runs first.)"""
    r = await client.post("/feed/generate", json={})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_csrf_allows_health_get(client):
    """GETs are never CSRF-protected; /health stays reachable."""
    r = await client.get("/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_csrf_required_when_auth_basic(monkeypatch, client):
    monkeypatch.setattr(settings, "auth_provider", "basic")
    r = await client.post("/feed/generate", json={})
    # 403 = CSRF failure. 401 would mean the CSRF check passed and auth rejected.
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_csrf_exempt_login(monkeypatch, client):
    monkeypatch.setattr(settings, "auth_provider", "basic")
    # Login is in CSRF_EXEMPT_PATHS — should reach the actual route (fails for other reasons,
    # but not 403 CSRF).
    r = await client.post("/auth/login", json={"email": "x", "password": "y"})
    assert r.status_code != 403


@pytest.mark.asyncio
async def test_csrf_accepts_matching_cookie_and_header(monkeypatch, client):
    monkeypatch.setattr(settings, "auth_provider", "basic")
    token = "test-csrf-token-123"
    client.cookies.set("ficino_csrf", token)
    # Still fails for auth reasons but the CSRF middleware should not 403.
    r = await client.post(
        "/feed/generate", json={}, headers={"X-CSRF-Token": token},
    )
    assert r.status_code != 403
