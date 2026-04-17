# Code Quality Findings

## CRITICAL (1)

### 1. Celery generate_feed Task Not Idempotent in Append Mode
- worker/tasks/persona_tasks.py:152-157, 409-417
- Retries can double-append posts. Needs idempotency token or dedup on task.request.id.

## HIGH (6)

### 2. PostBase.post_type Defined as str, Not Literal
- api/models/feed.py:11,21,26,31,37 — TS types are strict union, backend is any-string. Schema mismatch.

### 3. Hardcoded Engagement Numbers Duplicated
- worker/tasks/persona_tasks.py:392-395 and 556-559 — identical random.randint ranges. Move to api/constants.py.

### 4. API Services Layer Unimplemented (NotImplementedError Stubs)
- api/services/persona.py:4-6, retrieval.py:3-6, ingestion.py — routers bypass services; business logic split between API and worker.

### 5. Feed.posts Typed as list[dict[str, object]]
- api/models/feed.py:56 — no validation on stored posts; LLM can produce invalid shapes.

### 6. Persona Cache Has No Invalidation
- worker/lib/persona.py:45-65, 100-103 — module-global cache, never refreshed without worker restart.

### 7. Zero Unit Tests
- /projects/ficino/tests/ has only e2e/ and results/ — no Python unit tests for routers/services/tasks.

## MEDIUM (8)

### 8. Generic 500 HTTPException Swallows Detail
- api/routers/replies.py:191-193, 511

### 9. Async Event Loop Race in Worker db.py
- worker/lib/db.py:25-50 — lock covers state check but not full loop lifecycle.

### 10. Inconsistent retrieve_for_persona Imports
- worker/tasks/persona_tasks.py:230 (persona_lib) vs 508 (retrieval) — different caching/weighting.

### 11. Stale Closure in useFeed Polling
- frontend/src/hooks/useFeed.ts:61-95 — polling can fire on unmounted component.

### 12. Workspace switchTo Doesn't Refresh Context
- frontend/src/hooks/useWorkspaces.ts:40-43

### 13. Figure Extraction Silent Failure Tolerance
- worker/tasks/ingestion_tasks.py:223-238 — no failure-rate threshold.

### 14. Paper Status Updates Not Transactional
- worker/tasks/ingestion_tasks.py:31-59 — concurrent updates can overwrite.

### 15. Hybrid Search Weights Hardcoded
- worker/lib/retrieval.py:19-25 — VECTOR_WEIGHT=0.7, KEYWORD_WEIGHT=0.3 not configurable.

## LOW (1)

### 16. Undocumented Oversample Ratio
- worker/tasks/persona_tasks.py:93 — `range(max_pairs * 3)` magic number.
