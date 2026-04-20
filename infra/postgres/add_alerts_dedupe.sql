-- Alerts dedupe (Round 9 #10, Round 10 P1)
--
-- Without a dedupe key, every Celery retry of check_contradictions /
-- check_post_feed / check_stale_papers re-INSERTs the same alert rows
-- and the bell fills with identical entries after a few days.
--
-- We add a nullable `dedupe_hash` column and a partial UNIQUE index
-- scoped to (user_id, alert_type, dedupe_hash). Writers that want
-- idempotency hash their key attributes (paper_id, feed_id, etc.) and
-- pass the hash; writers that genuinely want every occurrence leave
-- dedupe_hash NULL and keep their existing behaviour. NULL is excluded
-- from the unique constraint via WHERE dedupe_hash IS NOT NULL, so
-- legacy NULL rows continue to coexist and the column is safe to add
-- on a live database without a backfill.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS dedupe_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedupe_idx
  ON alerts (user_id, alert_type, dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;
