"""R10 WORK-5: a 'generating' row older than the claim threshold must be
reclaimable; a fresh 'generating' claim must NOT be."""
import uuid

from lib.db import execute, fetchrow


def _mk_feed(status, claimed_at_sql):
    feed_id = str(uuid.uuid4())
    execute(
        f"""INSERT INTO feeds (id, user_id, posts, post_count, audio_status, audio_claimed_at)
            VALUES ($1, '00000000-0000-0000-0000-000000000000', '[]', 0, $2, {claimed_at_sql})""",
        feed_id, status,
    )
    return feed_id


def _claim(feed_id):
    # mirror of audio_tasks claim — update together
    return fetchrow(
        """UPDATE feeds SET audio_status = 'generating', audio_claimed_at = NOW()
           WHERE id = $1
             AND (audio_status IS NULL OR audio_status = 'failed'
                  OR (audio_status = 'generating'
                      AND (audio_claimed_at IS NULL
                           OR audio_claimed_at < NOW() - INTERVAL '15 minutes')))
           RETURNING id""",
        feed_id,
    )


def test_stale_generating_claim_is_reclaimable():
    feed_id = _mk_feed("generating", "NOW() - INTERVAL '20 minutes'")
    try:
        assert _claim(feed_id) is not None, "20-min-old claim must be reclaimable (R10 WORK-5)"
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
