# Performance Review Findings

## CRITICAL (2)

### 1. Missing pgvector Index on Chunks Embedding Column
- File: infra/postgres/init.sql:82
- Index commented out: `-- CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`
- Retrieval at worker/lib/retrieval.py:74-88 uses `(c.embedding <=> $1::vector) < {MAX_VECTOR_DISTANCE}` — O(n) sequential scan
- Fix: `CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=200);`

### 2. Feed Posts Stored as Serialized JSONB — No Indexing on Content
- File: infra/postgres/init.sql:115 (`posts JSONB NOT NULL DEFAULT '[]'`)
- search.py:80-105 fetches 20 feeds, parses JSON, iterates posts in Python with substring match
- Fix: Normalize to feed_posts table with tsvector GIN index

## HIGH (6)

### 3. N+1 in Papers List (missing index on paper_tags.paper_id)
- papers.py:103-118, 120-133 — LEFT JOIN + json_agg + GROUP BY without index
- Fix: `CREATE INDEX ON paper_tags (paper_id);`

### 4. Feed Search Iterates All Feeds in Memory
- search.py:80-105 — no SQL filter, in-memory iteration

### 5. Retrieval Over-Fetches Before Re-Rank
- worker/lib/retrieval.py:61-93 — ts_rank on all vector-matching chunks, LIMIT only at end
- Fix: 2-stage retrieval (vector top-100, then hybrid re-rank)

### 6. PostCard Not Memoized
- frontend/src/components/Feed/PostCard.tsx:179 — no React.memo, 20+ useState, all re-render on parent change
- Parent Feed.tsx:112 — filtered.map remounts all cards on filter change

### 7. Feed Doesn't Virtualize
- Feed.tsx:110-137 — all posts in DOM, no react-window

### 8. Celery Worker Concurrency/Redis Pool
- worker/celery_app.py:21 — prefetch_multiplier=1 good, but no worker_concurrency or broker_pool_limit set

### 9. Service Worker Figure Cache Bounds
- vite.config.ts:29-34 — figure cache has maxEntries but confirm maxAgeSeconds set on all runtime caches

## MEDIUM (5)

### 10. Missing FK Indexes
- chunks(paper_id), figures(paper_id), bookmarks(user_id) — no indexes

### 11. OpenAI Embedder No Rate Limiting Between Batches
- embedder.py:58-62 — no sleep between 100-chunk batches (Voyage at line 113 has 0.5s delay)

### 12. Chunker Falls Back to "untitled"
- worker/lib/chunker.py:179-182 — <3 sections → loses semantic structure

### 13. Replies Make 5+ Sequential LLM Calls
- replies.py:188 main response, 220-272 per-mention, 282 interjection — all sequential

### 14. Offline Cache Clear-Before-Put Race
- frontend/src/lib/offline-cache.ts:88-94 — clear() then loop put(); partial failure loses data

### 15. Search Doesn't Early-Limit
- search.py:80-105 — scans hundreds of posts for 10 matches

## LOW (2)

### 16. Embedding String Round-Trip
- worker/lib/retrieval.py:46-48 — float→string→vector precision loss (minor)

### 17. No Manual Code Splitting
- vite.config.ts — no manualChunks for Messages/ReadingLists/PersonaProfile

