# Ficino Remediation Plan

Companion to `FICINO_CODE_REVIEW.md`. Every finding from the 7 static agents + Phase 2 live tests appears here with a phase, file:line, sketch of the fix, and rough effort. Total: 123 items across 6 phases.

**Legend:** effort is for one engineer familiar with the code. `15m`/`30m`/`1h`/`2h`/`4h`/`1d`/`2d`/`3d`. Phase totals at the end of each section.

**Stream tags** let you parallelize across people: `[api]` `[worker]` `[frontend]` `[schema]` `[ops]` `[a11y]` `[tests]` `[deps]`.

**Finding IDs** reference `/projects/ficino/.review-findings/*.md` — `sec-3` = security finding #3, `bug-5` = bugs #5, `perf-1` = performance #1, `a11y-10`, `cq-2` = code-quality, `dep-1`, `llm-4`, `live-2` = Playwright live bugs.

---

## Phase 0 — Hygiene (day 0, before any code changes)

**Goal:** stop the bleed on known-vulnerable dependency floors and secret-on-disk exposure. No behavior changes.
**Gate:** `pip-audit` and `npm audit` run clean (once tooling is unblocked); API key no longer sits in `env_file: .env` at the docker-compose level.
**Parallel:** `[deps]` and `[ops]` are independent of each other.

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 0.1 | Move Anthropic API key out of `.env`; inject via CI/secret manager; remove `env_file: .env` dependency for secrets | `.env`, `docker-compose.yml:9` | 30m `[ops]` | sec-1 (corrected) |
| 0.2 | Pin `python-multipart>=0.0.18` | `api/requirements.txt` | 5m `[deps]` | dep-1 |
| 0.3 | Pin `Pillow>=10.3.0` | `worker/requirements.txt` | 5m `[deps]` | dep-2 |
| 0.4 | Pin `pymupdf>=1.24.10` | `worker/requirements.txt` | 5m `[deps]` | dep-3 |
| 0.5 | Pin `fastapi>=0.115` | `api/requirements.txt` | 5m `[deps]` | dep-4 |
| 0.6 | Convert all `>=` to `~=` or exact pins to prevent drift; regenerate a pip-tools lockfile | both `requirements.txt` | 1h `[deps]` | dep-5 |
| 0.7 | Run `pip-audit` + `npm audit` once sandbox/CI allows and file any new CVEs | CI | 30m `[deps]` | dep (tooling) |
| 0.8 | Add a pre-commit hook (or CI step) that blocks committing `.env` and any `sk-*` / `ANTHROPIC_*` pattern | `.pre-commit-config.yaml` | 30m `[ops]` | sec-1 |

**Phase 0 total: ~3h.**

---

## Phase 1 — Pre-beta blockers (week 1)

**Goal:** make `AUTH_PROVIDER≠none` safe to ship to ficino.ai.
**Gate:** all critical + auth-gating high findings closed; regression tests in place for IDOR + injection + idempotency.
**Parallel streams:** `[api]` (auth/IDOR), `[schema]` (pgvector index), `[worker]` (idempotency + prompt sanitization), `[a11y]` (contrast tokens — no dependency on backend).

### 1A. IDOR cluster — [api]

Single PR, one pattern applied across files. Add `user: AuthUser = Depends(get_current_user)` + scope SQL by `user_id` (or join via `feeds.user_id`).

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 1.1 | `GET /feed/{feed_id}` | `api/routers/feed.py:96-126` | 20m | sec-2 |
| 1.2 | `DELETE /feed/{feed_id}/posts/{post_index}` | `api/routers/feed.py:129-156` | 20m | sec-2 |
| 1.3 | `POST /feed/{feed_id}/regenerate/{post_index}` | `api/routers/feed.py:159-179` | 20m | sec-2 |
| 1.4 | `GET /papers` list | `api/routers/papers.py:96-133` | 20m | orchestrator addition |
| 1.5 | `GET /papers/{paper_id}` | `api/routers/papers.py:161-193` | 20m | sec-3 |
| 1.6 | `GET /{paper_id}/figures` | `api/routers/papers.py:233-256` | 20m | sec-3 (same pattern) |
| 1.7 | `GET /messages/papers` | `api/routers/messages.py:26-52` | 20m | sec-6 |
| 1.8 | `GET /replies/conversations`, `GET /replies/{feed_id}/{post_index}`, `GET /replies/replied-posts/{feed_id}`, `POST /replies` | `api/routers/replies.py:37-88, 91-108, 78-88, 111+` | 1h | sec-7 |
| 1.9 | Audit every other router for the same anti-pattern (`annotations`, `bookmarks`, `likes`, `tags`, `citations`, `alerts`, `reading_lists`, `user_posts`, `settings`, `search`) | `api/routers/*.py` | 2h | orchestrator sweep |
| 1.10 | Test: for each endpoint above, assert 401 anonymous + 403 wrong-user | `tests/unit/test_auth_scoping.py` (new) | 2h `[tests]` | coverage for 1.1–1.9 |

