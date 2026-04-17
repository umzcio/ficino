"""Tests for /likes endpoints (toggle on/off, list, stats, preferences).

Covers:
  - POST /likes creates a row with status=created (toggle on).
  - POST /likes with the same (feed_id, post_index, message_index) is
    idempotent — returns status=already_liked with the existing ID.
  - DELETE /likes/feed/{feed_id}/{post_index} removes the row (toggle off)
    and a subsequent DELETE returns 404.
  - GET /likes/feed/{feed_id} returns post indices (message_index=-1) under
    `posts` and reply keys under `replies`.
  - GET /likes/feed/{feed_id} does not leak another user's likes.
  - DELETE of a like that does not belong to the caller returns 404.
  - GET /likes/stats returns the count scoped to the caller.
  - GET /likes/preferences with no likes returns has_signal=False.
"""
from __future__ import annotations

import pytest

from tests.conftest import USER_A_ID, USER_B_ID


@pytest.mark.asyncio
async def test_create_like_persists(client_as_user_a, seeded_users, db_conn):
    r = await client_as_user_a.post("/likes", json={
        "feed_id": seeded_users["feed_a"],
        "post_index": 0,
        "message_index": -1,
    })
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "created"

    count = await db_conn.fetchval(
        "SELECT COUNT(*) FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = 0 AND message_index = -1",
        USER_A_ID, seeded_users["feed_a"],
    )
    assert count == 1


@pytest.mark.asyncio
async def test_create_like_is_idempotent(client_as_user_a, seeded_users):
    payload = {
        "feed_id": seeded_users["feed_a"],
        "post_index": 1,
        "message_index": -1,
    }
    r1 = await client_as_user_a.post("/likes", json=payload)
    assert r1.status_code == 201
    id1 = r1.json()["id"]

    r2 = await client_as_user_a.post("/likes", json=payload)
    assert r2.status_code in (200, 201)
    assert r2.json()["id"] == id1
    assert r2.json()["status"] == "already_liked"


@pytest.mark.asyncio
async def test_delete_like_removes_row(client_as_user_a, seeded_users, db_conn):
    await client_as_user_a.post("/likes", json={
        "feed_id": seeded_users["feed_a"],
        "post_index": 2,
    })

    r_del = await client_as_user_a.delete(
        f"/likes/feed/{seeded_users['feed_a']}/2"
    )
    assert r_del.status_code == 204

    count = await db_conn.fetchval(
        "SELECT COUNT(*) FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = 2",
        USER_A_ID, seeded_users["feed_a"],
    )
    assert count == 0


@pytest.mark.asyncio
async def test_delete_like_that_doesnt_exist_returns_404(
    client_as_user_a, seeded_users,
):
    r = await client_as_user_a.delete(
        f"/likes/feed/{seeded_users['feed_a']}/999"
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_list_likes_returns_posts_and_replies(
    client_as_user_a, seeded_users,
):
    """Post-level likes appear under `posts`; reply-level likes appear under
    `replies` keyed as `"postIndex:messageIndex"`."""
    feed_id = seeded_users["feed_a"]
    await client_as_user_a.post("/likes", json={
        "feed_id": feed_id, "post_index": 0, "message_index": -1,
    })
    await client_as_user_a.post("/likes", json={
        "feed_id": feed_id, "post_index": 0, "message_index": 2,
    })
    await client_as_user_a.post("/likes", json={
        "feed_id": feed_id, "post_index": 5, "message_index": -1,
    })

    r = await client_as_user_a.get(f"/likes/feed/{feed_id}")
    assert r.status_code == 200
    body = r.json()
    assert sorted(body["posts"]) == [0, 5]
    assert body["replies"] == {"0:2": True}


@pytest.mark.asyncio
async def test_list_likes_does_not_leak_other_users(
    client_as_user_a, seeded_users, db_conn,
):
    """If B has a like on the same feed_id (shouldn't happen in real life,
    but the scope check must still hold), A's list endpoint must only show
    A's likes."""
    feed_id = seeded_users["feed_a"]
    # A likes post 0.
    await client_as_user_a.post("/likes", json={
        "feed_id": feed_id, "post_index": 0, "message_index": -1,
    })
    # B directly likes post 42 on the same feed row.
    await db_conn.execute(
        """INSERT INTO user_likes (user_id, feed_id, post_index, message_index)
           VALUES ($1, $2, 42, -1)""",
        USER_B_ID, feed_id,
    )

    r = await client_as_user_a.get(f"/likes/feed/{feed_id}")
    assert r.status_code == 200
    posts = r.json()["posts"]
    assert 0 in posts
    assert 42 not in posts


@pytest.mark.asyncio
async def test_delete_cross_user_like_returns_404(
    client_as_user_a, seeded_users, db_conn,
):
    """B has a like on B's feed; A trying to DELETE by (feed_id, post_index)
    must 404 — the DELETE is scoped to user_id = caller.id so it can't touch
    B's row."""
    await db_conn.execute(
        """INSERT INTO user_likes (user_id, feed_id, post_index, message_index)
           VALUES ($1, $2, 0, -1)""",
        USER_B_ID, seeded_users["feed_b"],
    )
    r = await client_as_user_a.delete(
        f"/likes/feed/{seeded_users['feed_b']}/0"
    )
    assert r.status_code == 404

    # B's like is intact.
    still = await db_conn.fetchval(
        "SELECT COUNT(*) FROM user_likes WHERE user_id = $1 AND feed_id = $2 AND post_index = 0",
        USER_B_ID, seeded_users["feed_b"],
    )
    assert still == 1


@pytest.mark.asyncio
async def test_like_stats_scoped_to_caller(
    client_as_user_a, seeded_users, db_conn,
):
    """stats counts only caller's rows."""
    # A likes 2 posts.
    for idx in (0, 1):
        await client_as_user_a.post("/likes", json={
            "feed_id": seeded_users["feed_a"], "post_index": idx,
        })
    # B has 5 likes that should NOT contribute to A's stats.
    for idx in range(5):
        await db_conn.execute(
            """INSERT INTO user_likes (user_id, feed_id, post_index, message_index)
               VALUES ($1, $2, $3, -1)""",
            USER_B_ID, seeded_users["feed_b"], idx,
        )

    r = await client_as_user_a.get("/likes/stats")
    assert r.status_code == 200
    assert r.json()["total_likes"] == 2


@pytest.mark.asyncio
async def test_preferences_empty_user_returns_no_signal(client_as_user_a):
    """A user with zero likes and no stored preference profile should get a
    has_signal=False response rather than a 500."""
    r = await client_as_user_a.get("/likes/preferences")
    assert r.status_code == 200
    body = r.json()
    assert body["has_signal"] is False
    assert body["total_likes"] == 0
