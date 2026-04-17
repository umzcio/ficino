"""IDOR follow-up tests for Phase 2 ownership checks.

These endpoints were patched in Phase 2 to verify caller ownership of nested
resources (e.g. the paper_id in POST /tags/assign, or the corpus_id / paper_ids
in POST /reading-lists). This file is net-new coverage — not a regression suite.

Like `test_auth_scoping.py::test_list_papers_returns_only_own_papers`, the
two-client cases swap `app.dependency_overrides[get_current_user]` inline
rather than using both `client_as_user_a` and `client_as_user_b` fixtures in
one test — since the dependency override dict is a singleton, using both
fixtures at once races.
"""
from __future__ import annotations

import uuid

import httpx
import pytest

from tests.conftest import USER_A_ID, USER_B_ID


# Minimal valid PDF: "%PDF-" magic bytes + trailer. The upload handler only
# checks the magic bytes, so this passes the 2.18 validation without needing
# a real PDF.
_FAKE_PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n"


def _swap_to(user_id: str, email: str, display: str) -> None:
    """Swap the FastAPI dep override to spoof `user_id`."""
    from main import app
    from auth import get_current_user
    from auth.models import AuthUser
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=user_id, email=email, display_name=display
    )


def _clear_override() -> None:
    from main import app
    from auth import get_current_user
    app.dependency_overrides.pop(get_current_user, None)


# ---------- POST /tags/assign ----------

@pytest.mark.asyncio
async def test_assign_tag_rejects_cross_user_paper(seeded_users):
    """User B tries to tag user A's paper. Endpoint must 404 before even
    looking at the tag ownership (which is B's own tag)."""
    from main import app

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            # First, user B creates a tag of their own.
            _swap_to(USER_B_ID, "auth-test-b@ficino.dev", "B")
            r_create = await client.post("/tags", json={"name": "interesting"})
            assert r_create.status_code in (200, 201), r_create.text

            # Now user B (still) tries to assign their own tag to user A's paper.
            r = await client.post("/tags/assign", json={
                "paper_id": seeded_users["paper_a"],
                "tag_name": "interesting",
            })
            assert r.status_code == 404, (
                f"IDOR: B got {r.status_code} tagging A's paper. Body: {r.text[:200]}"
            )
    finally:
        _clear_override()


# ---------- POST /papers (upload into another user's workspace) ----------

@pytest.mark.asyncio
async def test_upload_paper_rejects_cross_user_workspace(
    client_as_user_b, seeded_users
):
    """User B uploads a valid PDF but targets user A's workspace_id.
    Must 404 — uploading into a foreign workspace is a cross-tenant write."""
    r = await client_as_user_b.post(
        f"/papers?workspace_id={seeded_users['workspace_a']}",
        files={"file": ("test.pdf", _FAKE_PDF, "application/pdf")},
    )
    assert r.status_code == 404, (
        f"IDOR: B got {r.status_code} uploading to A's workspace. "
        f"Body: {r.text[:200]}"
    )


# ---------- POST /reading-lists ----------

@pytest.mark.asyncio
async def test_create_reading_list_rejects_cross_user_paper_ids(
    client_as_user_b, seeded_users, db_conn
):
    """User B tries to create a reading list containing user A's paper id.
    Even if B supplies a second owned paper, the mixed list must 404."""
    # Give B a second paper so len(paper_ids) >= 2 (the min-2 check is also 400,
    # but we want to hit the ownership check, not the length check).
    second_b_paper = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
           VALUES ($1, $2, $3, 'b2.pdf', '/tmp/b2.pdf', 'complete')""",
        second_b_paper, USER_B_ID, seeded_users["workspace_b"],
    )

    r = await client_as_user_b.post("/reading-lists", json={
        "name": "sneaky",
        "paper_ids": [seeded_users["paper_a"], second_b_paper],
    })
    assert r.status_code == 404, (
        f"IDOR: B got {r.status_code} including A's paper in their list. "
        f"Body: {r.text[:200]}"
    )


@pytest.mark.asyncio
async def test_create_reading_list_rejects_cross_user_corpus_id(
    client_as_user_b, seeded_users
):
    """User B tries to create a reading list whose corpus_id belongs to A.
    Must 404 — B has no right to read A's corpus."""
    r = await client_as_user_b.post("/reading-lists", json={
        "name": "sneaky-corpus",
        "corpus_id": seeded_users["workspace_a"],
    })
    assert r.status_code == 404, (
        f"IDOR: B got {r.status_code} using A's corpus. Body: {r.text[:200]}"
    )


# ---------- PUT /reading-lists/{id}/apply-ordering (injection) ----------

@pytest.mark.asyncio
async def test_apply_ordering_rejects_foreign_paper_injection(
    client_as_user_a, seeded_users, db_conn
):
    """User A has a reading list of A's two papers. A then calls apply-ordering
    with a paper_id that is NOT in the list. Must 400 — ordering must be a
    permutation of the existing sequence."""
    # Seed a second paper for A so we have a real 2-paper reading list.
    paper_a2 = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
           VALUES ($1, $2, $3, 'a2.pdf', '/tmp/a2.pdf', 'complete')""",
        paper_a2, USER_A_ID, seeded_users["workspace_a"],
    )

    # Seed the reading list + its chapters directly (the POST path would
    # dispatch a Celery task, which we're explicitly avoiding).
    list_id = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO reading_lists (id, user_id, corpus_id, name, paper_sequence)
           VALUES ($1, $2, $3, $4, $5::uuid[])""",
        list_id, USER_A_ID, seeded_users["workspace_a"], "A-list",
        [seeded_users["paper_a"], paper_a2],
    )

    # Inject a bogus paper_id (not in the list's paper_sequence).
    foreign_id = str(uuid.uuid4())
    r = await client_as_user_a.put(
        f"/reading-lists/{list_id}/apply-ordering",
        json={"ordered_papers": [
            {"paper_id": seeded_users["paper_a"]},
            {"paper_id": foreign_id},
        ]},
    )
    assert r.status_code == 400
    assert "permutation" in r.text.lower()


@pytest.mark.asyncio
async def test_apply_ordering_accepts_valid_permutation(
    client_as_user_a, seeded_users, db_conn
):
    """Positive control: a valid permutation of the existing papers is accepted.
    Keeps the negative test above honest."""
    paper_a2 = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
           VALUES ($1, $2, $3, 'a2.pdf', '/tmp/a2.pdf', 'complete')""",
        paper_a2, USER_A_ID, seeded_users["workspace_a"],
    )
    list_id = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO reading_lists (id, user_id, corpus_id, name, paper_sequence)
           VALUES ($1, $2, $3, $4, $5::uuid[])""",
        list_id, USER_A_ID, seeded_users["workspace_a"], "A-list",
        [seeded_users["paper_a"], paper_a2],
    )

    r = await client_as_user_a.put(
        f"/reading-lists/{list_id}/apply-ordering",
        json={"ordered_papers": [
            {"paper_id": paper_a2},
            {"paper_id": seeded_users["paper_a"]},
        ]},
    )
    assert r.status_code == 200, r.text