### 1B. Idempotency + correctness — [worker]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 1.11 | Idempotency token on `generate_feed` append: store `self.request.id` in feed row; no-op on match | `worker/tasks/persona_tasks.py:152-157, 409-417` | 3h | cq-1 |
| 1.12 | Fix post ID assignment to use `id_offset + len(posts) + 1` after each append | `worker/tasks/persona_tasks.py:346` | 30m | bug-1, bug-7 |

### 1C. Prompt injection + input safety — [worker] + [api]

Single utility: `worker/lib/sanitize.py` with `fence_untrusted(text)` that strips role markers (`^(System:|Human:|Assistant:)`), escapes backticks/XML-like tokens, caps length, and wraps in `<untrusted>…</untrusted>` tags. Call at every interpolation site.

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 1.13 | New `worker/lib/sanitize.py` + tests | new | 2h | llm-1 infra |
| 1.14 | Apply to persona chunk blocks | `worker/lib/persona.py:131-133` | 30m | llm-1 |
| 1.15 | Apply to Archivist system prompt | `worker/tasks/archivist_tasks.py:94-100` | 30m | llm-3 |
| 1.16 | Apply to contradiction classifier | `worker/lib/claude_client.py:149-161` | 30m | llm-2 |
| 1.17 | Apply to reply mention / conductor prompt (user_message) | `api/routers/replies.py:230-252` | 30m | llm-4 |
| 1.18 | PDF upload: `%PDF-` magic-byte check | `api/routers/papers.py:38` | 15m | sec-8 |
| 1.19 | Frontend: show `status=error` and `error_message` in upload zone (fixes BUG-LIVE-01 UX half) | `frontend/src/components/Nav/CorpusPanel.tsx` (or upload zone component) | 2h `[frontend]` | live-1, sec-8 |

### 1D. Auth surface — [api]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 1.20 | Session cookie `secure=True` in prod (gated by `settings.environment`) | `api/auth/basic_routes.py:63-70, 95-102` | 15m | sec-4 |
| 1.21 | Logout deletes server-side Redis session via `delete_session(token)` | `api/auth/basic_routes.py:108-117` | 30m | sec-5 |
| 1.22 | Apply `RateLimit` to `/auth/login` (5/15m) and `/auth/register` (3/hour) | `api/auth/basic_routes.py:27-105`, reuse `api/auth/rate_limit.py` | 30m | sec-13 |

### 1E. pgvector index — [schema]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 1.23 | New migration script `infra/postgres/add_hnsw_index.sql` with `CREATE INDEX … USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)` — run on existing DBs via `migrate_personas_v3.py`-style bootstrap | new | 2h | perf-1 |
| 1.24 | Update `infra/postgres/init.sql:82` comment to point to the migration | `init.sql:82` | 5m | perf-1 |

### 1F. Contrast (universal user impact) — [a11y]

Tokens only, no component changes.

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 1.25 | Lighten `--color-gold` for dark mode to pass 4.5:1 on `#080a0f` (proposed: `#d9ba7a`) | `frontend/src/index.css:7` | 1h (measure + adjust) | a11y-6 |
| 1.26 | Lighten `--color-text-muted` to pass AA on both themes | `frontend/src/index.css:10` | 30m | a11y-9 |
| 1.27 | Lighten `--color-tab-inactive` | `frontend/src/index.css:24` | 15m | a11y-10 |
| 1.28 | Remove the `/50` opacity from placeholder styles (use full muted token) | grep `placeholder:text-text-muted/50` | 30m | a11y-8 |

