"""Plan 015: the audio/podcast dispatch endpoints must be rate-limited.

Every other endpoint that dispatches paid third-party work is limited per
user per day; the two ElevenLabs dispatches (POST /feed/{id}/audio and
POST /feed/{id}/podcast) were not, so any feed in failed/NULL status was
re-dispatchable forever.

The charge is imperative (`check_rate_limit`) right before `send_task`,
mirroring the summary dispatch in messages.py — the generating/ready
idempotent early-returns must never consume budget.

Modeled on the summary rate-limit tests in test_wave3_correctness.py.
"""
from __future__ import annotations

import pytest


class _FakeRedis:
    """In-memory counter standing in for `auth.rate_limit._get_redis()`."""

    def __init__(self):
        self.counts: dict[str, int] = {}

    async def incr(self, key):
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, key, seconds):
        return True


class _FakeTask:
    id = "fake-audio-task-id"


class _FakeCelery:
    """Records send_task calls so tests can assert dispatch happened (or not)."""

    def __init__(self):
        self.calls: list[tuple[tuple, dict]] = []

    def send_task(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return _FakeTask()


def _patch_limiter_and_celery(monkeypatch, feed_router, limit: int):
    """Shared setup: activate the limiter (auth_provider=basic), back it with
    a fake Redis, cap the audio budget, give ElevenLabs a key, and swap in a
    recording fake Celery. Returns (fake_redis, fake_celery)."""
    from auth import rate_limit as rate_limit_module
    from config import settings as app_settings

    fake_redis = _FakeRedis()
    fake_celery = _FakeCelery()

    async def _fake_get_redis():
        return fake_redis

    # feed.py calls the bare name `get_celery`, resolved against its own
    # module globals — patch that name (same as the summary tests patch
    # messages.get_celery).
    monkeypatch.setattr(feed_router, "get_celery", lambda: fake_celery)
    # The limiter no-ops entirely under AUTH_PROVIDER=none (the suite's
    # default) — flip to "basic" so it is actually active.
    monkeypatch.setattr(app_settings, "auth_provider", "basic")
    monkeypatch.setattr(app_settings, "rate_limit_audio_per_day", limit)
    # The handlers 501 when no ElevenLabs key is configured.
    monkeypatch.setattr(app_settings, "elevenlabs_api_key", "test-key")
    monkeypatch.setattr(rate_limit_module, "_get_redis", _fake_get_redis)
    return fake_redis, fake_celery


@pytest.mark.asyncio
async def test_audio_dispatch_for_failed_feed_is_charged_and_dispatched(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """A feed whose audio_status is 'failed' falls through to dispatch:
    202, one send_task, and the audio bucket charged exactly once."""
    from routers import feed as feed_router

    _, fake_celery = _patch_limiter_and_celery(monkeypatch, feed_router, limit=20)

    feed_id = seeded_users["feed_a"]
    await db_conn.execute(
        "UPDATE feeds SET audio_status = 'failed' WHERE id = $1", feed_id
    )

    r = await client_as_user_a.post(f"/feed/{feed_id}/audio")
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "generating"
    assert body["task_id"] == "fake-audio-task-id"
    assert len(fake_celery.calls) == 1
    assert fake_celery.calls[0][0][0] == "tasks.audio_tasks.generate_audio_for_feed"


@pytest.mark.asyncio
async def test_audio_dispatch_over_limit_429s_without_dispatch(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """With the budget capped at 3, the 4th dispatch 429s and send_task is
    NOT called for it (no paid work dispatched past the limit)."""
    from routers import feed as feed_router

    fake_redis, fake_celery = _patch_limiter_and_celery(monkeypatch, feed_router, limit=3)

    feed_id = seeded_users["feed_a"]
    await db_conn.execute(
        "UPDATE feeds SET audio_status = 'failed' WHERE id = $1", feed_id
    )

    for i in range(3):
        r = await client_as_user_a.post(f"/feed/{feed_id}/audio")
        assert r.status_code == 202, f"dispatch #{i} got {r.status_code}: {r.text}"
        # Reset to 'failed' so the next request reaches the dispatch branch
        # again (the handler itself doesn't write the status; the worker does).
        await db_conn.execute(
            "UPDATE feeds SET audio_status = 'failed' WHERE id = $1", feed_id
        )

    calls_before = len(fake_celery.calls)
    r = await client_as_user_a.post(f"/feed/{feed_id}/audio")
    assert r.status_code == 429, r.text
    assert len(fake_celery.calls) == calls_before, (
        "an over-limit dispatch must not reach send_task"
    )
    key = next(iter(fake_redis.counts))
    assert key.startswith("ratelimit:audio:")
    assert fake_redis.counts[key] == 4, (
        "the limiter increments before rejecting (INCR-first), so the 4th "
        f"hit leaves the counter at 4, saw: {fake_redis.counts}"
    )


@pytest.mark.asyncio
async def test_generating_ready_early_returns_never_charge_budget(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """The idempotent early-return (audio already generating/ready) must not
    consume rate-limit budget: repeat it N+1 times (N = limit), then a real
    dispatch still succeeds."""
    from routers import feed as feed_router

    fake_redis, fake_celery = _patch_limiter_and_celery(monkeypatch, feed_router, limit=3)

    feed_id = seeded_users["feed_a"]

    # 4 'ready' hits — over the limit of 3 — all return early without 429.
    await db_conn.execute(
        "UPDATE feeds SET audio_status = 'ready' WHERE id = $1", feed_id
    )
    for i in range(4):
        r = await client_as_user_a.post(f"/feed/{feed_id}/audio")
        assert r.status_code == 202, f"early-return #{i} got {r.status_code}: {r.text}"
        assert r.json()["status"] == "ready"

    # Same for 'generating' and for the podcast endpoint.
    await db_conn.execute(
        "UPDATE feeds SET audio_status = 'generating', podcast_status = 'ready' WHERE id = $1",
        feed_id,
    )
    for i in range(4):
        r = await client_as_user_a.post(f"/feed/{feed_id}/audio")
        assert r.status_code == 202, f"generating #{i} got {r.status_code}: {r.text}"
        r = await client_as_user_a.post(f"/feed/{feed_id}/podcast")
        assert r.status_code == 202, f"podcast early-return #{i} got {r.status_code}: {r.text}"

    assert fake_redis.counts == {}, (
        "early-returns must never touch the rate limiter, "
        f"but saw: {fake_redis.counts}"
    )
    assert fake_celery.calls == []

    # Budget untouched: a real dispatch (status flipped to failed) succeeds.
    await db_conn.execute(
        "UPDATE feeds SET audio_status = 'failed' WHERE id = $1", feed_id
    )
    r = await client_as_user_a.post(f"/feed/{feed_id}/audio")
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "generating"
    assert len(fake_celery.calls) == 1


@pytest.mark.asyncio
async def test_podcast_dispatch_shares_the_audio_budget(
    client_as_user_a, seeded_users, db_conn, monkeypatch,
):
    """The podcast dispatch is charged against the same audio bucket:
    with limit=1, one podcast dispatch consumes the whole budget and a
    subsequent audio dispatch 429s."""
    from routers import feed as feed_router

    fake_redis, fake_celery = _patch_limiter_and_celery(monkeypatch, feed_router, limit=1)

    feed_id = seeded_users["feed_a"]
    await db_conn.execute(
        "UPDATE feeds SET podcast_status = 'failed', audio_status = 'failed' WHERE id = $1",
        feed_id,
    )

    r = await client_as_user_a.post(f"/feed/{feed_id}/podcast")
    assert r.status_code == 202, r.text
    assert fake_celery.calls[0][0][0] == "tasks.audio_tasks.generate_podcast_for_feed"

    r = await client_as_user_a.post(f"/feed/{feed_id}/audio")
    assert r.status_code == 429, r.text
    assert any(k.startswith("ratelimit:audio:") for k in fake_redis.counts)
