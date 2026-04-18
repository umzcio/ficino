-- Add contextual_prefix to chunks so Anthropic-style contextual retrieval
-- can store the 1-2 sentence "this chunk is about X in paper Y" blurb that
-- gets prepended to the chunk content before embedding. The blurb itself
-- is not required for retrieval (the signal lives in the embedding vector)
-- but keeping it lets us re-embed later without a second LLM pass if the
-- embedder is swapped.
--
-- Nullable by design: existing chunks continue to work unchanged, and
-- CONTEXT_PROVIDER=none keeps new chunks prefix-less too. No backfill
-- performed here — user said they'll re-ingest from scratch.
--
-- Run with: docker exec -i ficino-postgres psql -U ficino -d ficino \
--   < infra/postgres/add_chunks_contextual_prefix.sql

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS contextual_prefix TEXT;