**Phase 1 total: ~22h ≈ 3 engineer-days, or 1 calendar week with the parallel streams.**

---

## Phase 2 — Pre-production (weeks 2–3)

**Goal:** every remaining High and the most visible Medium fixed before public launch.
**Gate:** axe-core clean on main feed/compose/lightbox/modals; Playwright suite green after selector updates; concurrent-access tests don't lose writes.

### 2A. Frontend a11y (keyboard + SR) — [a11y] [frontend]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 2.1 | Convert `<div onClick>` in `ComposeBox` user avatar to `<button>` with `aria-label` | `frontend/src/components/Feed/ComposeBox.tsx:36-40` | 15m | a11y-1 |
| 2.2 | Convert persona panel clickable divs to `<button role="menuitem">` | `frontend/src/components/Sidebar/PersonaPanel.tsx:19-22` | 30m | a11y-2 |
| 2.3 | Add focus trap + return-focus to `FigureLightbox` | `frontend/src/components/Feed/PostCard.tsx:31-62` | 2h | a11y-3 |
| 2.4 | Add focus trap + return-focus to `MobileDrawer`, `WorkspaceBottomSheet`, any other `role="dialog"` | `frontend/src/components/Nav/MobileDrawer.tsx:41`, `WorkspaceBottomSheet.tsx:28` | 2h | a11y-15 |
| 2.5 | Build a reusable `useFocusTrap` hook; refactor 2.3/2.4 to use it | `frontend/src/hooks/useFocusTrap.ts` (new) | 2h | a11y infra |
| 2.6 | `@mention` combobox ARIA pattern: `role="combobox"`, `aria-expanded`, `aria-activedescendant`, arrow-key + Enter/Tab commit | `frontend/src/components/Feed/PostCard.tsx:1031-1055, 980` | 4h | a11y-4 |
| 2.7 | Three-dots menu: `aria-haspopup`, `aria-expanded`, `role="menu"` on container, `role="menuitem"` on items | `frontend/src/components/Feed/PostCard.tsx:401-496` | 1h | a11y-5, a11y-22 |
| 2.8 | `aria-live="polite"` regions for typing indicator, optimistic send, toasts | `PostCard.tsx:949-965, 1064-1068`, `ComposeBox.tsx` | 2h | a11y-6, a11y-25 |
| 2.9 | Wrap feed posts in `<ol role="feed">` with `<li>` children | `frontend/src/components/Feed/Feed.tsx:110-137` | 1h | a11y-11 |
| 2.10 | Add "Skip to main content" link + matching `<main id="main">` | `frontend/src/App.tsx` (header) | 30m | a11y-12 |
| 2.11 | Form labels (visible or sr-only) for all inputs using `placeholder` only | `ComposeBox.tsx:47-60`, `PostCard.tsx:980-1019`, Settings inputs | 2h | a11y-18 |
| 2.12 | `aria-label` on `Toggle` wired from parent `SettingRow`'s label | `components/Settings/primitives.tsx:47-62` | 1h | a11y-19 |
| 2.13 | Mobile bottom-nav touch targets ≥44x44 (increase `py`) | `App.tsx:108-133` | 30m | a11y-20 |
| 2.14 | Make focus outline readable in light mode (thicker or different color) | `frontend/src/index.css:70-78` | 30m | a11y-17 |
| 2.15 | Settings tablist: real `role="tab"`/`role="tablist"`/`aria-selected` (fixes live-3 a11y half) | Settings view components | 2h | live-3 |

