# Ficino — Comprehensive Code Review

Date: 2026-04-17
Scope: full static review (7 domains) + live Playwright testing on the deployed instance
Stack reviewed: frontend (React 19 + Vite 8 + TS 6 + Tailwind v4 + PWA), api (FastAPI + async Python 3.11 + asyncpg), worker (Celery + Ollama/Claude), Postgres 16 + pgvector, Redis 7

**Verification policy:** every finding in this report that could drive an urgent change (rotate key, auth fix, schema change) has been re-verified by the orchestrator against source at the cited `file:line`. Findings where the agent's original claim was inaccurate are called out in the _Verification corrections_ section at the bottom. Raw per-agent findings are preserved at `/projects/ficino/.review-findings/*.md` for traceability.

---

## Executive Summary

**Totals (verified):** 7 critical · 34 high · 48 medium · 22 low · 6 live-test bugs · 115 issues total.

**Top-5 beta blockers:**

1. **Unauthenticated IDOR on core read endpoints.** `GET /feed/{id}`, `GET /papers/{id}`, `GET /papers` (list), `GET /messages/papers`, `GET /replies/conversations`, `GET /replies/{feed_id}/{post_index}`, `DELETE /feed/{id}/posts/{post_index}`, `POST /feed/{id}/regenerate/{post_index}` all lack `Depends(get_current_user)` and user/workspace scoping in SQL. Once `AUTH_PROVIDER≠none` is enabled for ficino.ai, any authenticated user can read or mutate any other user's data by guessing UUIDs. See _Security_ block.
2. **Anthropic API key on disk (local `.env`), not in git.** Not exposed publicly — `.gitignore:2` blocks it and `git ls-files` confirms it was never committed. Still worth moving out of the docker-compose `env_file` path into a secret manager before deploy; rotation is discretionary, not urgent.
3. **pgvector index disabled in schema.** `infra/postgres/init.sql:82` leaves the IVFFlat index commented with a "build later" note. Every persona retrieval and Archivist query does an `ORDER BY embedding <=> $1` sequential scan on `chunks`. Feeds feel OK at ~220 chunks in the live instance; this will fall over well before the first 100 users.
4. **Prompt injection surface.** Raw PDF-extracted chunk text flows into persona system prompts (`worker/lib/persona.py:131-133`), Archivist system prompts (`archivist_tasks.py:94-100`), and the pairwise contradiction classifier (`claude_client.py:149-161`) with no sanitization, fencing, or role-marker stripping. A hostile PDF can reshape persona behavior.
5. **Celery `generate_feed` append mode is not retry-idempotent.** `persona_tasks.py:152-157, 409-417` — on retry after a partial `UPDATE feeds SET posts = …`, the task reloads already-appended posts as `existing_posts` and re-appends. No task-attempt dedup.

**What's in solid shape** (from live testing + static review):
- All 7 domain agents ran to completion with evidence.
- Pydantic v2 migration is clean (no `@validator`, no `.dict()`, no inner `Config`).
- Tailwind v4 migration is clean (no legacy config, `@theme` used correctly at `frontend/src/index.css:3`).
- License posture is clean (AGPL-3.0 project, all deps permissive).
- PWA works: manifest present, service worker registered, app shell paints offline (AUG-17, 18, 19).
- The existing Playwright test suite runs and mostly passes — failures are selector drift from recent feature work, not product regressions.
- Mobile/tablet/desktop viewports show no horizontal overflow (AUG-23/24/25).
- Reply input is XSS-safe at the rendering boundary (AUG-05).

---

## Critical Issues (pre-beta blockers)

### C1 — IDOR cluster: unauthenticated read/write across core endpoints
**Severity: Critical · Verified in source**

