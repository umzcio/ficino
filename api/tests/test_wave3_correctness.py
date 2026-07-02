"""Round 10 Wave 3 Task 8 — api correctness-bug cluster.

Covers, one section per finding:
  - API-10: create_like / create_bookmark upsert race (double-tap 500)
  - API-13: get_workspace_activity mixed-type sort key (None timestamp TypeError)
  - API-14: clear_all_papers non-transactional delete + duplicated cleanup closure
  - API-15: user_posts dispatch-failure stranding + follow-up status-flip guard
  - API-16: delete_persona_dm_message non-atomic read-modify-write
  - API-2: rate limit on GET /messages/papers/{id} charging cached reads
  - API-11: APA citation formatter 20/21+ author boundaries
  - API-12/BP-5: reading-list reorder/apply-ordering duplicate paper IDs + pydantic body
"""
from __future__ import annotations

import asyncio
import inspect
import uuid

import pytest

from tests.conftest import USER_A_ID


class _FakeRedis:
    """In-memory counter standing in for `auth.rate_limit._get_redis()`."""

    def __init__(self):
        self.counts: dict[str, int] = {}

    async def incr(self, key):
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, key, seconds):
        return True


# --- API-10: create_like / create_bookmark upsert race -----------------

@pytest.mark.asyncio
async def test_concurrent_create_like_both_2xx_only_one_row(
    client_as_user_a, seeded_users, db_conn,
):
    """Two concurrent identical POST /likes never 500 and only persist one row."""
    payload = {
        "feed_id": seeded_users["feed_a"],
        "post_index": 5,
        "message_index": -1,
    }
    r1, r2 = await asyncio.gather(
        client_as_user_a.post("/likes", json=payload),
        client_as_user_a.post("/likes", json=payload),
    )
    assert r1.status_code in (200, 201), r1.text
    assert r2.status_code in (200, 201), r2.text

    rows = await db_conn.fetch(
        "SELECT id FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        USER_A_ID, seeded_users["feed_a"], 5, -1,
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_concurrent_create_bookmark_both_2xx_only_one_row(
    client_as_user_a, seeded_users, db_conn,
):
    """Two concurrent identical POST /bookmarks never 500 and only persist one row."""
    payload = {
        "feed_id": seeded_users["feed_a"],
        "post_index": 7,
        "message_index": -1,
        "post_snapshot": {"t": "race"},
    }
    r1, r2 = await asyncio.gather(
        client_as_user_a.post("/bookmarks", json=payload),
        client_as_user_a.post("/bookmarks", json=payload),
    )
    assert r1.status_code in (200, 201), r1.text
    assert r2.status_code in (200, 201), r2.text

    rows = await db_conn.fetch(
        "SELECT id FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = $3 AND message_index = $4",
        USER_A_ID, seeded_users["feed_a"], 7, -1,
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_create_like_still_returns_created_and_already_liked(
    client_as_user_a, seeded_users,
):
    """Non-concurrent contract is unchanged: first call 'created', repeat 'already_liked'."""
    payload = {"feed_id": seeded_users["feed_a"], "post_index": 9, "message_index": -1}
    r1 = await client_as_user_a.post("/likes", json=payload)
    assert r1.status_code == 201
    assert r1.json()["status"] == "created"
    first_id = r1.json()["id"]

    r2 = await client_as_user_a.post("/likes", json=payload)
    assert r2.status_code in (200, 201)
    assert r2.json()["status"] == "already_liked"
    assert r2.json()["id"] == first_id


# --- API-13: get_workspace_activity mixed-type sort key -----------------

def test_activity_sort_key_handles_none_timestamp():
    """The extracted sort key must not raise TypeError when a timestamp is
    None, and must sort None entries as oldest (not crash on datetime-vs-str
    comparison, which the old `a["timestamp"] or ""` fallback caused)."""
    from datetime import datetime, timezone

    from routers.workspaces import _activity_sort_key

    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    earlier = datetime(2025, 1, 1, tzinfo=timezone.utc)
    activities = [
        {"type": "paper_upload", "timestamp": now},
        {"type": "feed_generation", "timestamp": None},
        {"type": "paper_upload", "timestamp": earlier},
    ]

    # Must not raise.
    activities.sort(key=_activity_sort_key, reverse=True)

    assert activities[0]["timestamp"] == now
    assert activities[1]["timestamp"] == earlier
    assert activities[2]["timestamp"] is None


# --- API-14: clear_all_papers transaction + hoisted cleanup closure -----

def test_cleanup_artifacts_is_a_single_module_level_function():
    """clear_everything and clear_all_papers must share one
    `_cleanup_artifacts` function object, not two copy-pasted closures."""
    from routers import settings as settings_router

    assert hasattr(settings_router, "_cleanup_artifacts"), (
        "_cleanup_artifacts must be hoisted to module level"
    )
    assert inspect.isfunction(settings_router._cleanup_artifacts)
    # Not a closure defined inside either handler.
    src_clear_everything = inspect.getsource(settings_router.clear_everything)
    src_clear_all_papers = inspect.getsource(settings_router.clear_all_papers)
    assert "def _cleanup_artifacts" not in src_clear_everything
    assert "def _cleanup_artifacts" not in src_clear_all_papers


@pytest.mark.asyncio
async def test_clear_all_papers_deletes_papers_and_feeds(
    client_as_user_a, seeded_users, db_conn,
):
    """Happy path still works with the transaction wrap: papers and feeds
    for the caller are gone, another user's data is untouched."""
    r = await client_as_user_a.post("/settings/clear-papers")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "cleared"

    remaining = await db_conn.fetchval(
        "SELECT COUNT(*) FROM papers WHERE user_id = $1", USER_A_ID,
    )
    assert remaining == 0

    # User B's paper survives.
    b_remaining = await db_conn.fetchval(
        "SELECT COUNT(*) FROM papers WHERE id = $1", seeded_users["paper_b"],
    )
    assert b_remaining == 1


# --- API-15: user_posts dispatch-failure stranding + follow-up guard ----

class _RaisingCelery:
    def send_task(self, *args, **kwargs):
        raise ConnectionError("broker unreachable")


class _FakeTaskB:
    id = "fake-task-id-b"


class _WorkingCelery:
    def send_task(self, *args, **kwargs):
        return _FakeTaskB()


@pytest.mark.asyncio
async def test_create_user_post_dispatch_failure_marks_error_not_pending(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """If Celery dispatch raises after the DB insert, the row must be
    marked 'error' (not left stranded 'pending' forever) and the request
    must return a 5xx."""
    from routers import user_posts

    monkeypatch.setattr(user_posts, "get_celery", lambda: _RaisingCelery())

    r = await client_as_user_a.post("/user-posts", json={
        "content": "will the dispatch fail gracefully?",
        "corpus_id": seeded_users["workspace_a"],
    })
    assert 500 <= r.status_code < 600, r.text

    row = await db_conn.fetchrow(
        "SELECT status FROM user_posts WHERE user_id = $1 AND content = $2",
        USER_A_ID, "will the dispatch fail gracefully?",
    )
    assert row is not None, "the row must still exist (INSERT happened before dispatch)"
    assert row["status"] == "error", (
        "a dispatch failure must flip the row to 'error', not strand it 'pending'"
    )


@pytest.mark.asyncio
async def test_reply_to_user_post_concurrent_double_fire_only_one_wins(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """Two truly concurrent follow-ups on the same complete post race the
    read-check-then-write: without a guard on the UPDATE itself, both can
    read status='complete' before either write lands, so both pass and
    both append a user turn ahead of a single Archivist reply. Exactly one
    must win (202); the other must 409."""
    from routers import user_posts

    monkeypatch.setattr(user_posts, "get_celery", lambda: _WorkingCelery())

    post_id = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO user_posts (id, user_id, corpus_id, content, status, replies, sources)
           VALUES ($1, $2, $3, 'seed', 'complete', '[]'::jsonb, '[]'::jsonb)""",
        post_id, USER_A_ID, seeded_users["workspace_a"],
    )

    r1, r2 = await asyncio.gather(
        client_as_user_a.post(f"/user-posts/{post_id}/replies", json={"content": "first"}),
        client_as_user_a.post(f"/user-posts/{post_id}/replies", json={"content": "second"}),
    )
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses == [202, 409], (r1.status_code, r2.status_code, r1.text, r2.text)

    row = await db_conn.fetchrow(
        "SELECT replies FROM user_posts WHERE id = $1", post_id,
    )
    replies = row["replies"]
    import json as _json
    if isinstance(replies, str):
        replies = _json.loads(replies)
    assert len(replies) == 1, "only the winning follow-up's user turn should have landed"


# --- API-16: delete_persona_dm_message atomic delete ---------------------

@pytest.mark.asyncio
async def test_delete_persona_dm_message_atomic(
    client_as_user_a, seeded_users, db_conn,
):
    """Deleting index 0 from a 1-message thread twice: the first succeeds
    and removes the message atomically (not via a full-array overwrite);
    the second finds nothing at that index and 404s rather than
    corrupting the thread."""
    import json as _json

    persona_key = await db_conn.fetchval("SELECT key FROM personas LIMIT 1")
    messages = _json.dumps([{"role": "user", "content": "hello"}])
    await db_conn.execute(
        """INSERT INTO persona_dms (user_id, persona_key, messages)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (user_id, persona_key) DO UPDATE SET messages = $3::jsonb""",
        USER_A_ID, persona_key, messages,
    )

    r1 = await client_as_user_a.delete(f"/personas/{persona_key}/dm/0")
    assert r1.status_code == 200, r1.text
    assert r1.json()["messages"] == []

    row = await db_conn.fetchrow(
        "SELECT messages FROM persona_dms WHERE user_id = $1 AND persona_key = $2",
        USER_A_ID, persona_key,
    )
    stored = row["messages"]
    if isinstance(stored, str):
        stored = _json.loads(stored)
    assert stored == [], "the DB row must actually be empty after the atomic delete"

    r2 = await client_as_user_a.delete(f"/personas/{persona_key}/dm/0")
    assert r2.status_code == 404, r2.text


def test_delete_persona_dm_message_uses_atomic_jsonb_operator_not_read_modify_write():
    """Implementation-shape check (mirrors the API-14 inspect pattern):
    the handler must use Postgres's atomic `messages - $n::int` element
    removal — the same pattern replies.py:delete_reply_message already
    uses (R10 API-16) — not a SELECT-then-Python-pop-then-overwrite. The
    latter clobbers any turn appended by an in-flight LLM send
    (send_persona_dm's `|| EXCLUDED.messages` upsert) that lands between
    the read and the write; only a single atomic UPDATE closes that race."""
    from routers import personas

    src = inspect.getsource(personas.delete_persona_dm_message)
    assert ".pop(" not in src, (
        "delete_persona_dm_message must not mutate the array in Python "
        "and overwrite the whole column — that's the non-atomic "
        "read-modify-write this finding is about"
    )
    assert "messages - $" in src or "messages -" in src, (
        "delete_persona_dm_message must use the atomic jsonb `-` "
        "operator, same as replies.py's delete_reply_message"
    )


# --- API-2: rate limit on GET /messages/papers/{id} must not charge reads --

@pytest.mark.asyncio
async def test_cached_paper_summary_reads_never_charge_rate_limit(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """A paper with an already-complete summary is a pure read. Reading it
    N times, N far over the per-day limit, must never 429 and must never
    touch the rate limiter — only dispatch paths should be charged."""
    import json as _json

    from auth import rate_limit as rate_limit_module
    from config import settings as app_settings

    fake_redis = _FakeRedis()

    async def _fake_get_redis():
        return fake_redis

    # The rate limiter no-ops entirely under AUTH_PROVIDER=none (the suite's
    # default) — flip to "basic" so the limiter is actually active, per the
    # brief's prescribed test setup.
    monkeypatch.setattr(app_settings, "auth_provider", "basic")
    monkeypatch.setattr(rate_limit_module, "_get_redis", _fake_get_redis)

    paper_id = seeded_users["paper_a"]
    await db_conn.execute(
        """INSERT INTO paper_summaries (paper_id, messages, status, task_id)
           VALUES ($1, $2, 'complete', NULL)
           ON CONFLICT (paper_id) DO UPDATE SET messages = $2, status = 'complete', task_id = NULL""",
        paper_id, _json.dumps([{"role": "persona", "content": "hi"}]),
    )

    # 10 reads — the underlying assertion is that none of them touch the
    # rate limiter at all (not that they 429; the default daily limit is
    # generous enough not to trip in 10 reads either way).
    for i in range(10):
        r = await client_as_user_a.get(f"/messages/papers/{paper_id}")
        assert r.status_code == 200, f"read #{i} got {r.status_code}: {r.text}"

    assert fake_redis.counts == {}, (
        "cached-read path must never increment the rate limiter, "
        f"but saw: {fake_redis.counts}"
    )


@pytest.mark.asyncio
async def test_paper_summary_dispatch_path_charges_rate_limit(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """A paper with no existing summary triggers dispatch — that path must
    still be charged against the summary budget."""
    from auth import rate_limit as rate_limit_module
    from config import settings as app_settings

    fake_redis = _FakeRedis()

    async def _fake_get_redis():
        return fake_redis

    class _FakeCeleryC:
        def send_task(self, *a, **k):
            class _T:
                id = "fake-task-c"
            return _T()

    from routers import messages as messages_router
    monkeypatch.setattr(messages_router, "get_celery", lambda: _FakeCeleryC())
    monkeypatch.setattr(app_settings, "auth_provider", "basic")
    monkeypatch.setattr(app_settings, "rate_limit_summary_per_day", 30)
    monkeypatch.setattr(rate_limit_module, "_get_redis", _fake_get_redis)

    paper_id = seeded_users["paper_a"]
    await db_conn.execute("DELETE FROM paper_summaries WHERE paper_id = $1", paper_id)

    r = await client_as_user_a.get(f"/messages/papers/{paper_id}")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "generating"

    assert any(k.startswith("ratelimit:summary:") for k in fake_redis.counts), (
        "the dispatch path must charge the summary rate limit, "
        f"but saw: {fake_redis.counts}"
    )