### 2B. Performance hot paths — [frontend] [schema] [api]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 2.16 | `React.memo(PostCard, (a, b) => a.post.id === b.post.id && a.liked === b.liked && a.bookmarkedId === b.bookmarkedId)` | `frontend/src/components/Feed/PostCard.tsx:179` | 1h (plus profiling) | perf-6 |
| 2.17 | Feed virtualization with `react-window`/`@tanstack/react-virtual` | `frontend/src/components/Feed/Feed.tsx:110-137` | 4h | perf-7 |
| 2.18 | Foreign-key indexes migration: `chunks(paper_id)`, `figures(paper_id)`, `bookmarks(user_id)` | new `infra/postgres/add_fk_indexes.sql` | 30m | perf-10 |
| 2.19 | Normalize feed posts: `feed_posts(feed_id UUID, post_index INT, content_text TEXT, persona TEXT, post_type TEXT, category TEXT, data JSONB, tsv tsvector generated)` + GIN index + trigger | new `infra/postgres/add_feed_posts_table.sql` + writer change in `persona_tasks.py` + reader change in `feed.py`/`search.py` | 2d `[schema][worker][api]` | perf-2, perf-4, perf-15 |
| 2.20 | Rewrite `search.py` to push filtering to SQL using the new table | `api/routers/search.py:80-105` | 3h | perf-4 |
| 2.21 | Two-stage retrieval (vector top-100 → hybrid re-rank top-k) | `worker/lib/retrieval.py:61-93` | 3h | perf-5 |

### 2C. Bug fixes + correctness — [frontend] [worker] [api]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 2.22 | Await `tx.done` after all `put()`s in IndexedDB caches | `frontend/src/lib/offline-cache.ts:30-35` | 30m | bug-2 |
| 2.23 | Replace bidirectional substring title match with normalized exact match | `worker/lib/retrieval.py:155` | 1h | bug-3 |
| 2.24 | Break `refresh` dependency cycle in `useWorkspaces` | `frontend/src/hooks/useWorkspaces.ts:34` | 30m | bug-5 |
| 2.25 | Fix `usePersonas` async `.catch` chain so final rejection is caught | `frontend/src/hooks/usePersonas.ts:20` | 15m | bug-4 |
| 2.26 | Fix chunk-window off-by-one when `len(chunks) == window_size` | `worker/tasks/persona_tasks.py:318-321` | 30m | bug-6 |
| 2.27 | Atomic soft-delete on feed posts: UPDATE with a `FOR UPDATE` lock or use `jsonb_set` with a WHERE guard | `api/routers/feed.py:140-155` | 1h | bug-8 |
| 2.28 | Replace bare `asyncio.run()` in embedder with the persistent-loop pattern from `db.py` | `worker/lib/embedder.py:154, 162` | 1h | bug-12 |
| 2.29 | Paper-status updates wrapped in transaction with row lock | `worker/tasks/ingestion_tasks.py:31-59` | 2h | cq-14 |
| 2.30 | `Literal[…]` `post_type` on `PostBase` + child classes | `api/models/feed.py:11, 21, 26, 31, 37` | 1h | cq-2 |
| 2.31 | Validate `Feed.posts` against union of post models (or at minimum a Pydantic v2 discriminated union) | `api/models/feed.py:56` + writer validation in `persona_tasks.py` | 3h | cq-5, llm-9 |

### 2D. LLM output validation — [worker]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 2.32 | Validate `paper_id` values returned by reading-list ordering against input set; reject/fill missing | `worker/tasks/reading_list_tasks.py:105-131` | 1h | llm-5 |
| 2.33 | Strict parsing of figure-description output (require both DESCRIPTION and CLAIM, validated lengths); log + skip on failure instead of `text[:500]` fallback | `worker/lib/figure_describer.py:86-99` | 1h | llm-6 |
| 2.34 | Explicit `max_tokens` on summary/synthesis calls | `worker/tasks/summary_tasks.py:131-136` | 30m | llm-7 |
| 2.35 | Log only shape/length on JSON parse failure; move content preview to debug sink | `worker/lib/claude_client.py:128` | 30m | llm-13, sec C6 |

### 2E. Security hardening (non-auth) — [api]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 2.36 | Store filenames not paths for figures; restrict serving via signed endpoint rather than raw `StaticFiles` | `api/routers/papers.py:249`, `api/main.py:121` | 4h | sec-9 |
| 2.37 | Restrict CORS `allow_headers` to explicit list in prod | `api/main.py:73` | 15m | sec-12 |
| 2.38 | Explicit `bcrypt.gensalt(rounds=12)` | `api/auth/basic_routes.py:45` | 5m | sec-11 |