| File:line | Endpoint | Missing |
|---|---|---|
| `api/routers/feed.py:96-126` | `GET /feed/{feed_id}` | auth + `user_id` scope |
| `api/routers/feed.py:129-156` | `DELETE /feed/{feed_id}/posts/{post_index}` | auth + ownership check |
| `api/routers/feed.py:159-179` | `POST /feed/{feed_id}/regenerate/{post_index}` | auth + ownership check |
| `api/routers/papers.py:96-133` | `GET /papers` (list) | auth + `user_id` scope (agent missed this; orchestrator flagged) |
| `api/routers/papers.py:161-193` | `GET /papers/{paper_id}` | auth + ownership check |
| `api/routers/messages.py:26-52` | `GET /messages/papers` | auth + `user_id` scope |
| `api/routers/replies.py:37-88` | `GET /replies/conversations`, `GET /replies/{feed_id}/{post_index}` | auth + ownership via feeds |
| `api/routers/replies.py:111+` | `POST /replies` (create_reply) | auth; this mutates |

Today this is masked by `AUTH_PROVIDER=none` (single-user mode). The moment `basic` or `supabase` is enabled for ficino.ai, users can enumerate and mutate each other's data. The contrast is jarring — the generate/upload/delete endpoints do use `Depends(get_current_user)`, so this is inconsistency, not absence.

**Fix:** add `user: AuthUser = Depends(get_current_user)` to every listed endpoint and add `AND user_id = $N` (or join through `feeds.user_id`) to every query. Add a test that asserts 401/403 for each endpoint when anonymous.

### C2 — Celery `generate_feed` is not retry-idempotent in append mode
**Severity: Critical · Verified at `worker/tasks/persona_tasks.py:152-157, 290-417`**

On entry with `append_to_feed_id`, the task loads `existing_posts` from the DB (line 155-157). After generating new posts, it writes `existing_posts + posts` back with `UPDATE` (line 406-417). If the `UPDATE` commits but the task's Celery ack fails, a retry re-reads the just-written row as `existing_posts` and runs the whole persona pipeline again, producing a doubled append. `max_retries=2` in the `@app.task` decorator makes this reachable.

**Fix:** store an idempotency token (e.g. `self.request.id`) in the feed row before the UPDATE, and no-op the task if it sees its own token already written. Alternatively switch the UPDATE to `jsonb ||` append with a task-id guard.

### C3 — pgvector similarity search has no index
**Severity: Critical (at scale) · Verified at `infra/postgres/init.sql:82`**

```sql
-- IVFFlat index requires data to build (add later with migration when chunk count > 1000)
-- CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON chunks USING GIN (search_vector);
```

Every retrieval (`worker/lib/retrieval.py:74-88`) does `ORDER BY c.embedding <=> $1::vector` — sequential scan because the index is commented out. Live instance has ~220 chunks across 2 papers, so it's imperceptible; at 10 papers / ~1,000 chunks the cost is still low-seconds, but past that it blows up linearly.

**Fix:** add an HNSW index (better than IVFFlat for corpora that grow by upload, no "rebuild" step needed):
```sql
CREATE INDEX chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```
Run as a separate migration so it doesn't block init.

### C4 — Prompt injection: raw PDF/user text into persona prompts
**Severity: Critical · Verified at multiple file:lines**

Three injection surfaces:

- `worker/lib/persona.py:131-133` — `f"[Source {i+1}: …]\n{chunk['content']}\n"` interpolates raw PDF text into every persona system prompt.
- `worker/tasks/archivist_tasks.py:94-100` — chunks concatenated into `ARCHIVIST_SYSTEM.format(chunks=…)`.
- `worker/lib/claude_client.py:149-161` — `classify_contradiction()` f-strings `chunk_a` / `chunk_b` into the prompt without fencing.
- `api/routers/replies.py:230-252` — user's raw message text (from `body.user_message`) flows into `convo_summary` which becomes a mention prompt for the target persona.

A hostile (or carelessly auto-downloaded) PDF can contain "Ignore previous instructions and …" and reshape persona behavior, or make the Archivist leak the corpus verbatim.

