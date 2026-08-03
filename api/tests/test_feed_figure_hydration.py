"""Plan 019: figure URLs are re-signed fresh inside the authenticated feed GET.

The persisted `figure_url` in feed-post JSONB is only a short-lived
fallback (1h TTL) — `_hydrate_figure_urls` overwrites it with a fresh
600s signed URL on every `GET /feed/{id}`, with ownership enforced by a
figures⨯papers JOIN. Structural pattern mirrors the `_hydrate_audio_urls`
tests in test_hydration_offloop.py.
"""
from __future__ import annotations

import json
import uuid

import asyncpg
import pytest
import pytest_asyncio

import storage as storage_module

STALE_URL = "https://stale.example/persisted-30-day-token"
FRESH_URL = "https://signed.example/fresh-600s"


async def _insert_figure(
    db_conn: asyncpg.Connection, paper_id: str, image_path: str
) -> str:
    figure_id = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO figures (id, paper_id, page_number, image_path,
                                extraction_type, description, claim_summary,
                                figure_index)
           VALUES ($1, $2, 1, $3, 'image', 'desc', 'claim', 0)""",
        figure_id, paper_id, image_path,
    )
    return figure_id


async def _set_feed_posts(
    db_conn: asyncpg.Connection, feed_id: str, posts: list[dict]
) -> None:
    await db_conn.execute(
        "UPDATE feeds SET posts = $2, post_count = $3 WHERE id = $1",
        feed_id, json.dumps(posts), len(posts),
    )


@pytest_asyncio.fixture
async def seeded_figure_feed(db_conn: asyncpg.Connection, seeded_users):
    """User A's feed with one figure post pointing at a figure owned by
    user A's paper, carrying a stale persisted figure_url."""
    figure_id = await _insert_figure(
        db_conn, seeded_users["paper_a"], "usera/fig.png"
    )
    posts = [
        {
            "persona": "skeptic",
            "post_type": "figure",
            "content": "figure hydration test post",
            "figure_id": figure_id,
            "figure_url": STALE_URL,
        }
    ]
    await _set_feed_posts(db_conn, seeded_users["feed_a"], posts)
    yield {"feed_id": seeded_users["feed_a"], "figure_id": figure_id}
    await db_conn.execute("DELETE FROM figures WHERE id = $1", figure_id)


@pytest.mark.asyncio
async def test_figure_url_resigned_on_feed_get(
    client_as_user_a, seeded_figure_feed, monkeypatch
):
    """A figure post comes back with figure_url re-signed: the signing
    call receives ttl=600 and the image_path resolved from the DB."""
    calls = []

    def _fake_sign(user_id, paper_id, figure_id, image_path, ttl=600):
        calls.append(
            {
                "user_id": user_id,
                "paper_id": paper_id,
                "figure_id": figure_id,
                "image_path": image_path,
                "ttl": ttl,
            }
        )
        return FRESH_URL

    monkeypatch.setattr(
        storage_module.storage, "figure_image_url", _fake_sign
    )
    r = await client_as_user_a.get(f"/feed/{seeded_figure_feed['feed_id']}")
    assert r.status_code == 200, r.text
    posts = r.json()["posts"]
    assert posts[0]["figure_url"] == FRESH_URL

    assert len(calls) == 1
    assert calls[0]["figure_id"] == seeded_figure_feed["figure_id"]
    assert calls[0]["image_path"] == "usera/fig.png"
    assert calls[0]["ttl"] == 600


@pytest.mark.asyncio
async def test_other_users_figure_not_resigned(
    client_as_user_a, db_conn, seeded_users, monkeypatch
):
    """A figure_id pointing at a DIFFERENT user's paper is filtered by the
    ownership JOIN: no signing call, persisted URL left in place."""
    foreign_figure_id = await _insert_figure(
        db_conn, seeded_users["paper_b"], "userb/fig.png"
    )
    posts = [
        {
            "persona": "skeptic",
            "post_type": "figure",
            "content": "cross-tenant figure post",
            "figure_id": foreign_figure_id,
            "figure_url": STALE_URL,
        }
    ]
    await _set_feed_posts(db_conn, seeded_users["feed_a"], posts)

    calls = []

    def _fake_sign(*a, **k):
        calls.append((a, k))
        return FRESH_URL

    monkeypatch.setattr(
        storage_module.storage, "figure_image_url", _fake_sign
    )
    try:
        r = await client_as_user_a.get(f"/feed/{seeded_users['feed_a']}")
        assert r.status_code == 200, r.text
        assert r.json()["posts"][0]["figure_url"] == STALE_URL
        assert calls == []
    finally:
        await db_conn.execute(
            "DELETE FROM figures WHERE id = $1", foreign_figure_id
        )


@pytest.mark.asyncio
async def test_storage_error_keeps_persisted_url(
    client_as_user_a, seeded_figure_feed, monkeypatch
):
    """A storage-backend exception fails soft: the persisted URL stays and
    the GET still returns 200."""

    def _boom(*a, **k):
        raise RuntimeError("storage backend down")

    monkeypatch.setattr(storage_module.storage, "figure_image_url", _boom)
    r = await client_as_user_a.get(f"/feed/{seeded_figure_feed['feed_id']}")
    assert r.status_code == 200, r.text
    assert r.json()["posts"][0]["figure_url"] == STALE_URL


@pytest.mark.asyncio
async def test_no_figure_posts_no_signing(
    client_as_user_a, db_conn, seeded_users, monkeypatch
):
    """A feed with no figure posts takes the early return — the storage
    backend is never touched."""
    await _set_feed_posts(
        db_conn,
        seeded_users["feed_a"],
        [{"persona": "skeptic", "post_type": "post", "content": "plain"}],
    )

    def _boom(*a, **k):
        raise AssertionError("figure_image_url called for a figure-less feed")

    monkeypatch.setattr(storage_module.storage, "figure_image_url", _boom)
    r = await client_as_user_a.get(f"/feed/{seeded_users['feed_a']}")
    assert r.status_code == 200, r.text