### 2F. Test-suite maintenance — [tests]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 2.39 | Update all Playwright specs for label drift: `Upload PDFs`, `Post your reply...` prefix, `Pass to persona`, `Saved` | `tests/e2e/**/*.spec.ts` | 2h | live-5 |
| 2.40 | Gate "Group Chats" tab assertions behind precondition OR investigate why it's not rendering at small corpus size — fix or document | `api/routers/messages.py`, `frontend/src/components/Messages/*` | 2h | live-4 |
| 2.41 | Refactor Section 14 spec to click into `AI` sub-tab before asserting LLM Provider | `tests/e2e/*sections_14_16.spec.ts` | 30m | live-3 test half |
| 2.42 | `waitUntil: 'domcontentloaded'` + no fullPage screenshots during Generate in flight; optionally `page.route` stub for button-state tests | `tests/e2e/**/*.spec.ts` | 1h | live-2 |
| 2.43 | Investigate `lucide-react` `^1.8.0` — confirm whether it's the intended package/version; swap to modern `0.4xx.x` if not | `frontend/package.json` | 1h | dep-6 |

**Phase 2 total: ~50h ≈ 6–8 engineer-days, or 2 calendar weeks with 2–3 parallel streams.**

---

## Phase 3 — Launch polish (weeks 4–5)

**Goal:** everything remaining Medium that isn't a blocker; paid-down LLM-reliability work; test coverage stood up.
**Gate:** Ollama fallback tested; worker's event-loop-closed warnings eliminated; a Python unit suite runs in CI.

### 3A. Worker reliability + LLM — [worker]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 3.1 | Exponential backoff wrapper for Ollama calls; separate connection-errors from HTTP errors | `worker/lib/claude_client.py:34, 56` | 3h | llm-8 |
| 3.2 | Persona cache TTL (3600s) + optional Redis pubsub invalidation on persona update | `worker/lib/persona.py:45-65, 100-103` | 2h | cq-6 |
| 3.3 | Unify `retrieve_for_persona` callsites to single module | `worker/tasks/persona_tasks.py:230, 508` | 1h | cq-10 |
| 3.4 | Pydantic model for metadata extraction with strict types + year range | `worker/lib/metadata_extractor.py:70-76` | 1h | llm-10 |
| 3.5 | Track figure-extraction failure rate; error log when >50% fail | `worker/tasks/ingestion_tasks.py:223-238` | 1h | cq-13 |
| 3.6 | Standardize event-loop lifecycle in worker `httpx` clients; fix `Event loop is closed` warnings | `worker/lib/claude_client.py` + `db.py` pattern | 3h | live-6, cq-9 |
| 3.7 | Remove unreachable `raise` after `self.retry()` | `worker/tasks/persona_tasks.py:467-469` | 15m | bug-9 |
| 3.8 | `None`-guard on `persona_key` derived from `old_post` | `worker/tasks/persona_tasks.py:306, 498` | 15m | bug-10 |
| 3.9 | Stop silently dropping posts when persona chunks are empty — generate a "no relevant content" placeholder or drop persona from plan earlier | `worker/tasks/persona_tasks.py:309-310` | 1h | llm-11 |
| 3.10 | Raise or mark degraded when contradiction detection swallows exceptions | `worker/tasks/persona_tasks.py:103-116` | 30m | sec-17 |
| 3.11 | Throttle between OpenAI embedder batches (match Voyage pattern) | `worker/lib/embedder.py:58-62` | 30m | perf-11 |
| 3.12 | Chunker fallback: lower threshold or better regex before `[("untitled", markdown)]` | `worker/lib/chunker.py:180-182` | 2h | perf-12 |
| 3.13 | Batch LLM calls in `create_reply` (main + mentions + interjection) | `api/routers/replies.py:188, 220-272, 282` | 4h | perf-13 |

### 3B. API quality — [api]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 3.14 | Typed exception-to-HTTPException mapping (TimeoutError→504, ValueError→400) | `api/routers/replies.py:191-193, 511` | 2h | cq-8 |
| 3.15 | Guard empty `paper_ids` in reading_lists | `api/routers/reading_lists.py:103-107` | 15m | sec-14 |
| 3.16 | Move hardcoded engagement ranges to `api/constants.py` | `worker/tasks/persona_tasks.py:392-395, 556-559`, `api/constants.py` | 30m | cq-3 |
| 3.17 | Length bound on `ZapRequest.source_message` (`Field(max_length=2000)`) | `api/routers/replies.py:32` | 15m | llm-14 |