**Fix:** wrap untrusted content in hard delimiters (e.g. XML-like `<chunk>…</chunk>` tags), strip role markers (`System:`, `Assistant:`, `Human:`) from chunk text before interpolation, and cap per-chunk length before insertion.

### C5 — PDF upload validation: extension only
**Severity: High (bordering on Critical) · Verified at `api/routers/papers.py:38`**

```python
if not file.filename or not file.filename.lower().endswith(".pdf"):
    raise HTTPException(status_code=400, detail="Only PDF files are accepted")
```

No magic-byte check, no MIME sniff. Live Playwright confirmed this: an arbitrary-bytes file with a `.pdf` extension returned 200 from the API, paper row was created, worker crashed in `FileDataError` with no user-visible error (**BUG-LIVE-01**).

**Fix:** after `contents = await file.read()`, assert `contents.startswith(b"%PDF-")` or reject. Also surface the ingestion `status=error` state in the frontend upload zone.

### C6 — PII / prompt exposure in worker logs
**Severity: High · Verified at `worker/lib/claude_client.py:128`**

`logger.warn("post_json_parse_failed", response_preview=content[:200])` — logs 200 chars of LLM output on parse failure. Combined with `BUG-LIVE-06` (leaked futures in worker logs that include prompt context), there's a risk of user paper content ending up in host logs.

**Fix:** log only shape/length on failure, push full content to a debug sink behind a flag.

### C7 — Services layer is placeholder code
**Severity: High (architectural) · Verified at `api/services/persona.py:6`, `retrieval.py:6`, `ingestion.py:6`**

All three `api/services/*.py` files contain exactly one function that raises `NotImplementedError`. Routers bypass them and dispatch Celery directly. This is dead scaffolding — either implement the layer or delete it. Currently it's misleading to new contributors and to any static-analysis tools.

---

## Security Findings (beyond Critical)

Full details at `/projects/ficino/.review-findings/security.md`.

**High**
- Session cookie missing `secure=True` flag at `api/auth/basic_routes.py:63-70, 95-102`. Fine in dev; must be set behind HTTPS in prod.
- Anthropic API key in local `.env` — **not committed** (`.gitignore:2`, `git ls-files` confirms). Treat as local-disk exposure only; move to a proper secret store before deploy.

**Medium**
- Logout doesn't delete the Redis session (`basic_routes.py:108-117`) — cookie cleared, token still valid server-side for 7 days.
- CORS sends `allow_headers=["*"]` in prod (`main.py:73`).
- No rate limit on `/auth/register` or `/auth/login` (`basic_routes.py:27-105`) despite `rate_limit.py` existing.
- Bcrypt cost left to default (`basic_routes.py:45`) — explicit `rounds=12` preferred.
- Figure URL construction at `papers.py:249` uses `row['image_path'].split('/')[-1]`; harmless today because filenames are UUIDs, but any future storage path reshape can reintroduce path traversal. Store filenames only, not paths.

**Low**
- `reading_lists.py:103-107` crashes on empty `paper_ids`. Guard early.
- No CSRF token; mitigated by CORS + SameSite=Lax.
- No audit log on destructive paper delete.

---

## Bug Findings

Full details at `/projects/ficino/.review-findings/bugs.md`.

**High**
- Post ID assignment uses loop index `i` at `worker/tasks/persona_tasks.py:346`; when `continue` at line 311 (no chunks) or line 402 (generation failure) skips appending, IDs become non-contiguous. In append mode this can also collide with existing IDs if a prior feed itself had skipped IDs. Fix: use `id_offset + len(posts) + 1` after each successful append. (Agent called this "collision"; precise framing is "gaps, sometimes collisions in append mode after prior skips".)
- `frontend/src/lib/offline-cache.ts:30-35` — per-record awaits inside an IndexedDB transaction without a final `await tx.done` before returning.
- `worker/lib/retrieval.py:155` — bidirectional substring title match (`liked in title or title in liked`) produces false-positive relevance boosts for unrelated papers.
- `frontend/src/hooks/useWorkspaces.ts:34` — `refresh` callback depends on `activeId`, is used by `useEffect` at line 37, risking re-fetch loops when `activeId` changes.
- `frontend/src/hooks/usePersonas.ts:20` — async `.catch` that can itself reject with no outer handler.

