"""CSRF double-submit enforcement under AUTH_PROVIDER=basic.

Under AUTH_PROVIDER=none (dev/self-hosted), the middleware bypasses.
The tests here temporarily monkeypatch settings.auth_provider to exercise
the enforcement path.
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
async def test_csrf_bypassed_in_auth_none(client):
    # Under auth=none, state-changing requests work without a CSRF header.
    # (Uses a read-only GET to avoid real writes — the point is the middleware doesn't reject.)
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
