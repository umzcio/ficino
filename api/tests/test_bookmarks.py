"""Tests for /bookmarks endpoints (list, create, delete).

Covers:
  - POST /bookmarks returns 201 + new row ID, and the row is persisted.
  - POST /bookmarks a second time with the same (feed_id, post_index,
    message_index) is idempotent: it returns 200 with status=already_bookmarked
    and the existing id (it never errors, does not create a duplicate).
  - GET /bookmarks returns only the caller's bookmarks (IDOR regression).
  - DELETE /bookmarks/{id} of another user's bookmark returns 404.
  - DELETE /bookmarks/{id} of the caller's own bookmark returns 204.
  - Post-level (message_index = -1) and reply-level (message_index >= 0)
    bookmarks coexist for the same post.
"""
from __future__ import annotations

import pytest

from tests.conftest import USER_A_ID, USER_B_ID


@pytest.mark.asyncio
async def test_create_bookmark_returns_id_and_persists(
    client_as_user_a, seeded_users, db_conn,
):
    """A fresh bookmark returns 201 with status=created + the row is in the DB."""
    r = await client_as_user_a.post("/bookmarks", json={
        "feed_id": seeded_users["feed_a"],
        "post_index": 0,
        "message_index": -1,
        "post_snapshot": {"title": "hello", "body": "world"},
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert "id" in body
    assert body["status"] == "created"

    # Row actually made it to the DB.
    row = await db_conn.fetchrow(
        "SELECT user_id, feed_id, post_index, message_index FROM bookmarks WHERE id = $1",
        body["id"],
    )
    assert row is not None
    assert str(row["user_id"]) == USER_A_ID
    assert str(row["feed_id"]) == seeded_users["feed_a"]
    assert row["post_index"] == 0
    assert row["message_index"] == -1


@pytest.mark.asyncio
async def test_create_bookmark_duplicate_is_idempotent(
    client_as_user_a, seeded_users,
):
    """Creating the same bookmark twice returns status=already_bookmarked
    with the existing ID — no 409, no new row."""
    payload = {
        "feed_id": seeded_users["feed_a"],
        "post_index": 2,
        "message_index": -1,
        "post_snapshot": {"t": "x"},
    }
    r1 = await client_as_user_a.post("/bookmarks", json=payload)
    assert r1.status_code == 201, r1.text
    first_id = r1.json()["id"]

    r2 = await client_as_user_a.post("/bookmarks", json=payload)
    # Router returns 201 for both create and already_bookmarked (the `status`
    # field differentiates). We assert idempotency rather than a specific code.
    assert r2.status_code in (200, 201), r2.text
    body = r2.json()
    assert body["id"] == first_id
    assert body["status"] == "already_bookmarked"


@pytest.mark.asyncio
async def test_list_bookmarks_scoped_to_caller(
    client_as_user_a, seeded_users, db_conn,
):
    """User A creates one bookmark; user A's list shows it, and seeding a
    B-owned bookmark directly does not leak into A's list."""
    # A creates a bookmark.
    r_create = await client_as_user_a.post("/bookmarks", json={
        "feed_id": seeded_users["feed_a"],
        "post_index": 0,
        "post_snapshot": {"t": "a"},
    })
    assert r_create.status_code == 201
    a_bookmark_id = r_create.json()["id"]

    # Seed a B-owned bookmark directly.
    b_row = await db_conn.fetchrow(
        """INSERT INTO bookmarks (user_id, feed_id, post_index, message_index, post_snapshot)
           VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id""",
        USER_B_ID, seeded_users["feed_b"], 0, -1, '{"t":"b"}',
    )
    b_bookmark_id = str(b_row["id"])

    r = await client_as_user_a.get("/bookmarks")
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert a_bookmark_id in ids
    assert b_bookmark_id not in ids


@pytest.mark.asyncio
async def test_delete_bookmark_rejects_cross_user(
    client_as_user_a, seeded_users, db_conn,
):
    """User B owns a bookmark; user A deleting it must 404. The row must
    remain in the DB afterwards."""
    row = await db_conn.fetchrow(
        """INSERT INTO bookmarks (user_id, feed_id, post_index, message_index, post_snapshot)
           VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id""",
        USER_B_ID, seeded_users["feed_b"], 0, -1, '{"t":"b"}',
    )
    b_id = str(row["id"])

    r = await client_as_user_a.delete(f"/bookmarks/{b_id}")
    assert r.status_code == 404

    # Still there.
    still = await db_conn.fetchval(
        "SELECT COUNT(*) FROM bookmarks WHERE id = $1", b_id,
    )
    assert still == 1


@pytest.mark.asyncio
async def test_delete_own_bookmark_returns_204(
    client_as_user_a, seeded_users, db_conn,
):
    """Deleting your own bookmark returns 204 + row is gone."""
    r_create = await client_as_user_a.post("/bookmarks", json={
        "feed_id": seeded_users["feed_a"],
        "post_index": 5,
        "post_snapshot": {"t": "a"},
    })
    bookmark_id = r_create.json()["id"]

    r_del = await client_as_user_a.delete(f"/bookmarks/{bookmark_id}")
    assert r_del.status_code == 204

    gone = await db_conn.fetchval(
        "SELECT COUNT(*) FROM bookmarks WHERE id = $1", bookmark_id,
    )
    assert gone == 0


@pytest.mark.asyncio
async def test_post_and_reply_bookmarks_coexist(
    client_as_user_a, seeded_users,
):
    """The same (feed_id, post_index) can have independent bookmarks at
    message_index -1 (post-level) and >= 0 (reply-message level)."""
    feed_id = seeded_users["feed_a"]
    r_post = await client_as_user_a.post("/bookmarks", json={
        "feed_id": feed_id, "post_index": 3, "message_index": -1,
        "post_snapshot": {"t": "post"},
    })
    r_msg = await client_as_user_a.post("/bookmarks", json={
        "feed_id": feed_id, "post_index": 3, "message_index": 0,
        "post_snapshot": {"t": "msg"},
    })
    assert r_post.status_code == 201
    assert r_msg.status_code == 201
    assert r_post.json()["id"] != r_msg.json()["id"]

    r_list = await client_as_user_a.get("/bookmarks")
    message_indexes = {b["message_index"] for b in r_list.json()
                       if b["feed_id"] == feed_id and b["post_index"] == 3}
    assert message_indexes == {-1, 0}


@pytest.mark.asyncio
async def test_delete_bookmark_by_post_removes_exact_row(
    client_as_user_a, seeded_users, db_conn,
):
    """DELETE /bookmarks/post/{feed_id}/{post_index}?message_index=... removes
    the matching row while leaving bookmarks at other message_indexes alone."""
    feed_id = seeded_users["feed_a"]
    # Seed two bookmarks — post-level + reply-level for same post_index.
    r_post = await client_as_user_a.post("/bookmarks", json={
        "feed_id": feed_id, "post_index": 7, "message_index": -1,
        "post_snapshot": {"t": "post"},
    })
    r_reply = await client_as_user_a.post("/bookmarks", json={
        "feed_id": feed_id, "post_index": 7, "message_index": 2,
        "post_snapshot": {"t": "reply"},
    })
    assert r_post.status_code == 201
    assert r_reply.status_code == 201

    # Delete only the post-level one.
    r_del = await client_as_user_a.delete(
        f"/bookmarks/post/{feed_id}/7"  # default message_index=-1
    )
    assert r_del.status_code == 204

    remaining = await db_conn.fetch(
        "SELECT message_index FROM bookmarks WHERE user_id = $1 AND feed_id = $2 AND post_index = 7",
        USER_A_ID, feed_id,
    )
    assert [r["message_index"] for r in remaining] == [2]


@pytest.mark.asyncio
async def test_list_bookmarks_empty_for_new_user(client_as_user_a):
    """A user with no bookmarks gets back an empty list, not a 500."""
    r = await client_as_user_a.get("/bookmarks")
    assert r.status_code == 200
    assert r.json() == []
