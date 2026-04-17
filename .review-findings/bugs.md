# Bug-Hunter Findings

## CRITICAL (3)

### 1. Post ID Collision in Append Mode
- worker/tasks/persona_tasks.py:346
- `post_data["id"] = id_offset + i + 1` uses loop index `i`, but `continue` at line 311 skips appending. Later posts reuse IDs.
- Fix: use `id_offset + len(posts) + 1`

### 2. Missing tx.done Await in IndexedDB Cache
- frontend/src/lib/offline-cache.ts:30-35 — `cacheFeeds()` awaits each put but may not properly await `tx.done` before returning.

### 3. Unsafe Bidirectional Substring in Title Matching
- worker/lib/retrieval.py:155 — `any(liked in title or title in liked for liked in liked_set)` causes false positive boosts.

## HIGH (4)

### 4. Unhandled Rejection in usePersonas Cleanup
- frontend/src/hooks/usePersonas.ts:20 — async `.catch()` can itself reject unhandled.

### 5. Refresh Dependency Cycle in useWorkspaces
- frontend/src/hooks/useWorkspaces.ts:34 — `refresh` depends on `activeId` and is used in effect at line 37 → loop on activeId change.

### 6. Off-by-One in Chunk Window
- worker/tasks/persona_tasks.py:318-321 — `max(1, len(chunks) - window_size + 1)` misbehaves when len(chunks)==window_size.

### 7. Celery Task ID Assignment Ignores Skipped Posts
- persona_tasks.py:346 (related 398-402) — same root as #1.

## MEDIUM (6)

### 8. Race in Feed Append Mode Read-Modify-Write
- api/routers/feed.py:140-155 — non-atomic read + update.

### 9. Unreachable `raise` After self.retry()
- worker/tasks/persona_tasks.py:467-469

### 10. Potential None persona_key in Prompt
- worker/tasks/persona_tasks.py:306 — fallback `f"You are {persona_key}"` without None check (persona_key sourced from old_post at line 498).

### 11. Unhandled Rejection in useCorpus refresh
- frontend/src/hooks/useCorpus.ts:52-54

### 12. Multiple asyncio.run() in Embedder
- worker/lib/embedder.py:154, 162 — vs safer loop pattern in worker/lib/db.py:25-50.

### 13. useAnnotations Map Mutation Risk
- frontend/src/hooks/useAnnotations.ts:6 — state set to mutable Map; external mutation won't re-render.

## LOW (5)

### 14. useFeed Polling No AbortController
- frontend/src/hooks/useFeed.ts:62-95

### 15. Loose Status Filter in useCorpus
- frontend/src/hooks/useCorpus.ts:59 — doesn't guard on null/undefined status.

### 16. Offline Cache getAllKeys Not Properly Awaited
- frontend/src/lib/offline-cache.ts:172-175

### 17. IndexedDB Schema Version Hardcoded to 1
- frontend/src/lib/offline-db.ts:68 — schema changes won't trigger upgrade.

### 18. corpus_id Not Validated as UUID
- api/routers/feed.py:37
