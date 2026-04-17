"""Tests for /reading-lists endpoints.

Most of the POST path dispatches a Celery task (`propose_ordering`) that we
can't run here without a worker, so we seed the reading_lists row directly
via `db_conn` and exercise the READ / REORDER / APPLY-ORDERING / DELETE paths.

Covers:
  - GET /reading-lists returns the caller's reading lists only.
  - GET /reading-lists/{id} for another user's list returns 404.
  - GET /reading-lists?workspace_id=... scopes by corpus.
  - PUT /reading-lists/{id}/reorder updates the paper_sequence column.
  - PUT /reading-lists/{id}/reorder for a foreign list returns 404.
  - PUT /reading-lists/{id}/apply-ordering rejects foreign paper IDs (400).
  - PUT /reading-lists/{id}/apply-ordering applies a valid permutation.
  - DELETE /reading-lists/{id} removes the list; foreign delete returns 404.

Not covered (skipped / needs Celery stub):
  - POST /reading-lists (dispatches propose_ordering).
  - POST /reading-lists/{id}/chapters/{i}/generate (dispatches generate_chapter).
"""
from __future__ import annotations

import uuid

import pytest

from tests.conftest import USER_A_ID, USER_B_ID


async def _seed_reading_list(db_conn, user_id, corpus_id, paper_ids, name="L"):
    """Insert a reading list + one chapter per paper; return the new list_id."""
    list_id = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO reading_lists (id, user_id, corpus_id, name, paper_sequence)
           VALUES ($1, $2, $3, $4, $5::uuid[])""",
        list_id, user_id, corpus_id, name, paper_ids,
    )
    for i, pid in enumerate(paper_ids):
        await db_conn.execute(
            """INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
               VALUES ($1, $2, $3::uuid[], $4)""",
            list_id, i, [pid], "unlocked" if i == 0 else "locked",
        )
    return list_id


async def _seed_second_paper(db_conn, user_id, corpus_id, name="a2.pdf"):
    pid = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
           VALUES ($1, $2, $3, $4, $5, 'complete')""",
        pid, user_id, corpus_id, name, f"/tmp/{name}",
    )
    return pid


@pytest.mark.asyncio
async def test_list_reading_lists_scoped_to_caller(
    client_as_user_a, seeded_users, db_conn,
):
    """A and B each have reading lists seeded directly in the DB; A's GET
    returns only A's list, never B's (IDOR check).

    Using only client_as_user_a because `app.dependency_overrides[get_current_user]`
    is a shared singleton — pulling both client fixtures into one test races
    (see the comment in test_idor_followups.py).
    """
    paper_a2 = await _seed_second_paper(db_conn, USER_A_ID, seeded_users["workspace_a"])
    paper_b2 = await _seed_second_paper(db_conn, USER_B_ID, seeded_users["workspace_b"], "b2.pdf")
    a_list = await _seed_reading_list(
        db_conn, USER_A_ID, seeded_users["workspace_a"],
        [seeded_users["paper_a"], paper_a2], name="A-list",
    )
    b_list = await _seed_reading_list(
        db_conn, USER_B_ID, seeded_users["workspace_b"],
        [seeded_users["paper_b"], paper_b2], name="B-list",
    )

    r = await client_as_user_a.get("/reading-lists")
    assert r.status_code == 200
    ids = {rl["id"] for rl in r.json()}
    assert a_list in ids
    assert b_list not in ids


@pytest.mark.asyncio
async def test_get_reading_list_rejects_cross_user(
    client_as_user_a, seeded_users, db_conn,
):
    paper_b2 = await _seed_second_paper(
        db_conn, USER_B_ID, seeded_users["workspace_b"], "b2.pdf"
    )
    b_list = await _seed_reading_list(
        db_conn, USER_B_ID, seeded_users["workspace_b"],
        [seeded_users["paper_b"], paper_b2], name="B-list",
    )
    r = await client_as_user_a.get(f"/reading-lists/{b_list}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_list_reading_lists_filter_by_workspace(
    client_as_user_a, seeded_users, db_conn,
):
    """?workspace_id= narrows to that corpus only."""
    # Second A workspace.
    second_ws = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO corpora (id, user_id, name) VALUES ($1, $2, 'Second')",
        second_ws, USER_A_ID,
    )
    paper_a2 = await _seed_second_paper(db_conn, USER_A_ID, seeded_users["workspace_a"])
    paper_a3 = await _seed_second_paper(db_conn, USER_A_ID, second_ws, "a3.pdf")
    paper_a4 = await _seed_second_paper(db_conn, USER_A_ID, second_ws, "a4.pdf")

    list_in_ws_a = await _seed_reading_list(
        db_conn, USER_A_ID, seeded_users["workspace_a"],
        [seeded_users["paper_a"], paper_a2], name="in-ws-a",
    )
    list_in_second = await _seed_reading_list(
        db_conn, USER_A_ID, second_ws, [paper_a3, paper_a4], name="in-second",
    )

    r = await client_as_user_a.get(
        f"/reading-lists?workspace_id={seeded_users['workspace_a']}"
    )
    assert r.status_code == 200
    ids = {rl["id"] for rl in r.json()}
    assert list_in_ws_a in ids
    assert list_in_second not in ids


