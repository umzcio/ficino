-- Papers + feeds B-tree indexes for hot-path ownership-scoped queries.
--
-- Before this, the only index touching `papers` was the implicit PK; every
-- `list_papers` / `list_feeds` / `generate_feed` pre-check did a seq scan of
-- papers filtered by `user_id` + `corpus_id`. At small scale that's tolerable
-- but it gets linearly worse as the table grows and N+1-ish RAG queries pile
-- on top of it. Three composite indexes cover the three dominant shapes:
--
-- 1. (user_id, corpus_id, status) — `COUNT(*) FROM papers WHERE status='complete'
--    AND corpus_id=$1 AND user_id=$2` (generate_feed precheck) and every
--    workspace-scoped paper list.
-- 2. (user_id, uploaded_at DESC) — `ORDER BY uploaded_at DESC LIMIT 50` on the
--    unfiltered list path.
-- 3. (user_id, corpus_id, generated_at DESC) on feeds — listFeeds primary shape.
--
-- All three are CONCURRENTLY so adding them on a live database doesn't block
-- writes. Paired with post_replies(updated_at DESC) from the same migration
-- step to cover the inbox open.

CREATE INDEX CONCURRENTLY IF NOT EXISTS papers_user_corpus_status_idx
  ON papers (user_id, corpus_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS papers_user_uploaded_idx
  ON papers (user_id, uploaded_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS feeds_user_corpus_generated_idx
  ON feeds (user_id, corpus_id, generated_at DESC);

-- Inbox open sorts all reply threads by updated_at; without this the query
-- plan was a full sort over post_replies every time. Pairs well with the
-- existing (feed_id, post_index) index, which serves the direct lookup path.
CREATE INDEX CONCURRENTLY IF NOT EXISTS post_replies_updated_at_idx
  ON post_replies (updated_at DESC);
