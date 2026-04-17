-- Add HNSW index on chunks.embedding for fast vector similarity search.
--
-- This migration addresses FICINO_CODE_REVIEW.md finding C3 (perf-1):
-- the IVFFlat index in init.sql is commented out with a "build later"
-- note, which means every retrieval query does a sequential scan of
-- chunks using the `<=>` cosine-distance operator. Imperceptible at
-- ~220 chunks; falls over well before 10k.
--
-- HNSW is preferred over IVFFlat for corpora that grow incrementally
-- through uploads: no "rebuild when data shifts" concern, and recall
-- quality holds up with default parameters.
--
-- Parameters chosen:
--   m = 16                — default; graph-degree per layer, trades memory for recall
--   ef_construction = 64  — default; build-time quality knob. Higher = better recall, slower build
--
-- At query time you can bump `hnsw.ef_search` (session-level) when you want
-- higher recall at the cost of query latency; leave it at default for now.
--
-- Build time: expect on the order of seconds for ~10k chunks,
-- tens of seconds for ~100k, minutes for ~1M. CONCURRENTLY is preferred
-- if running against a live DB — drop the CONCURRENTLY keyword for an
-- initial seed (won't matter during install).
--
-- Rollback: DROP INDEX chunks_embedding_hnsw;

CREATE INDEX CONCURRENTLY IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