@pytest.mark.asyncio
async def test_reorder_updates_paper_sequence(
    client_as_user_a, seeded_users, db_conn,
):
    paper_a2 = await _seed_second_paper(db_conn, USER_A_ID, seeded_users["workspace_a"])
    list_id = await _seed_reading_list(
        db_conn, USER_A_ID, seeded_users["workspace_a"],
        [seeded_users["paper_a"], paper_a2], name="reorder",
    )

    reversed_seq = [paper_a2, seeded_users["paper_a"]]
    r = await client_as_user_a.put(
        f"/reading-lists/{list_id}/reorder",
        json={"paper_sequence": reversed_seq},
    )
    assert r.status_code == 200

    seq = await db_conn.fetchval(
        "SELECT paper_sequence FROM reading_lists WHERE id = $1", list_id,
    )
    assert [str(x) for x in seq] == reversed_seq


@pytest.mark.asyncio
async def test_reorder_cross_user_returns_404(
    client_as_user_a, seeded_users, db_conn,
):
    """A cannot reorder B's reading list."""
    paper_b2 = await _seed_second_paper(
        db_conn, USER_B_ID, seeded_users["workspace_b"], "b2.pdf"
    )
    b_list = await _seed_reading_list(
        db_conn, USER_B_ID, seeded_users["workspace_b"],
        [seeded_users["paper_b"], paper_b2], name="B-list",
    )
    r = await client_as_user_a.put(
        f"/reading-lists/{b_list}/reorder",
        json={"paper_sequence": [seeded_users["paper_b"], paper_b2]},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_apply_ordering_rejects_foreign_paper(
    client_as_user_a, seeded_users, db_conn,
):
    """Phase 2 permutation check: the new sequence MUST be a permutation of
    the list's existing paper_sequence. Injecting a foreign paper id → 400."""
    paper_a2 = await _seed_second_paper(db_conn, USER_A_ID, seeded_users["workspace_a"])
    list_id = await _seed_reading_list(
        db_conn, USER_A_ID, seeded_users["workspace_a"],
        [seeded_users["paper_a"], paper_a2], name="order",
    )

    foreign = str(uuid.uuid4())
    r = await client_as_user_a.put(
        f"/reading-lists/{list_id}/apply-ordering",
        json={"ordered_papers": [
            {"paper_id": seeded_users["paper_a"]},
            {"paper_id": foreign},
        ]},
    )
    assert r.status_code == 400
    assert "permutation" in r.text.lower()


@pytest.mark.asyncio
async def test_apply_ordering_applies_valid_permutation(
    client_as_user_a, seeded_users, db_conn,
):
    paper_a2 = await _seed_second_paper(db_conn, USER_A_ID, seeded_users["workspace_a"])
    list_id = await _seed_reading_list(
        db_conn, USER_A_ID, seeded_users["workspace_a"],
        [seeded_users["paper_a"], paper_a2], name="order",
    )

    r = await client_as_user_a.put(
        f"/reading-lists/{list_id}/apply-ordering",
        json={"ordered_papers": [
            {"paper_id": paper_a2},
            {"paper_id": seeded_users["paper_a"]},
        ]},
    )
    assert r.status_code == 200

    seq = await db_conn.fetchval(
        "SELECT paper_sequence FROM reading_lists WHERE id = $1", list_id,
    )
    assert [str(x) for x in seq] == [paper_a2, seeded_users["paper_a"]]


@pytest.mark.asyncio
async def test_delete_reading_list_removes_row(
    client_as_user_a, seeded_users, db_conn,
):
    paper_a2 = await _seed_second_paper(db_conn, USER_A_ID, seeded_users["workspace_a"])
    list_id = await _seed_reading_list(
        db_conn, USER_A_ID, seeded_users["workspace_a"],
        [seeded_users["paper_a"], paper_a2], name="del",
    )
    r = await client_as_user_a.delete(f"/reading-lists/{list_id}")
    assert r.status_code == 204

    gone = await db_conn.fetchval(
        "SELECT COUNT(*) FROM reading_lists WHERE id = $1", list_id,
    )
    assert gone == 0


@pytest.mark.asyncio
async def test_delete_reading_list_cross_user_returns_404(
    client_as_user_a, seeded_users, db_conn,
):
    paper_b2 = await _seed_second_paper(
        db_conn, USER_B_ID, seeded_users["workspace_b"], "b2.pdf"
    )
    b_list = await _seed_reading_list(
        db_conn, USER_B_ID, seeded_users["workspace_b"],
        [seeded_users["paper_b"], paper_b2], name="B-list",
    )
    r = await client_as_user_a.delete(f"/reading-lists/{b_list}")
    assert r.status_code == 404
