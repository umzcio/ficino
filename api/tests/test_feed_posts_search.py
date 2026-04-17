"""Tests for the feed_posts search index (2.19 / 2.20).

Verifies the normalized search path:
- Matches posts the user owns
- Excludes posts owned by other users (ownership via feeds.user_id JOIN)
- Excludes soft-deleted posts
- Returns empty for queries that don't match anything
"""
from __future__ import annotations

import json
import uuid

import pytest

from tests.conftest import USER_A_ID, USER_B_ID


@pytest.mark.asyncio
async def test_search_posts_finds_own_content(
    client_as_user_a, seeded_users, db_conn,
):
    """A user can find their own posts by content via the normalized search."""
    feed_id = seeded_users["feed_a"]
    # Seed feed_posts directly — the writer path is exercised in the worker,
    # but here we just need rows to search. Matches what the worker + backfill
    # would produce.
    await db_conn.execute(
        """INSERT INTO feed_posts
           (feed_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
           VALUES ($1, 0, 'unique search term aardvark for testing', 'skeptic', 'post', 'methods', 'Test 2024', '{}'::jsonb, false)
           ON CONFLICT (feed_id, post_index) DO UPDATE SET content_text = EXCLUDED.content_text, deleted = false""",
        feed_id,
    )
    try:
        r = await client_as_user_a.get("/search?q=aardvark")
        assert r.status_code == 200
        body = r.json()
        assert any(
            p["feed_id"] == feed_id and p["post_index"] == 0
            for p in body.get("posts", [])
        ), f"Expected own post in results; got {body.get('posts')}"
    finally:
        await db_conn.execute(
            "DELETE FROM feed_posts WHERE feed_id = $1 AND post_index = 0",
            feed_id,
        )


@pytest.mark.asyncio
async def test_search_posts_excludes_other_users(
    client_as_user_a, seeded_users, db_conn,
):
    """User A cannot find user B's posts even with a matching query."""
    feed_b = seeded_users["feed_b"]
    await db_conn.execute(
        """INSERT INTO feed_posts
           (feed_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
           VALUES ($1, 0, 'user B secret quokka content', 'hype', 'post', 'findings', 'BPaper 2024', '{}'::jsonb, false)
           ON CONFLICT (feed_id, post_index) DO UPDATE SET content_text = EXCLUDED.content_text, deleted = false""",
        feed_b,
    )
    try:
        r = await client_as_user_a.get("/search?q=quokka")
        assert r.status_code == 200
        body = r.json()
        assert not any(
            p["feed_id"] == feed_b for p in body.get("posts", [])
        ), "IDOR: user A got a post from user B's feed"
    finally:
        await db_conn.execute(
            "DELETE FROM feed_posts WHERE feed_id = $1 AND post_index = 0",
            feed_b,
        )


@pytest.mark.asyncio
async def test_search_posts_skips_soft_deleted(
    client_as_user_a, seeded_users, db_conn,
):
    """Soft-deleted posts are omitted from search results."""
    feed_id = seeded_users["feed_a"]
    await db_conn.execute(
        """INSERT INTO feed_posts
           (feed_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
           VALUES ($1, 0, 'deleted platypus content should not appear', 'skeptic', 'post', 'methods', 'Test 2024', '{}'::jsonb, true)
           ON CONFLICT (feed_id, post_index) DO UPDATE SET content_text = EXCLUDED.content_text, deleted = true""",
        feed_id,
    )
    try:
        r = await client_as_user_a.get("/search?q=platypus")
        assert r.status_code == 200
        body = r.json()
        assert not any(
            p["feed_id"] == feed_id for p in body.get("posts", [])
        ), "Soft-deleted post surfaced in search results"
    finally:
        await db_conn.execute(
            "DELETE FROM feed_posts WHERE feed_id = $1 AND post_index = 0",
            feed_id,
        )


@pytest.mark.asyncio
async def test_search_posts_empty_query_returns_empty(
    client_as_user_a, seeded_users,
):
    """A query with no matches returns an empty posts list (not an error)."""
    r = await client_as_user_a.get(f"/search?q={uuid.uuid4()}-definitely-no-match")
    assert r.status_code == 200
    assert r.json().get("posts") == []


@pytest.mark.asyncio
async def test_search_posts_result_shape(
    client_as_user_a, seeded_users, db_conn,
):
    """Returned post rows carry the expected fields."""
    feed_id = seeded_users["feed_a"]
    await db_conn.execute(
        """INSERT INTO feed_posts
           (feed_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
           VALUES ($1, 0, 'shape test narwhal content here', 'methodologist', 'thread', 'methods', 'ShapeTest 2024', '{}'::jsonb, false)
           ON CONFLICT (feed_id, post_index) DO UPDATE SET content_text = EXCLUDED.content_text, deleted = false""",
        feed_id,
    )
    try:
        r = await client_as_user_a.get("/search?q=narwhal")
        assert r.status_code == 200
        posts = r.json().get("posts", [])
        assert posts, "Expected at least one result"
        p = next((x for x in posts if x["feed_id"] == feed_id), None)
        assert p is not None
        assert p["persona"] == "methodologist"
        assert p["post_type"] == "thread"
        assert p["paper_ref"] == "ShapeTest 2024"
        assert "narwhal" in p["content"].lower()
        # New path includes a rank field
        assert "rank" in p
        assert isinstance(p["rank"], (int, float))
    finally:
        await db_conn.execute(
            "DELETE FROM feed_posts WHERE feed_id = $1 AND post_index = 0",
            feed_id,
        )
