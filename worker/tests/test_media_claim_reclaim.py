"""R10 WORK-5: a 'generating' row older than the claim threshold must be
reclaimable; a fresh 'generating' claim must NOT be.

W5 Task 3 item 1: the threshold itself is derived from CELERY_TIME_LIMIT via
audio_tasks._reclaim_minutes() (2x the task time limit, floor 15 min) instead
of a hardcoded 15 minutes. At the default CELERY_TIME_LIMIT=600 (10 min),
2x = 20 min, which is already above the 15-min floor — so the *default*
reclaim window widens from the old hardcoded 15 min to 20 min. This test
imports the real function rather than re-deriving the formula, so the
numeric threshold can't drift out of sync; only the claim SQL text below
still needs hand-syncing with audio_tasks.py (keep-in-sync comment on
`_claim`)."""
import uuid

import pytest

from lib.db import execute, fetchrow
from tasks.audio_tasks import _reclaim_minutes

_STUB_USER_ID = "00000000-0000-0000-0000-000000000000"


def _mk_feed(status, claimed_at_sql):
    # feeds.user_id FKs into users — seed the stub user idempotently rather
    # than relying on it pre-existing (a long-lived dev DB happens to have
    # it from prior app use, but a fresh CI DB from init.sql + migrations
    # does not).
    execute(
        "INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        _STUB_USER_ID, "stub@ficino.dev",
    )
    feed_id = str(uuid.uuid4())
    execute(
        f"""INSERT INTO feeds (id, user_id, posts, post_count, audio_status, audio_claimed_at)
            VALUES ($1, $2, '[]', 0, $3, {claimed_at_sql})""",
        feed_id, _STUB_USER_ID, status,
    )
    return feed_id


def _claim(feed_id, minutes: int | None = None):
    # mirror of audio_tasks claim — update together
    return fetchrow(
        """UPDATE feeds SET audio_status = 'generating', audio_claimed_at = NOW()
           WHERE id = $1
             AND (audio_status IS NULL OR audio_status = 'failed'
                  OR (audio_status = 'generating'
                      AND (audio_claimed_at IS NULL
                           OR audio_claimed_at < NOW() - make_interval(mins => $2))))
           RETURNING id""",
        feed_id, minutes if minutes is not None else _reclaim_minutes(),
    )


@pytest.mark.parametrize("age_minutes", [21, 30, 90])
def test_stale_generating_claim_is_reclaimable(age_minutes):
    feed_id = _mk_feed("generating", f"NOW() - INTERVAL '{age_minutes} minutes'")
    try:
        assert _claim(feed_id) is not None, (
            f"{age_minutes}-min-old claim must be reclaimable under the "
            "default ~20-min window (R10 WORK-5)"
        )
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id)


def test_fresh_generating_claim_is_not_stolen():
    feed_id = _mk_feed("generating", "NOW()")
    try:
        assert _claim(feed_id) is None, "an active render must not be double-claimed"
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id)


def test_legacy_null_claimed_at_generating_row_is_reclaimable():
    feed_id = _mk_feed("generating", "NULL")
    try:
        assert _claim(feed_id) is not None, "pre-migration stuck rows must be recoverable"
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id)


def test_reclaim_minutes_default_is_20():
    # CELERY_TIME_LIMIT defaults to 600s -> 2x = 1200s = 20min, which is
    # already above the 15-min floor, so the floor isn't actually load
    # bearing at the default — assert the real number rather than
    # hand-waving "15".
    assert _reclaim_minutes() == 20


def test_raised_celery_time_limit_widens_reclaim_window(monkeypatch):
    """A claim aged 25 minutes is reclaimable under the default ~20-min
    window (CELERY_TIME_LIMIT unset -> 600s -> 20 min) but must NOT be
    reclaimable once CELERY_TIME_LIMIT is raised to 1800s (-> 60-min
    window) — proving the env-driven value actually changes what the SQL
    treats as abandoned, not just a formula unit nothing calls."""
    feed_id = _mk_feed("generating", "NOW() - INTERVAL '25 minutes'")
    try:
        default_minutes = _reclaim_minutes()
        assert default_minutes == 20
        assert _claim(feed_id, minutes=default_minutes) is not None, (
            "25-min-old claim must be reclaimable under the default ~20-min window"
        )
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id)

    monkeypatch.setenv("CELERY_TIME_LIMIT", "1800")
    widened_minutes = _reclaim_minutes()
    assert widened_minutes == 60

    feed_id2 = _mk_feed("generating", "NOW() - INTERVAL '25 minutes'")
    try:
        assert _claim(feed_id2, minutes=widened_minutes) is None, (
            "same 25-min-old claim must NOT be reclaimable once CELERY_TIME_LIMIT "
            "widens the window to 60 minutes"
        )
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id2)