**Medium**
- Non-atomic feed read-modify-write on soft-delete (`api/routers/feed.py:140-155`) — concurrent deletes can lose each other's changes.
- Unreachable `raise` after `self.retry(exc=…)` at `persona_tasks.py:467-469`.
- `worker/lib/embedder.py:154, 162` call bare `asyncio.run()` in sync paths while `worker/lib/db.py:25-50` has a safer persistent-loop pattern — use the latter everywhere.
- `frontend/src/hooks/useAnnotations.ts:6` stores a mutable `Map` in state; external mutation won't re-render.
- `worker/tasks/persona_tasks.py:306` — `system_prompts.get(persona_key, f"You are {persona_key}")` with no `None` guard on `persona_key` from `old_post`.

**Low**
- `useFeed.ts:62-95` setTimeout-based polling has no AbortController.
- `offline-cache.ts:172-175` iterates `getAllKeys()` without awaiting it.
- `offline-db.ts:68` hardcodes IndexedDB schema version `1`; schema changes will never trigger upgrade.
- `feed.py:37` doesn't validate `corpus_id` as UUID.

---

## Performance Findings (with index recommendations)

Full details at `/projects/ficino/.review-findings/performance.md`.

**Critical / High**
- **C3 above** — pgvector HNSW index missing.
- Feed posts stored as bare `JSONB` at `init.sql:115`; `search.py:80-105` fetches 20 feeds and iterates posts in Python with substring match. Normalize into a `feed_posts` table with a `tsvector` GIN index.
- Hybrid retrieval re-ranks everything matching the vector-distance floor before `LIMIT` (`worker/lib/retrieval.py:61-93`). Use 2-stage retrieval: vector top-N (e.g. 100), then hybrid re-rank.
- `frontend/src/components/Feed/PostCard.tsx:179` — no `React.memo`. The component holds 20+ `useState` hooks; parent `Feed.tsx:110-137` maps `filtered` into all PostCards, so any filter/tab/delete re-renders them all.
- No list virtualization in `Feed.tsx:110-137`. 200+ posts in the DOM is fine today; add `react-window` before the feed grows.
- Celery `worker_prefetch_multiplier=1` at `celery_app.py:21` is right, but `worker_concurrency` and `broker_pool_limit` aren't explicitly set.

**Index recommendations to add in a migration** (not init.sql — requires data):
```sql
CREATE INDEX chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX ON chunks (paper_id);
CREATE INDEX ON figures (paper_id);
CREATE INDEX ON bookmarks (user_id);
```

_Correction:_ the Phase 1 performance agent claimed `paper_tags(paper_id)` was missing an index. It isn't — `paper_tags` has `PRIMARY KEY (paper_id, tag_id)` at `init.sql:64`, which creates a composite index with `paper_id` as leading column. Lookups filtered by `paper_id` alone use that index. The N+1 framing on `papers.py:103-133` still applies (full `json_agg` + `GROUP BY` on a growing corpus); it's just not about a missing index.

**Medium**
- OpenAI embedder has no sleep between 100-text batches (`worker/lib/embedder.py:58-62`) while Voyage does (line 113). Add backoff.
- Chunker silent fallback to `[("untitled", markdown)]` at `worker/lib/chunker.py:180-182` loses section structure for papers with <3 detected sections.
- Replies make up to 5 sequential LLM calls (`replies.py:188, 220-272, 282`). Batch where possible.
- `frontend/src/lib/offline-cache.ts:88-94` — clears then re-inserts annotations; partial failure loses data.

---

## Accessibility Findings (WCAG 2.1 AA)

Full details at `/projects/ficino/.review-findings/accessibility.md`. The Twitter-clone UI is the highest-risk surface and has 25 verified findings.

