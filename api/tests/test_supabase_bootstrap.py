"""Supabase provider bootstraps a default workspace on first sign-in.

Directly exercises `get_user_supabase` rather than going through an HTTP
request — the test suite runs with AUTH_PROVIDER=none, and flipping the
provider at import time would require re-importing the whole auth module.
The DB side-effects are what matter, not the HTTP wiring.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import asyncpg
import pytest

from auth.providers import get_user_supabase
from config import settings


@pytest.fixture
def mock_jwt_decode(monkeypatch):
    """Patch JWT verification to return whichever payload the test hands in.

    get_user_supabase now also inspects the token header to pick between
    the legacy HS256 path and the asymmetric JWKS path, so we stub both
    `get_unverified_header` (return a legacy-style header so the test takes
    the HS256 branch) and `decode` (return the test's fake payload).
    """
    import jwt
    payloads = {}

    def fake_decode(token, *_a, **_k):
        return payloads[token]

    def fake_unverified_header(_token):
        return {"alg": "HS256"}

    monkeypatch.setattr(jwt, "decode", fake_decode)
    monkeypatch.setattr(jwt, "get_unverified_header", fake_unverified_header)
    # Supabase provider refuses to run without a jwt secret configured
    monkeypatch.setattr(settings, "supabase_jwt_secret", "fake-secret")
    return payloads


def _fake_request(auth_header: str):
    # get_user_supabase only reads request.headers.get("authorization")
    r = MagicMock()
    r.headers.get = lambda k, default="": (
        auth_header if k.lower() == "authorization" else default
    )
    return r


@pytest.mark.asyncio
async def test_first_signin_creates_default_workspace(
    db_conn: asyncpg.Connection, mock_jwt_decode,
):
    sub = f"test-sub-{uuid.uuid4()}"
    email = f"u-{uuid.uuid4().hex[:8]}@example.com"
    token = "tok-1"
    mock_jwt_decode[token] = {"sub": sub, "email": email, "aud": "authenticated"}

    user = await get_user_supabase(
        _fake_request(f"Bearer {token}"), db_conn,
    )

    try:
        # User row exists
        row = await db_conn.fetchrow(
            "SELECT id FROM users WHERE clerk_id = $1", sub,
        )
        assert row is not None
        assert str(row["id"]) == user.id

        # Default workspace seeded
        corpora = await db_conn.fetch(
            "SELECT name FROM corpora WHERE user_id = $1", user.id,
        )
        assert len(corpora) == 1
        assert corpora[0]["name"] == "Default"
    finally:
        await db_conn.execute("DELETE FROM users WHERE clerk_id = $1", sub)


@pytest.mark.asyncio
async def test_repeat_signin_does_not_duplicate_workspace(
    db_conn: asyncpg.Connection, mock_jwt_decode,
):
    sub = f"test-sub-{uuid.uuid4()}"
    email = f"u-{uuid.uuid4().hex[:8]}@example.com"
    token = "tok-2"
    mock_jwt_decode[token] = {"sub": sub, "email": email, "aud": "authenticated"}

    try:
        user_a = await get_user_supabase(_fake_request(f"Bearer {token}"), db_conn)
        # Second sign-in — simulates a returning user
        user_b = await get_user_supabase(_fake_request(f"Bearer {token}"), db_conn)
        assert user_a.id == user_b.id

        count = await db_conn.fetchval(
            "SELECT COUNT(*) FROM corpora WHERE user_id = $1", user_a.id,
        )
        assert count == 1, "repeat sign-in must not create another Default corpus"
    finally:
        await db_conn.execute("DELETE FROM users WHERE clerk_id = $1", sub)
