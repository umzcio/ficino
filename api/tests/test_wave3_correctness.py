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