**High (blocks keyboard/SR users)**
- `<div onClick>` with no `role="button"` or `tabindex`: `components/Feed/ComposeBox.tsx:36-40` (user avatar), `components/Sidebar/PersonaPanel.tsx:19-22` (persona list items).
- Figure lightbox at `components/Feed/PostCard.tsx:31-62` handles Escape but doesn't trap focus or return focus on close.
- `@mention` autocomplete at `PostCard.tsx:1031-1055` is a `<div>` dropdown with `<button>` items — needs `role="combobox"`, `aria-expanded`, `aria-activedescendant` on the input.
- No `aria-live` on typing indicators (`PostCard.tsx:949-965`) or optimistic sends; screen readers miss all async state.
- Gold brand `#c8a96e` on dark `#080a0f` measures ~3.8:1 (WCAG AA 1.4.3 requires 4.5:1 for text). Muted text `#7a8194` measures ~3.1:1, inactive tab color `#555d6e` measures ~2.8:1. All fail AA.

**Medium**
- No "Skip to main content" link.
- Feed posts not wrapped in a semantic list (`Feed.tsx:110-137`). Use `<ol role="feed">`.
- Heading hierarchy inconsistent — multiple views ship their own `<h1>`.
- Mobile drawer / bottom sheet have no focus trap (`Nav/MobileDrawer.tsx:41`, `WorkspaceBottomSheet.tsx:28`).
- Mobile bottom nav touch targets probably <44x44 (`App.tsx:108-133`). Measure at 375px.
- Tabs at `App.tsx:238-260` have `role="tab"` but no arrow-key handler.
- Form inputs rely on `placeholder` alone (no labels) at `ComposeBox.tsx:47-60`, `PostCard.tsx:980-1019`.
- Reduced-motion CSS (`index.css:81-87`) doesn't cover Lucide `animate-spin` icons.
- Three-dots menu missing `aria-haspopup`, `aria-expanded`, and `role="menu"` (`PostCard.tsx:401-496`).

**Live-testing addition (BUG-LIVE-03):** the Settings redesign's new `Account/AI/Content/Storage` tablist uses plain buttons/divs without `role="tab"`/`role="tablist"` or heading semantics. Same pattern as BUG-002 in `r2_sections_1_3.spec.ts:250`.

---

## LLM Safety Findings

Full details at `/projects/ficino/.review-findings/llm-safety.md`. See **C4** above for injection.

**High**
- `worker/tasks/reading_list_tasks.py:105-131` — LLM-returned `paper_id` values aren't validated against the input paper set. `paper_meta.get(pid, {})` silently returns empty dict for hallucinated IDs.
- `worker/lib/figure_describer.py:86-99` — parser falls back to `text[:500]` on malformed vision output; that raw text then flows into feed figure prompts.
- `worker/tasks/summary_tasks.py:131-136` — no explicit `max_tokens` cap; multi-paper synthesis is unbounded.
- `worker/lib/claude_client.py:34, 56` — 300s / 120s Ollama timeouts with no exponential backoff; a flaky Ollama stalls the worker queue.

**Medium**
- `worker/lib/claude_client.py:87-129` — `_parse_post_json()` falls back to wrapping raw text on JSON parse failure; no Pydantic validation.
- Metadata extraction doesn't strictly validate types (`worker/lib/metadata_extractor.py:70-76`).
- When per-persona chunks are empty, the persona silently drops its post (`persona_tasks.py:309-310`).

---

## Code Quality Findings

Full details at `/projects/ficino/.review-findings/code-quality.md`.

**High**
- **C7 above** — services stubs.
- `api/models/feed.py:11` — `post_type: str` with no `Literal[…]` union; TS types are strict, API is not. Schema drift is guaranteed.
- `api/models/feed.py:56` — `posts: list[dict[str, object]]`. Stored shape is unvalidated; LLM can write anything.
- Engagement numbers duplicated as `random.randint(…)` in two places (`persona_tasks.py:392-395` and `556-559`). Move to `api/constants.py`.
- Module-global `_personas_cache` at `worker/lib/persona.py:45-65` with no invalidation — persona updates require worker restart.
- **Zero Python unit tests.** `/projects/ficino/tests/` has only `e2e/` and `results/`. All behavior is verified via Playwright only.

