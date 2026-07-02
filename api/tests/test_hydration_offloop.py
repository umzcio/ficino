"""R10 API-3: signed-URL hydration must run off the event loop.

Covers all three call sites cited in review/round10/api.md API-3:
  - feed.py `_hydrate_audio_urls` (per-post audio_key -> signed URL)
  - feed.py `_hydrate_podcast_episode_url` (episode mp3 -> signed URL)
  - papers.py `list_figures`'s per-row image_url loop

Each fake storage method asserts it is NOT running on the event loop
(detected via `asyncio.get_running_loop()` succeeding) — proof that the
storage call was actually offloaded to a worker thread via
`asyncio.to_thread`, not just wrapped in something that looks async.
"""
from __future__ import annotations

import json
import uuid

import asyncpg
import pytest
import pytest_asyncio

import storage as storage_module


def _fake_signed_url(*a, **k):
    """Returns a fixed URL when off-loop; blows up if called ON the loop."""
    import asyncio
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return "https://signed.example/ok"
    raise AssertionError("storage URL call ran ON the event loop (R10 API-3)")


@pytest_asyncio.fixture
async def seeded_audio_feed(db_conn: asyncpg.Connection, seeded_users):
    """User A's feed, patched to look like a ready audio+podcast feed with
    one post carrying an audio_key — the shape `_hydrate_audio_urls` and
    `_hydrate_podcast_episode_url` expect (worker/tasks/audio_tasks.py
    patches audio_key onto posts[idx] the same way)."""
    feed_id = seeded_users["feed_a"]
    posts = [
        {
            "persona": "skeptic",
            "post_type": "post",
            "content": "hydration test post",
            "audio_key": f"{seeded_users['user_a']}/feeds/{feed_id}/audio/0.mp3",
        }
    ]
    await db_conn.execute(
        """UPDATE feeds SET posts = $2, post_count = 1,
                  audio_status = 'ready', podcast_status = 'ready'
           WHERE id = $1""",
        feed_id, json.dumps(posts),
    )
    yield {"feed_id": feed_id, "user_id": seeded_users["user_a"]}


@pytest_asyncio.fixture
async def seeded_figure(db_conn: asyncpg.Connection, seeded_users):
    """A figure row owned by user A's paper — no file needed on disk since
    the storage backend's figure_image_url is monkeypatched in these tests."""
    figure_id = str(uuid.uuid4())
    paper_id = seeded_users["paper_a"]
    await db_conn.execute(
        """INSERT INTO figures (id, paper_id, page_number, image_path,
                                extraction_type, description, claim_summary,
                                figure_index)
           VALUES ($1, $2, 1, 'irrelevant.png', 'image', 'desc', 'claim', 0)""",
        figure_id, paper_id,
    )
    yield {"figure_id": figure_id, "paper_id": paper_id}
    await db_conn.execute("DELETE FROM figures WHERE id = $1", figure_id)


@pytest.mark.asyncio
async def test_feed_audio_url_hydrated_off_loop(
    client_as_user_a, seeded_audio_feed, monkeypatch
):
    monkeypatch.setattr(storage_module.storage, "audio_url", _fake_signed_url)
    r = await client_as_user_a.get(f"/feed/{seeded_audio_feed['feed_id']}")
    assert r.status_code == 200, r.text
    posts = r.json()["posts"]
    assert posts[0]["audio_url"] == "https://signed.example/ok"


@pytest.mark.asyncio
async def test_feed_podcast_episode_url_hydrated_off_loop(
    client_as_user_a, seeded_audio_feed, monkeypatch
):
    monkeypatch.setattr(storage_module.storage, "podcast_episode_url", _fake_signed_url)
    r = await client_as_user_a.get(f"/feed/{seeded_audio_feed['feed_id']}")
    assert r.status_code == 200, r.text
    assert r.json()["podcast_audio_url"] == "https://signed.example/ok"


@pytest.mark.asyncio
async def test_figures_image_url_hydrated_off_loop(
    client_as_user_a, seeded_figure, monkeypatch
):
    monkeypatch.setattr(storage_module.storage, "figure_image_url", _fake_signed_url)
    r = await client_as_user_a.get(f"/papers/{seeded_figure['paper_id']}/figures")
    assert r.status_code == 200, r.text
    body = r.json()
    entry = next(f for f in body if f["id"] == seeded_figure["figure_id"])
    assert entry["image_url"] == "https://signed.example/ok"
