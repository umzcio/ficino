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