**Medium**
- `replies.py:191-193, 511` — all exceptions funnel into a single opaque HTTP 500.
- `worker/tasks/persona_tasks.py:230` calls `persona_lib.retrieve_for_persona(...)`; `persona_tasks.py:508` calls `retrieval.retrieve_for_persona(...)`. Two functions, different caching/weighting, depending on whether you're initial-generating or regenerating. Unify.
- `frontend/src/hooks/useFeed.ts:61-95` — polling closure can fire `setState` on an unmounted component; no AbortController.
- `frontend/src/hooks/useWorkspaces.ts:40-43` — `switchTo()` sets localStorage but doesn't refetch workspace-scoped context.
- `worker/tasks/ingestion_tasks.py:31-59` — paper-status updates aren't wrapped in a transaction; concurrent updates can overwrite.
- `worker/lib/retrieval.py:19-25` — hybrid search weights (`VECTOR_WEIGHT=0.7`, `KEYWORD_WEIGHT=0.3`) are module constants, not user settings.

---

## Dependency Findings

Full details at `/projects/ficino/.review-findings/dependencies.md`.

**Note on tooling:** `pip-audit` and `npm audit` were blocked by the sandbox. All CVE claims below are from static lockfile inspection against known advisories through 2026-01; re-run with live tooling before relying on them.

**High (vulnerable lower bounds — all requirements use `>=` with no ceiling)**
- `python-multipart>=0.0.6` permits CVE-2024-24762 and CVE-2024-53981. Pin `>=0.0.18`.
- `Pillow>=10.0.0` permits CVE-2023-50447 (RCE) and CVE-2024-28219. Pin `>=10.3.0`.
- `pymupdf>=1.23.0` permits CVE-2024-8722. Pin `>=1.24.10`.
- `fastapi>=0.104.0` permits older Starlette with CVE-2024-47874. Pin `>=0.115`.

**Medium**
- `lucide-react` pinned to `^1.8.0`, lockfile resolves to `1.8.0`. The modern lucide-react line is `0.4xx.x`; `1.8.0` is a legacy series. Investigate whether this is intentional.
- `openai` in `worker/requirements.txt` — no `import openai` anywhere under `worker/`. Likely unused.
- `react-router-dom@7.14.0` in `frontend/package.json` — no imports of `Routes`, `useNavigate`, `Link`. Likely unused.

**Clean**
- License compatibility with project's AGPL-3.0 — all deps permissive, no conflicts.
- Pydantic v1→v2 migration — clean.
- Tailwind v3→v4 migration — clean.
- SQLAlchemy not present — no ORM mixing.

---

## Playwright Test Results

Full report at `/projects/ficino/.review-findings/playwright.md`.

**Environment:** live deployed instance at `https://ficino.local/ficino`, all 5 containers healthy, corpus of 2 papers / 6 personas / 15-post feed, `AUTH_PROVIDER=none`.

**Existing suite (ran on desktop, one mobile project):**
- `r2_*` desktop: 83 pass / 6 fail / 6 did-not-run (serial blocks)
- `r2_sections_17_18` mobile: **15/15 pass**
- legacy `sections_*` desktop: 64 pass / 8 fail / 6 did-not-run

Every failure is selector/label drift from three recent feature commits, not a product regression:
- "Upload PDF" → "Upload PDFs" (multi-file upload)
- `placeholder="Post your reply..."` → `"Post your reply... (@ to mention)"`
- `aria-label="Repost"` → `"Pass to persona"` (Conductor rename)
- `aria-label="Bookmarks"` → `"Saved"`
- Settings redesigned: LLM Provider is now inside an `AI` sub-tab

