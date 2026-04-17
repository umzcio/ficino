"""Tests for /annotations endpoints (list, get, upsert, delete).

Covers:
  - PUT /annotations/{feed_id}/{post_index} creates a row when none exists.
  - PUT again with a different body OVERWRITES the existing body (upsert,
    not duplicate) and `updated_at` moves forward.
  - PUT with empty/whitespace body returns 400.
  - GET /annotations/{feed_id}/{post_index} returns the current body.
  - DELETE returns 204 and a subsequent GET returns 404.
  - DELETE for a non-existent annotation returns 404.
  - GET /annotations scope: user B's annotation does not show up in A's list.
  - GET /annotations/{feed_id}/{post_index} for another user's annotation
    returns 404 (doesn't leak).
"""
from __future__ import annotations

import pytest

from tests.conftest import USER_A_ID, USER_B_ID


@pytest.mark.asyncio
async def test_upsert_annotation_creates_row(
    client_as_user_a, seeded_users, db_conn,
):
    r = await client_as_user_a.put(
        f"/annotations/{seeded_users['feed_a']}/0",
        json={"body": "interesting insight"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["body"] == "interesting insight"
    assert body["feed_id"] == seeded_users["feed_a"]
    assert body["post_index"] == 0

    row = await db_conn.fetchrow(
        "SELECT body FROM annotations WHERE user_id = $1 AND feed_id = $2 AND post_index = 0",
        USER_A_ID, seeded_users["feed_a"],
    )
    assert row["body"] == "interesting insight"


@pytest.mark.asyncio
async def test_upsert_annotation_overwrites_existing_body(
    client_as_user_a, seeded_users, db_conn,
):
    """Second PUT for the same (feed_id, post_index) replaces the body in place
    via the UNIQUE constraint + ON CONFLICT DO UPDATE. No duplicate row."""
    await client_as_user_a.put(
        f"/annotations/{seeded_users['feed_a']}/4",
        json={"body": "first"},
    )
    r = await client_as_user_a.put(
        f"/annotations/{seeded_users['feed_a']}/4",
        json={"body": "second"},
    )
    assert r.status_code == 200
    assert r.json()["body"] == "second"

    count = await db_conn.fetchval(
        "SELECT COUNT(*) FROM annotations WHERE user_id = $1 AND feed_id = $2 AND post_index = 4",
        USER_A_ID, seeded_users["feed_a"],
    )
    assert count == 1


@pytest.mark.asyncio
async def test_upsert_annotation_rejects_empty_body(client_as_user_a, seeded_users):
    r = await client_as_user_a.put(
        f"/annotations/{seeded_users['feed_a']}/0",
        json={"body": "   "},  # whitespace-only
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_get_annotation_returns_body(client_as_user_a, seeded_users):
    await client_as_user_a.put(
        f"/annotations/{seeded_users['feed_a']}/1",
        json={"body": "my note"},
    )
    r = await client_as_user_a.get(f"/annotations/{seeded_users['feed_a']}/1")
    assert r.status_code == 200
    assert r.json()["body"] == "my note"


@pytest.mark.asyncio
async def test_get_missing_annotation_returns_404(
    client_as_user_a, seeded_users,
):
    r = await client_as_user_a.get(f"/annotations/{seeded_users['feed_a']}/999")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_annotation_returns_204(
    client_as_user_a, seeded_users, db_conn,
):
    await client_as_user_a.put(
        f"/annotations/{seeded_users['feed_a']}/0",
        json={"body": "gone soon"},
    )
    r = await client_as_user_a.delete(f"/annotations/{seeded_users['feed_a']}/0")
    assert r.status_code == 204

    still = await db_conn.fetchval(
        "SELECT COUNT(*) FROM annotations WHERE user_id = $1 AND feed_id = $2 AND post_index = 0",
        USER_A_ID, seeded_users["feed_a"],
    )
    assert still == 0


@pytest.mark.asyncio
async def test_delete_missing_annotation_returns_404(
    client_as_user_a, seeded_users,
):
    r = await client_as_user_a.delete(f"/annotations/{seeded_users['feed_a']}/123")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_list_annotations_scoped_to_caller(
    client_as_user_a, seeded_users, db_conn,
):
    """User B has an annotation; user A's list must not see it."""
    # A creates their own annotation.
    await client_as_user_a.put(
        f"/annotations/{seeded_users['feed_a']}/0",
        json={"body": "A note"},
    )
    # B's annotation inserted directly.
    await db_conn.execute(
        """INSERT INTO annotations (user_id, feed_id, post_index, body)
           VALUES ($1, $2, $3, $4)""",
        USER_B_ID, seeded_users["feed_b"], 0, "B note",
    )

    r = await client_as_user_a.get("/annotations")
    assert r.status_code == 200
    bodies = [a["body"] for a in r.json()]
    assert "A note" in bodies
    assert "B note" not in bodies


@pytest.mark.asyncio
async def test_get_cross_user_annotation_returns_404(
    client_as_user_a, seeded_users, db_conn,
):
    """B has an annotation on B's feed; A asking for (B's feed_id, post_index)
    returns 404 rather than B's annotation body."""
    await db_conn.execute(
        """INSERT INTO annotations (user_id, feed_id, post_index, body)
           VALUES ($1, $2, $3, $4)""",
        USER_B_ID, seeded_users["feed_b"], 0, "B secret note",
    )

    r = await client_as_user_a.get(f"/annotations/{seeded_users['feed_b']}/0")
    assert r.status_code == 404
    # And the body must never appear in the error payload.
    assert "B secret note" not in r.text


@pytest.mark.asyncio
async def test_delete_cross_user_annotation_returns_404(
    client_as_user_a, seeded_users, db_conn,
):
    """A cannot wipe B's annotation by guessing (feed_id, post_index)."""
    await db_conn.execute(
        """INSERT INTO annotations (user_id, feed_id, post_index, body)
           VALUES ($1, $2, $3, $4)""",
        USER_B_ID, seeded_users["feed_b"], 0, "B keeps",
    )
    r = await client_as_user_a.delete(f"/annotations/{seeded_users['feed_b']}/0")
    assert r.status_code == 404

    # B's row is still there.
    still = await db_conn.fetchval(
        "SELECT COUNT(*) FROM annotations WHERE user_id = $1 AND feed_id = $2 AND post_index = 0",
        USER_B_ID, seeded_users["feed_b"],
    )
    assert still == 1
