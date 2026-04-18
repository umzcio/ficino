-- Denormalize user_id onto chunks and feed_posts so full-text search can
-- filter by owner before hitting the GIN index. Previously the tsquery
-- scanned across every tenant's content and the user_id check happened
-- post-JOIN, which at 100k+ chunks and a common search term (e.g. "neural",
-- "model") matched tens of thousands of rows before trimming by ownership.
--
-- Run with: docker exec -i ficino-postgres psql -U ficino -d ficino \
--   < infra/postgres/add_user_id_to_chunks_feed_posts.sql
--
-- The ALTERs use NOT NULL after backfill; the index builds CONCURRENTLY so
-- this is safe to apply on a live DB while queries are running. Re-running
-- is a no-op thanks to the IF NOT EXISTS / IF EXISTS guards.

BEGIN;

-- chunks.user_id ---------------------------------------------------------
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

UPDATE chunks c
  SET user_id = p.user_id
  FROM papers p
  WHERE c.paper_id = p.id
    AND c.user_id IS NULL;

-- Any residual NULLs mean the paper row was deleted but chunks weren't
-- cascade-cleaned (shouldn't happen given the FK, but guard the NOT NULL
-- upgrade). If you see rows here, drop them.
DELETE FROM chunks WHERE user_id IS NULL;

ALTER TABLE chunks
  ALTER COLUMN user_id SET NOT NULL;

-- feed_posts.user_id ----------------------------------------------------
ALTER TABLE feed_posts
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

UPDATE feed_posts fp
  SET user_id = f.user_id
  FROM feeds f
  WHERE fp.feed_id = f.id
    AND fp.user_id IS NULL;

DELETE FROM feed_posts WHERE user_id IS NULL;

ALTER TABLE feed_posts
  ALTER COLUMN user_id SET NOT NULL;

COMMIT;

-- Indexes (outside the transaction so CONCURRENTLY works)
CREATE INDEX CONCURRENTLY IF NOT EXISTS chunks_user_id_idx ON chunks(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_posts_user_id_idx ON feed_posts(user_id);