**Augmentation suite (25 new tests at `tests/e2e/aug/augment.spec.ts`):** 22/25 pass; the 3 failures produced real findings (BUG-LIVE-01, -02, -03). Screenshots at `tests/screenshots/aug_*.png`.

**Bugs discovered during live testing** (full repro steps and log excerpts in the stash file):

- **BUG-LIVE-01 (Medium)** — Malformed PDF upload shows no user-visible error; worker retries 3× with `FileDataError`, then leaks `Task exception was never retrieved` + `Event loop is closed`. API correctly stores `status=error` but the frontend upload zone doesn't surface it. Evidence: `tests/screenshots/aug_20_bad_pdf.png` + worker logs.
- **BUG-LIVE-02 (Low UX / High test-maintenance)** — Feed generation holds an open HTTP connection (likely progress polling/SSE) for the full ~28s server duration, so Playwright's `networkidle` and `page.screenshot({ fullPage: true })` both hang past the 60s test timeout. User-visible impact is minor (spinner stays up), but every E2E that clicks Generate and then screenshots is brittle.
- **BUG-LIVE-03 (Low functional / Medium a11y)** — Settings redesign hides LLM Provider behind an `AI` sub-tab; new `Account/AI/Content/Storage` tablist uses plain buttons/divs with no `role="tab"` or heading semantics.
- **BUG-LIVE-04 (Medium, if unintentional)** — "Group Chats" tab in Messages is not rendered at the live corpus size. Either a feature gate (then document it and update specs) or a regression.
- **BUG-LIVE-05 (Test maintenance)** — Label/placeholder drift listed above. Not a product bug; specs need updating.
- **BUG-LIVE-06 (Low but noisy)** — Pre-existing `RuntimeError('Event loop is closed')` from leaked httpx futures in the worker, surfaced and aggravated by BUG-LIVE-01.

**Confirmed working under live test:** feed + scroll + reply composer + `@mention` autocomplete (3+ persona options surface), XSS-safe reply input (`window.__xss` stays false), bookmark toggle + persistence across nav, double-click like debounce, back-navigation, Explore search, Messages, Alerts, PWA (manifest + SW + offline app shell), 1440/768/375 viewports with no horizontal overflow, mobile bottom nav at 375px.

**Not tested, with reasons:** real PDF upload (no fixture, shared instance), "Get their take" (would burn 3 LLM calls), Supabase/basic auth paths (would disrupt live env), clipboard APA/MLA (user-gesture permission), empty-corpus generate (requires deleting live papers).

---

## Verification corrections

Where the Phase 1 agents overstated or miscited. I re-verified each of these against source:

1. **Anthropic API key "committed to repo"** (security agent): **False.** `.gitignore:2` has `.env`; `git ls-files .env` returns nothing. The key is on local disk only. Revised severity: Medium local-disk exposure, not Critical public exposure.
2. **`paper_tags.paper_id` missing index** (performance agent): **False.** `init.sql:64` is `PRIMARY KEY (paper_id, tag_id)`, which creates a composite B-tree with `paper_id` as leading column. The N+1 concern in `papers.py:103-133` stands; the missing-index framing does not.
3. **"Post ID collision in append mode"** (bug-hunter): **Partially correct.** The precise behavior is ID gaps within a single call (when `continue` skips a post) and potential collisions in append mode if a prior feed itself had skipped IDs. Downgraded from "collision" to "gaps, sometimes collisions".
4. **Agent labels for "IDOR on messages / replies"** were called Medium; orchestrator promoted them to High/Critical alongside the feed+papers IDOR because they share a common auth-missing pattern and shipping `AUTH_PROVIDER=supabase` without fixing them all would be a single failure class.

---

## Recommendations

### Pre-beta (must-fix before `AUTH_PROVIDER≠none` at ficino.ai)