### 3C. Frontend correctness + hygiene — [frontend]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 3.18 | `AbortController`/mounted-ref for `useFeed` polling | `frontend/src/hooks/useFeed.ts:61-95` | 1h | bug-14, cq-11 |
| 3.19 | Copy-on-write Map in `useAnnotations` | `frontend/src/hooks/useAnnotations.ts:6` | 30m | bug-13 |
| 3.20 | Catch on `useCorpus.refresh` promise chain | `frontend/src/hooks/useCorpus.ts:52-54` | 15m | bug-11 |
| 3.21 | Await `getAllKeys` properly in offline cache | `frontend/src/lib/offline-cache.ts:172-175` | 15m | bug-16 |
| 3.22 | Upsert-by-key instead of `clear()` + loop in `cacheAnnotations` | `frontend/src/lib/offline-cache.ts:88-94` | 30m | perf-14 |
| 3.23 | Bump IndexedDB schema version constant and wire upgrade path | `frontend/src/lib/offline-db.ts:68` | 1h | bug-17 |
| 3.24 | `switchTo` refetches workspace-scoped data | `frontend/src/hooks/useWorkspaces.ts:40-43` | 30m | cq-12 |
| 3.25 | Null-safe status check in `useCorpus` polling filter | `frontend/src/hooks/useCorpus.ts:59` | 5m | bug-15 |

### 3D. A11y remaining + heading hierarchy — [a11y]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 3.26 | One `<h1>` per view; downgrade in-view section titles to `<h2>`/`<h3>` | `SettingsView`, `Inbox`, `AlertsView`, Feed header | 2h | a11y-13 |
| 3.27 | FeedTabs arrow-key navigation handler | `App.tsx:238-260` | 1h | a11y-14 |
| 3.28 | Avatar `alt` text audit (all usages consistent; decorative → `alt=""`) | `PostCard.tsx:75-80, 847`, others | 1h | a11y-16 |
| 3.29 | Reduced-motion: conditional `animate-spin` via CSS var | `frontend/src/index.css:81-87`, Loader2 usages | 2h | a11y-21 |
| 3.30 | Icon-only button aria-label sweep | grep `<Icon` inside `<button>` | 1h | a11y-23 |
| 3.31 | Mobile logo `<img onClick>` → `<button>` with aria-label | `App.tsx:180-185` | 15m | a11y-24 |

### 3E. PWA + ops — [frontend] [ops]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 3.32 | Explicit `maxAgeSeconds` on figure-cache runtime strategy; confirm other runtime caches have both bounds | `frontend/vite.config.ts:29-34` | 15m | perf-9 |
| 3.33 | `manualChunks` for Messages / ReadingLists / PersonaProfile | `frontend/vite.config.ts` | 1h | perf-17 |
| 3.34 | Celery: explicit `worker_concurrency`, `broker_pool_limit`, `worker_max_tasks_per_child` | `worker/celery_app.py:21` | 30m | perf-8 |
| 3.35 | UUID validation on `corpus_id` before query | `api/routers/feed.py:37`, shared validator | 30m | bug-18 |

### 3F. Unit test scaffold — [tests]

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 3.36 | `tests/unit/test_persona_tasks.py`: feed plan, post ID assignment, idempotency | new | 1d | cq-7 (partial) |
| 3.37 | `tests/unit/test_retrieval.py`: hybrid search boundaries, empty chunks | new | 1d | cq-7 |
| 3.38 | `tests/unit/test_sanitize.py`: prompt-injection regression fixtures | new | 1d | llm-1 infra |
| 3.39 | CI: run unit suite on PR | `.github/workflows/*.yml` | 2h | ops |

**Phase 3 total: ~45h ≈ 6 engineer-days.**

---

## Phase 4 — Post-launch hardening (ongoing, ticketed)

**Goal:** everything remaining plus nice-to-haves. Ship per-ticket on regular cadence.

