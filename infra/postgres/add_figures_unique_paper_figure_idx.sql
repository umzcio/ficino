-- Add UNIQUE (paper_id, figure_index) to figures so ingestion retries
-- (process_paper.max_retries=2) upsert rather than duplicate. Matches the
-- chunks (paper_id, chunk_index) constraint added in round 7.
--
-- Deduplicate existing rows first (keep newest by processed_at), then add
-- the constraint. Idempotent — safe to re-run.

BEGIN;

DELETE FROM figures a USING figures b
WHERE a.paper_id = b.paper_id
  AND a.figure_index = b.figure_index
  AND a.ctid < b.ctid;

ALTER TABLE figures
  DROP CONSTRAINT IF EXISTS figures_paper_figure_idx_uq;
ALTER TABLE figures
  ADD CONSTRAINT figures_paper_figure_idx_uq UNIQUE (paper_id, figure_index);

COMMIT;