1. Add `Depends(get_current_user)` + `WHERE user_id = $n` (or join through `feeds`) to every endpoint listed in **C1**. Ship a test that asserts 401 for each when anonymous.
2. Add HNSW pgvector index via migration (**C3**).
3. Fix `generate_feed` retry idempotency (**C2**) — store `self.request.id` in feed row, no-op on match.
4. Add `%PDF-` magic-byte check to upload + surface `status=error` in the upload UI (**C5** + **BUG-LIVE-01**).
5. Sanitize chunk content before prompt interpolation in all four identified sites (**C4**).
6. Move the Anthropic API key out of the local `.env` into a secret manager or CI-injected env (**C6-adjacent**). No git purge needed.
7. Bump vulnerable pip floors: `python-multipart>=0.0.18`, `Pillow>=10.3.0`, `pymupdf>=1.24.10`, `fastapi>=0.115`.
8. Set cookie `secure=True` in prod (`auth/basic_routes.py:63-70, 95-102`).
9. Rate-limit `/auth/register` and `/auth/login`.
10. Fix color contrast for `gold`, `text-muted`, and `tab-inactive` tokens in `index.css:7-24` so WCAG AA passes in both themes.

### Pre-production (should-fix before public launch)

- Implement focus management (trap + return) in figure lightbox, mobile drawer, bottom sheet.
- Add ARIA combobox pattern to `@mention` autocomplete and `role="tab"` to Settings tablist.
- Wrap feed posts in `<ol role="feed">` with `<li>` children; add a skip link.
- Memoize `PostCard` and introduce `react-window` virtualization.
- Normalize feed posts into a `feed_posts` table with `tsvector` index; rewrite `search.py` to push filtering to SQL.
- Wrap `UPDATE` operations on `feeds.posts` and paper status in transactions to close the read-modify-write races.
- Batch LLM calls in `replies.py` (main + mentions + interjection).
- Validate `Literal` post types on `PostBase`; validate stored `Feed.posts` against a Pydantic union.
- Fix Post ID generation to use `len(posts)` instead of loop index (`persona_tasks.py:346`).
- Invalidate the persona prompts cache on DB update (TTL or pubsub).
- Update the Playwright suite for label drift (one-line selector fixes); gate `Group Chats` tab assertions behind a precondition.

### Post-launch (should-fix opportunistically)

- Implement or delete the `api/services/*.py` stubs.
- Add a Python unit-test suite (`tests/unit/`) targeting persona planning, contradiction detection, hybrid search, and idempotency guards.
- Tunable hybrid-search weights in user settings.
- Remove likely-unused deps: `openai` (worker), `react-router-dom` (frontend).
- Investigate `lucide-react@^1.8.0` pin — probably wrong package line.
- Resolve leaked-future warnings in worker logs (BUG-LIVE-06) by standardizing on the `worker/lib/db.py` persistent-loop pattern for `httpx.AsyncClient` lifecycles.
- Code-split heavy routes (Messages, ReadingLists, PersonaProfile) via `vite.config.ts` manualChunks.
- Add `aria-live` regions for toasts and optimistic sends.
- Heading hierarchy cleanup; one `<h1>` per view.
- Explicit `worker_concurrency` and `broker_pool_limit` on Celery.

---

## Appendix: finding provenance

All Phase 1 findings are stashed at `/projects/ficino/.review-findings/`:
- `bugs.md` — 18 findings (bug-hunter)
- `security.md` — 17 findings (security-auditor)
- `performance.md` — 17 findings (performance-reviewer)
- `accessibility.md` — 25 findings (accessibility-auditor)
- `code-quality.md` — 16 findings (code-quality-reviewer)
- `dependencies.md` — 10 findings (dependency-auditor)
- `llm-safety.md` — 14 findings (llm-safety-reviewer)
- `playwright.md` — Phase 2 live test report with 6 new bugs (BUG-LIVE-01 … 06)

Screenshots and traces: `/projects/ficino/tests/screenshots/aug_*.png` (25 new) and `/projects/ficino/tests/results/<test-name>/` (per-failure).
