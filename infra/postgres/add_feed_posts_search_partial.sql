-- feed_posts_search_idx → partial GIN index on (WHERE NOT deleted).
--
-- The original `feed_posts_search_idx` indexed every row, including soft-
-- deleted posts. Every search query then has to filter them back out via
-- `WHERE NOT deleted`, and the GIN tree keeps paying to maintain postings
-- for tombstoned rows that will never match a real query. Making the index
-- partial on `WHERE NOT deleted` shrinks the index, keeps writes cheaper,
-- and lets the planner skip the deleted-row filter entirely — the index
-- itself is the filter.
--
-- IMPORTANT: postgres forbids wrapping DROP INDEX CONCURRENTLY + CREATE
-- INDEX CONCURRENTLY in a single transaction. The statements below run
-- outside any BEGIN/COMMIT so each one is autocommitted. Applied via:
--   docker exec ficino-postgres psql -U ficino -d ficino \
--       -f /tmp/add_feed_posts_search_partial.sql

-- Drop the old non-partial index. CONCURRENTLY so we don't lock out writers.
DROP INDEX CONCURRENTLY IF EXISTS feed_posts_search_idx;

-- Recreate as a partial index on non-deleted rows only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_posts_search_idx
  ON feed_posts USING GIN (search_vector)
  WHERE NOT deleted;
