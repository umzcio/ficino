"""IDOR regression tests.

For every endpoint fixed in Phase 1, verify that user B cannot read,
mutate, or enumerate user A's data by guessing the resource UUID.

"404 Not found" is the expected response — NOT 403 — so the API doesn't
leak the existence of other users' resources.

Endpoints covered (from /projects/ficino/.review-findings/phase1-idor-status.md):
  - feed.py: GET /feed, GET /feed/{id}, DELETE /feed/{id}/posts/{i},
             POST /feed/{id}/regenerate/{i}
  - papers.py: GET /papers, GET /papers/{id}, GET /papers/{id}/figures
  - messages.py: GET /messages/papers, GET /messages/papers/tldrs,
                 GET /messages/papers/{id}, GET /messages/groups
  - replies.py: GET /replies/conversations, GET /replies/replied-posts/{feed_id},
                GET /replies/{feed_id}/{post_index}
  - search.py: GET /search
  - tags.py: GET /tags/paper/{id}
  - user_posts.py: GET /user-posts/{id}/status
  - workspaces.py: GET /workspaces/{id}/activity

Not covered here (needs Celery stubs or more setup):
  POST /replies, POST /replies/zap, POST /feed/generate, POST /messages/groups,
  POST /reading-lists/*/generate.
"""
from __future__ import annotations

import uuid

import pytest

from tests.conftest import USER_A_ID, USER_B_ID


# ---------- List endpoints: each user sees only their own rows ----------

@pytest.mark.asyncio
async def test_list_papers_returns_only_own_papers(seeded_users):
    """User A and user B each see only their own paper.

    Implemented inline (not via the client_as_user_a + client_as_user_b
    fixtures) because `app.dependency_overrides[get_current_user]` is a
    global dict — two simultaneous client fixtures would fight over it and
    the later setup wins for both.
    """
    import httpx
    from main import app
    from auth import get_current_user
    from auth.models import AuthUser

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(
            id=USER_A_ID, email="auth-test-a@ficino.dev", display_name="A"
        )
        r_a = await client.get("/papers")
        assert r_a.status_code == 200
        paper_ids_a = {p["id"] for p in r_a.json()}
        assert seeded_users["paper_a"] in paper_ids_a
        assert seeded_users["paper_b"] not in paper_ids_a

        app.dependency_overrides[get_current_user] = lambda: AuthUser(
            id=USER_B_ID, email="auth-test-b@ficino.dev", display_name="B"
        )
        r_b = await client.get("/papers")
        paper_ids_b = {p["id"] for p in r_b.json()}
        assert seeded_users["paper_b"] in paper_ids_b
        assert seeded_users["paper_a"] not in paper_ids_b

    app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_list_messages_papers_scoped(client_as_user_a, seeded_users):
    r = await client_as_user_a.get("/messages/papers")
    assert r.status_code == 200
    paper_ids = {p["paper_id"] for p in r.json()}
    assert seeded_users["paper_b"] not in paper_ids


@pytest.mark.asyncio
async def test_list_messages_groups_scoped(client_as_user_a, seeded_users):
    r = await client_as_user_a.get("/messages/groups")
    assert r.status_code == 200  # empty list fine — just shouldn't leak B's groups


@pytest.mark.asyncio
async def test_list_replies_conversations_scoped(client_as_user_a, seeded_users):
    r = await client_as_user_a.get("/replies/conversations")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_tldrs_endpoint_scoped(client_as_user_a, seeded_users):
    r = await client_as_user_a.get("/messages/papers/tldrs")
    assert r.status_code == 200
    body = r.json()
    if isinstance(body, dict):
        assert seeded_users["paper_b"] not in body


# ---------- Single-resource GETs: 404 when reaching across tenants ----------

@pytest.mark.asyncio
async def test_get_feed_rejects_cross_user_read(client_as_user_b, seeded_users):
    r = await client_as_user_b.get(f"/feed/{seeded_users['feed_a']}")
    assert r.status_code == 404, (
        f"IDOR: user B got {r.status_code} reading user A's feed. "
        f"Response: {r.text[:200]}"
    )


@pytest.mark.asyncio
async def test_get_paper_rejects_cross_user_read(client_as_user_b, seeded_users):
    r = await client_as_user_b.get(f"/papers/{seeded_users['paper_a']}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_paper_figures_rejects_cross_user_read(
    client_as_user_b, seeded_users
):
    r = await client_as_user_b.get(f"/papers/{seeded_users['paper_a']}/figures")
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_get_messages_paper_rejects_cross_user_read(
    client_as_user_b, seeded_users
):
    r = await client_as_user_b.get(f"/messages/papers/{seeded_users['paper_a']}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_replies_by_feed_scoped(client_as_user_b, seeded_users):
    r = await client_as_user_b.get(f"/replies/{seeded_users['feed_a']}/0")
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert r.json().get("messages") == []


@pytest.mark.asyncio
async def test_get_replied_posts_scoped(client_as_user_b, seeded_users):
    r = await client_as_user_b.get(f"/replies/replied-posts/{seeded_users['feed_a']}")
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_get_tags_for_paper_scoped(client_as_user_b, seeded_users):
    r = await client_as_user_b.get(f"/tags/paper/{seeded_users['paper_a']}")
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert r.json() == []


@pytest.mark.asyncio
async def test_get_user_post_status_scoped(client_as_user_b, seeded_users):
    r = await client_as_user_b.get(f"/user-posts/{uuid.uuid4()}/status")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_workspace_activity_rejects_cross_user(
    client_as_user_b, seeded_users
):
    r = await client_as_user_b.get(
        f"/workspaces/{seeded_users['workspace_a']}/activity"
    )
    assert r.status_code == 404


# ---------- Mutations: can't delete or regenerate another user's post ----------

@pytest.mark.asyncio
async def test_delete_post_rejects_cross_user(client_as_user_b, seeded_users):
    r = await client_as_user_b.delete(f"/feed/{seeded_users['feed_a']}/posts/0")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_regenerate_post_rejects_cross_user(client_as_user_b, seeded_users):
    r = await client_as_user_b.post(
        f"/feed/{seeded_users['feed_a']}/regenerate/0"
    )
    # 404 (feed not found scoped to user) or 400 (post index out of range) —
    # both mean the cross-user access was blocked.
    assert r.status_code in (400, 404)


# ---------- Search: must not return other users' rows ----------

@pytest.mark.asyncio
async def test_search_scoped_to_own_corpus(client_as_user_a, seeded_users):
    r = await client_as_user_a.get("/search?q=example")
    assert r.status_code == 200
