"""Tests for /tags endpoints (list, create, delete, assign, unassign).

Covers:
  - POST /tags creates a tag, returns its id + name.
  - POST /tags with an existing name returns the existing id (idempotent).
  - POST /tags with an empty name returns 400.
  - DELETE /tags/{id} removes the row; deleting a non-existent tag returns 404.
  - POST /tags/assign attaches a tag to a paper (owned by caller).
  - POST /tags/assign rejects a foreign paper (404) — Phase 2 ownership check.
  - POST /tags/assign rejects an empty tag name (400).
  - GET /tags returns only the caller's tags (IDOR regression).
  - GET /tags/paper/{id} returns the assigned tags for a caller-owned paper.
  - DELETE /tags/assign/{paper_id}/{tag_id} unassigns.
  - DELETE /tags/{id} cannot remove another user's tag (404).
"""
from __future__ import annotations

import uuid

import pytest

from tests.conftest import USER_A_ID, USER_B_ID


@pytest.mark.asyncio
async def test_create_tag_persists(client_as_user_a, db_conn):
    r = await client_as_user_a.post("/tags", json={"name": "methods"})
    assert r.status_code == 201
    assert r.json()["name"] == "methods"
    tag_id = r.json()["id"]

    name = await db_conn.fetchval(
        "SELECT name FROM tags WHERE id = $1 AND user_id = $2",
        tag_id, USER_A_ID,
    )
    assert name == "methods"


@pytest.mark.asyncio
async def test_create_tag_is_idempotent(client_as_user_a):
    r1 = await client_as_user_a.post("/tags", json={"name": "dup"})
    r2 = await client_as_user_a.post("/tags", json={"name": "dup"})
    assert r1.status_code == 201
    # Second call returns 200 (existing) — router returns the existing row.
    assert r2.status_code in (200, 201)
    assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_create_tag_rejects_empty_name(client_as_user_a):
    r = await client_as_user_a.post("/tags", json={"name": "   "})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_list_tags_scoped_to_caller(
    client_as_user_a, db_conn, seeded_users,
):
    """A's list shows A's tags, never B's."""
    await client_as_user_a.post("/tags", json={"name": "a-tag"})
    await db_conn.execute(
        "INSERT INTO tags (user_id, name) VALUES ($1, 'b-tag')",
        USER_B_ID,
    )

    r = await client_as_user_a.get("/tags")
    assert r.status_code == 200
    names = [t["name"] for t in r.json()]
    assert "a-tag" in names
    assert "b-tag" not in names


@pytest.mark.asyncio
async def test_delete_tag_removes_row(client_as_user_a, db_conn):
    r_create = await client_as_user_a.post("/tags", json={"name": "gone"})
    tag_id = r_create.json()["id"]

    r_del = await client_as_user_a.delete(f"/tags/{tag_id}")
    assert r_del.status_code == 204

    gone = await db_conn.fetchval("SELECT COUNT(*) FROM tags WHERE id = $1", tag_id)
    assert gone == 0


@pytest.mark.asyncio
async def test_delete_missing_tag_returns_404(client_as_user_a):
    r = await client_as_user_a.delete(f"/tags/{uuid.uuid4()}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_cross_user_tag_returns_404(
    client_as_user_a, db_conn,
):
    """B owns a tag; A trying to delete it via its ID must 404."""
    row = await db_conn.fetchrow(
        "INSERT INTO tags (user_id, name) VALUES ($1, 'b-secret') RETURNING id",
        USER_B_ID,
    )
    b_tag_id = str(row["id"])
    r = await client_as_user_a.delete(f"/tags/{b_tag_id}")
    assert r.status_code == 404

    still = await db_conn.fetchval("SELECT COUNT(*) FROM tags WHERE id = $1", b_tag_id)
    assert still == 1


@pytest.mark.asyncio
async def test_assign_tag_attaches_to_own_paper(
    client_as_user_a, seeded_users, db_conn,
):
    r = await client_as_user_a.post("/tags/assign", json={
        "paper_id": seeded_users["paper_a"],
        "tag_name": "important",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["paper_id"] == seeded_users["paper_a"]
    assert body["tag_name"] == "important"

    # Row exists in paper_tags.
    count = await db_conn.fetchval(
        """SELECT COUNT(*) FROM paper_tags pt
           JOIN tags t ON pt.tag_id = t.id
           WHERE pt.paper_id = $1 AND t.name = 'important' AND t.user_id = $2""",
        seeded_users["paper_a"], USER_A_ID,
    )
    assert count == 1


@pytest.mark.asyncio
async def test_assign_tag_rejects_foreign_paper(
    client_as_user_a, seeded_users,
):
    """Phase 2 fix: assigning a tag to a paper NOT owned by caller must 404."""
    r = await client_as_user_a.post("/tags/assign", json={
        "paper_id": seeded_users["paper_b"],
        "tag_name": "attempt",
    })
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_assign_tag_rejects_empty_name(client_as_user_a, seeded_users):
    r = await client_as_user_a.post("/tags/assign", json={
        "paper_id": seeded_users["paper_a"],
        "tag_name": "  ",
    })
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_get_paper_tags_returns_assigned(
    client_as_user_a, seeded_users,
):
    await client_as_user_a.post("/tags/assign", json={
        "paper_id": seeded_users["paper_a"],
        "tag_name": "survey",
    })
    r = await client_as_user_a.get(f"/tags/paper/{seeded_users['paper_a']}")
    assert r.status_code == 200
    names = [t["name"] for t in r.json()]
    assert "survey" in names


@pytest.mark.asyncio
async def test_unassign_tag_removes_association(
    client_as_user_a, seeded_users, db_conn,
):
    r_assign = await client_as_user_a.post("/tags/assign", json={
        "paper_id": seeded_users["paper_a"],
        "tag_name": "remove-me",
    })
    tag_id = r_assign.json()["tag_id"]

    r = await client_as_user_a.delete(
        f"/tags/assign/{seeded_users['paper_a']}/{tag_id}"
    )
    assert r.status_code == 204

    count = await db_conn.fetchval(
        "SELECT COUNT(*) FROM paper_tags WHERE paper_id = $1 AND tag_id = $2",
        seeded_users["paper_a"], tag_id,
    )
    assert count == 0
