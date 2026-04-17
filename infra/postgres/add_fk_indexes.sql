-- Foreign-key indexes to close N+1-adjacent hot paths identified in
-- FICINO_CODE_REVIEW.md (perf-10). None of these FK columns have an
-- automatic index — Postgres indexes primary keys but not the referenced
-- side, so `WHERE paper_id = $1` joins end up sequential-scanning.
--
-- chunks(paper_id): hit on every retrieval query, every paper-delete cascade,
--                   and the `list_figures` endpoint's sibling lookups.
-- figures(paper_id): hit on list_figures and paper detail page.
-- bookmarks(user_id): hit on the bookmarks view + feed-enrichment paths.
--
-- All three are additive. CONCURRENTLY keeps the writes non-blocking on
-- populated tables. Run once against the live DB after init.sql.
--
-- Rollback:
--   DROP INDEX chunks_paper_id_idx, figures_paper_id_idx, bookmarks_user_id_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS chunks_paper_id_idx
  ON chunks (paper_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS figures_paper_id_idx
  ON figures (paper_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS bookmarks_user_id_idx
  ON bookmarks (user_id);
