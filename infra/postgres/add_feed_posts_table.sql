-- feed_posts — normalized, searchable view of feeds.posts JSONB.
--
-- Design notes (review finding 2.19 / 2.20):
-- The existing `feeds.posts` JSONB column holds arrays of 10–50 posts per
-- feed. Full-text search currently pulls entire feed rows and does Python-
-- side substring matching (api/routers/search.py). That scales as O(feeds
-- × posts) per search.
--
-- This table lets us:
--   1. Push `plainto_tsquery` filtering to Postgres via a GIN index on
--      search_vector.
--   2. Keep post-level ownership scoping with a simple JOIN back to feeds.
--
-- Strategy: JSONB stays the source of truth. feed_posts is a secondary
-- search index, double-written by the persona_tasks writer and by the
-- delete/regenerate handlers. A one-shot backfill script populates existing
-- rows. Soft-deletes propagate from the JSONB path via a `deleted` flag
-- so the index can skip soft-deleted posts without churning rows.

CREATE TABLE IF NOT EXISTS feed_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  -- Denormalized from feeds.user_id so full-text search can filter by owner
  -- before hitting the GIN index (see add_user_id_to_chunks_feed_posts.sql).
  -- NOT NULL is enforced by the follow-up migration after backfill.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  post_index INTEGER NOT NULL,

  -- Denormalized searchable fields (copied out of the JSONB dict)
  content_text TEXT NOT NULL,
  persona TEXT,
  post_type TEXT,
  category TEXT,
  paper_ref TEXT,

  -- Full post data for reader convenience. JSONB in feeds.posts is still
  -- authoritative; this is a denorm. If the two drift, re-run the backfill.
  data JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Generated tsvector. STORED so queries hit the index without re-parsing.
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      COALESCE(content_text, '') || ' ' || COALESCE(paper_ref, '')
    )
  ) STORED,

  -- Soft-delete flag kept in lockstep with posts[i].deleted in the JSONB.
  deleted BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (feed_id, post_index)
);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS feed_posts_search_idx
  ON feed_posts USING GIN (search_vector);

-- Feed-id index for fast ownership-scoped queries
CREATE INDEX IF NOT EXISTS feed_posts_feed_id_idx
  ON feed_posts (feed_id);

-- Category + not-deleted composite for tab-filtered feed reads (future use)
CREATE INDEX IF NOT EXISTS feed_posts_category_idx
  ON feed_posts (feed_id, category)
  WHERE NOT deleted;
