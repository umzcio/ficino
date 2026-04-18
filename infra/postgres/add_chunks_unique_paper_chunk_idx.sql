-- chunks: dedupe on (paper_id, chunk_index).
--
-- Background (review finding HIGH-1 / round 7):
-- process_paper has max_retries=2. If any step after chunk insert fails
-- (transient DB error on the final status update, figure step crash, etc.),
-- Celery retries the whole pipeline. Without a dedupe key, the retry re-
-- inserts every chunk, silently doubling embeddings and poisoning both the
-- HNSW vector index and the tsvector FTS index. The worker INSERT is now
-- ON CONFLICT DO UPDATE so re-runs refresh rows in place.
--
-- The pre-existing data is expected to be unique per (paper_id, chunk_index)
-- since no retry has yet produced duplicates — but this migration still
-- dedupes defensively before adding the constraint.

BEGIN;

-- Dedupe any existing duplicates: keep the row with the most recent id
-- (gen_random_uuid is monotonic-ish; tiebreakers don't matter because the
-- content is identical if chunk_index matches).
DELETE FROM chunks a USING chunks b
WHERE a.paper_id = b.paper_id
  AND a.chunk_index = b.chunk_index
  AND a.ctid < b.ctid;

ALTER TABLE chunks
  ADD CONSTRAINT chunks_paper_chunk_idx_uq UNIQUE (paper_id, chunk_index);

COMMIT;