| # | Item | File:line | Effort | Ref |
|---|------|-----------|--------|-----|
| 4.1 | Implement or delete `api/services/*.py` stubs | `api/services/persona.py:6`, `retrieval.py:6`, `ingestion.py:6` | 1d (delete) or 3d (implement) | cq-4 |
| 4.2 | Remove unused deps: `openai` (worker), `react-router-dom` (frontend) after confirming | `worker/requirements.txt`, `frontend/package.json` | 1h | dep-7 |
| 4.3 | Per-persona temperature stored in `personas` table | schema + `claude_client.py:74-82` | 4h | llm-12, cq-15 |
| 4.4 | Tunable hybrid-search weights in user settings | `worker/lib/retrieval.py:19-25`, `api/routers/settings.py` | 3h | cq-15 |
| 4.5 | Document/de-magic the oversample ratio | `worker/tasks/persona_tasks.py:93`, `api/constants.py` | 15m | cq-16 |
| 4.6 | Audit log for destructive operations (delete paper, delete workspace, bulk unbookmark) | new `audit_log` table + middleware | 1d | sec-16 |
| 4.7 | CSRF double-submit token (defense in depth over SameSite=Lax) | `api/main.py` middleware | 1d | sec-15 |
| 4.8 | Binary vector parameter format (avoid string round-trip precision loss) | `worker/lib/retrieval.py:46-48` | 2h | perf-16 |
| 4.9 | Expand unit-test coverage to 70%+ on critical paths | `tests/unit/**` | 3-5d | cq-7 |
| 4.10 | Retire legacy `sections_*` specs once `r2_*` suite covers the same surface | `tests/e2e/sections_*.spec.ts` | 2h | tests |
| 4.11 | Document Supabase flow + basic-auth flow testing procedure | `docs/` | 2h | ops |

**Phase 4 total: ~10–15 engineer-days across the backlog.**

---

## Phase 5 — Known informational items (no action required)

Explicit "do nothing" list so these aren't re-raised later:

- License compatibility (dep-8). AGPL-3.0 project, all deps permissive. Verified.
- Pydantic v2 migration (dep-9). No v1 patterns remain.
- Tailwind v4 migration (dep-10). No legacy config; `@theme` used correctly.
- `paper_tags(paper_id)` "missing index" (perf-3 as originally framed). Covered by the composite PK; N+1 concern is absorbed into item 2.19 (feed-post normalization) and the FK index migration 2.18 — not a separate schema change.

---

## Cross-phase notes

**Schema-migration sequencing.** 1.23 (HNSW index), 2.18 (FK indexes), 2.19 (feed_posts table) are independent migrations and can land in any order, but 2.19 requires a data backfill + reader/writer change that should land behind a feature flag. Ship 1.23 + 2.18 first as they're additive and can't regress anything.

**Testing the IDOR fixes.** Item 1.10 (auth-scoping test suite) is a gate for the whole 1A block. Don't merge the individual router fixes without the tests — it's too easy to regress.

**Sanitizer in one place.** Items 1.13–1.17 all depend on a single `sanitize.py` module. Land 1.13 first, then the four application sites can be separate PRs by separate engineers.

**A11y contrast in Phase 1, everything else in Phase 2.** Contrast changes one token and has universal user impact; it's cheap and ships now. Structural a11y (combobox, focus trap, semantic list) is design-level work that needs design review and lands in Phase 2.

**Rollback plan per phase.** Phase 0 and 1 changes are all reversible via git revert. Phase 2 schema changes (2.18, 2.19) need explicit rollback migrations — write them alongside.

**Recommended engineer allocation.** With 2 engineers: one on `[api]`+`[worker]`+`[schema]`, one on `[frontend]`+`[a11y]`+`[tests]`. Phase 1 in week 1, Phase 2 in weeks 2–3, Phase 3 in weeks 4–5, Phase 4 as backlog. Total calendar: ~5 weeks to Phase 4 entry; Phase 4 on a continuous flow after launch.

---

## Summary

| Phase | Items | Effort | Calendar |
|-------|-------|--------|----------|
| 0 — Hygiene | 8 | ~3h | day 0 |
| 1 — Pre-beta | 28 | ~22h / 3d | week 1 |
| 2 — Pre-prod | 43 | ~50h / 6–8d | weeks 2–3 |
| 3 — Polish | 39 | ~45h / 6d | weeks 4–5 |
| 4 — Backlog | 11 | ~10–15d | ongoing |
| 5 — Info | 4 | 0 | — |
| **Total** | **133 addressed (123 findings + test/infra additions)** | **~30–40 engineer-days** | **~5 weeks to Phase 4** |
