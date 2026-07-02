"""Test fixtures — seed two fake users + owned resources, then swap
`get_current_user` to simulate requests from each.

Run inside the api container:

    docker exec -it ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -v"

Uses the live postgres. Every fixture wraps its writes in a transaction that
is rolled back at the end, so running the suite does not leave test data
behind. Tests do NOT exercise the worker/Celery path — that needs separate
integration tests; here we only verify router auth scoping.
"""

from __future__ import annotations

import os
import uuid
from typing import AsyncGenerator

import asyncpg
import httpx
import pytest_asyncio

# Make sure main.py finds the right settings at import time. The api container
# already provides DATABASE_URL via env_file; in local dev, point at the
# ficino-postgres service.
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://ficino:ficino@postgres:5432/ficino",
)
os.environ.setdefault("REDIS_URL", "redis://redis:6379/0")
os.environ.setdefault("AUTH_PROVIDER", "none")
os.environ.setdefault("ENVIRONMENT", "test")

from main import app  # noqa: E402
from auth import get_current_user  # noqa: E402
from auth.models import AuthUser  # noqa: E402
from db import connection as db_connection  # noqa: E402


USER_A_ID = "11111111-1111-1111-1111-111111111111"
USER_B_ID = "22222222-2222-2222-2222-222222222222"


@pytest_asyncio.fixture(scope="session", loop_scope="session", autouse=True)
async def _db_pool_lifecycle():
    """Initialize the app's asyncpg pool once for the whole test session.

    ASGITransport doesn't fire FastAPI lifespan events, so the app's own
    startup handler never runs. Bypass it: create the pool directly.
    """
    await db_connection.create_pool()
    try:
        yield
    finally:
        await db_connection.close_pool()


@pytest_asyncio.fixture
async def db_conn() -> AsyncGenerator[asyncpg.Connection, None]:
    """Raw asyncpg connection for seeding test rows.

    NOT transactional — we do explicit cleanup in `seeded_users` so that the
    app's own connection pool (which isn't part of this transaction) can see
    the seeded rows over HTTP.
    """
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        yield conn
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def seeded_users(db_conn: asyncpg.Connection):
    """Create two fake users + one owned workspace + one owned feed each.

    Cleans up all inserted rows at teardown (ON DELETE CASCADE handles the rest).
    """
    workspace_a = str(uuid.uuid4())
    workspace_b = str(uuid.uuid4())
    feed_a = str(uuid.uuid4())
    feed_b = str(uuid.uuid4())
    paper_a = str(uuid.uuid4())
    paper_b = str(uuid.uuid4())

    # Seed
    await db_conn.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4) "
        "ON CONFLICT (id) DO NOTHING",
        USER_A_ID, "auth-test-a@ficino.dev",
        USER_B_ID, "auth-test-b@ficino.dev",
    )
    await db_conn.execute(
        "INSERT INTO corpora (id, user_id, name) VALUES ($1, $2, $3), ($4, $5, $6)",
        workspace_a, USER_A_ID, "A-ws",
        workspace_b, USER_B_ID, "B-ws",
    )
    await db_conn.execute(
        "INSERT INTO feeds (id, user_id, corpus_id, posts, post_count) "
        "VALUES ($1, $2, $3, '[]'::jsonb, 0), ($4, $5, $6, '[]'::jsonb, 0)",
        feed_a, USER_A_ID, workspace_a,
        feed_b, USER_B_ID, workspace_b,
    )
    await db_conn.execute(
        "INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status) "
        "VALUES ($1, $2, $3, 'a.pdf', '/tmp/a.pdf', 'complete'), "
        "      ($4, $5, $6, 'b.pdf', '/tmp/b.pdf', 'complete')",
        paper_a, USER_A_ID, workspace_a,
        paper_b, USER_B_ID, workspace_b,
    )

    yield {
        "user_a": USER_A_ID, "user_b": USER_B_ID,
        "workspace_a": workspace_a, "workspace_b": workspace_b,
        "feed_a": feed_a, "feed_b": feed_b,
        "paper_a": paper_a, "paper_b": paper_b,
    }

    # Teardown. ON DELETE CASCADE on users takes care of corpora/feeds/papers/etc.
    await db_conn.execute("DELETE FROM users WHERE id IN ($1, $2)", USER_A_ID, USER_B_ID)


_CSRF_TEST_TOKEN = "test-csrf-token-fixture"


class _CsrfAutoClient(httpx.AsyncClient):
    """AsyncClient that auto-attaches the double-submit CSRF pair.

    Round 4 removed the AUTH_PROVIDER=none bypass, so mutating requests
    must echo the ficino_csrf cookie in X-CSRF-Token. Every test client
    gets the same fixed cookie value preseeded and the matching header
    injected on POST/PUT/DELETE/PATCH — tests stay unchanged, and the CSRF
    middleware sees a valid pair.
    """

    async def request(self, method, url, **kwargs):  # type: ignore[override]
        if method.upper() in ("POST", "PUT", "DELETE", "PATCH"):
            headers = dict(kwargs.pop("headers", None) or {})
            headers.setdefault("X-CSRF-Token", _CSRF_TEST_TOKEN)
            kwargs["headers"] = headers
        return await super().request(method, url, **kwargs)


@pytest_asyncio.fixture
async def client_as_user_a(seeded_users):
    """Async httpx client that spoofs user A via dependency_overrides.
    Use this to make requests *as if* user A were authenticated.
    """
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=USER_A_ID, email="auth-test-a@ficino.dev", display_name="A"
    )
    try:
        async with _CsrfAutoClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            client.cookies.set("ficino_csrf", _CSRF_TEST_TOKEN)
            yield client
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest_asyncio.fixture
async def client_as_user_b(seeded_users):
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=USER_B_ID, email="auth-test-b@ficino.dev", display_name="B"
    )
    try:
        async with _CsrfAutoClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            client.cookies.set("ficino_csrf", _CSRF_TEST_TOKEN)
            yield client
    finally:
        app.dependency_overrides.pop(get_current_user, None)
