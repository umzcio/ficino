# Round 10 Remediation — Design

**Date:** 2026-07-01
**Input:** `FICINO_REVIEW_R10.md` (93 unique findings: 0 CRITICAL / 8 HIGH / 43 MEDIUM / 42 LOW) and the per-area reports in `review/round10/`.
**Status:** approved design; implementation plan to follow (superpowers writing-plans).

## Decisions (settled with the maintainer)

1. **Scope: full sweep.** All 93 findings get resolved or explicitly deferred-with-reason. The DRY work is the point of the campaign, not extra credit.
2. **Shared api/worker code becomes a real package** (`shared/ficino_shared/`), not mirror-plus-identity-tests.
3. **Product calls:** build the group-chat picker modal (FE-4); keep and wire up `users.py` + surface the audit log (API-4/BP-12, pairs with BP-10); schedule `check_stale_papers` via Celery beat and fix its NULL-corpus query bug (WORK-6).
4. **Verification bar:** TDD (failing regression test first) for every bug fix; full pytest + Playwright e2e against the local Ollama compose stack at each wave gate; minimal CI added in wave 1.

## Approach

Foundation-first waves: urgent bugs first, the structural change (shared package) second, then backend, then frontend, then the mechanical sweep and a re-review. Each wave is a branch off `main`, merged before the next starts. Each *finding* is resolved in exactly one wave, and waves are ordered so later waves build on — rather than rework — earlier ones (a file may legitimately be touched by more than one wave, e.g. `settings.py` gets its drift hotfix in wave 1, consolidation in wave 2, audit coverage in wave 3).

Each wave gets its own implementation plan (superpowers writing-plans), written when the wave starts — wave 1's plan is written immediately after this spec is approved.

### Wave 1 — Stop the bleeding + safety net (`r10/wave1-highs`)

| Item | Findings | Notes |
|---|---|---|
| Fix auto-tagging import | WORK-1/DEP-1 | Add `fetch` to the `lib.db` import; narrow (or error-log) the swallowing except. TDD: test asserts `paper_tags` rows exist after ingesting a paper with metadata tags. |
| Scope podcast task | WORK-2 | `apply_provider_settings(user_id)` after the claim in `audio_tasks.py`. |
| Env-fallback key leak | WORK-3 | Semantics pinned: snapshot the operator baseline env at worker start; `apply_provider_settings` sets the user's value or restores baseline (never leaves a previous user's key). A paid provider selected with no key fails loudly. Code lands in `worker/lib/settings.py` now, migrates into the shared package in wave 2. |
| Chapter post validation | WORK-4 | Import + call `validate_post_shape` in `reading_list_tasks.py` (R9 H27). |
| Summary error re-dispatch | API-1 | Treat `status='error'` like the dead-task branch in `messages.py` (R9 H13); fix the misleading worker comment. |
| PostCard memo comparator | FE-1 | Add `isReplyLiked`/`isReplyBookmarked` to `arePostsEqual`; pin `handleIsReplyBookmarked` deps in App.tsx. |
| `idb` phantom dep | DEP-2/FE-10 | Declare `"idb": "^7.1.1"` in `frontend/package.json` (matches what the code compiles against today; a v8 upgrade is out of scope for this campaign); delete the root entry. |
| DUP-1 short-term | DUP-1 (partial) | api DEFAULTS become env-derived; allow-list becomes the worker superset. Characterization tests for GET/PUT `/settings` written first. |
| CI | DEP-8 rec. | GitHub Actions (`umzcio/ficino`): (1) `ruff check api/ worker/`; (2) api pytest with a Postgres service container (`DATABASE_URL`); (3) frontend eslint + `tsc -b` + `vite build`. Playwright stays local-only. Minimal `ruff` config committed so the rule set is pinned. |

Wave 1 also brings the local compose stack up (it is not currently running) — needed for every wave gate.

### Wave 2 — Shared package (`r10/wave2-shared`)

Resolves: DUP-1 (full), DUP-2, DUP-3, DUP-4, DUP-14, DUP-18, cross-service half of BP-8.

**Package:** `shared/ficino_shared/` at repo root; `pyproject.toml`; no dependencies beyond what both services already pin.

- `settings_schema.py` — single DEFAULTS (env-derived, worker superset), `SETTINGS_TO_ENV`, allow-list derivation, merge function, `PUBLIC_DEPLOYMENT` reassert, and the WORK-3 baseline-restore env logic. Consumers: `api/routers/settings.py`, `api/services/llm.py`, `worker/lib/settings.py`.
- `sanitize.py` — worker's superset version moved verbatim; `api/sanitize.py` and `worker/lib/sanitize.py` become 2-line re-exports (zero call-site churn).
- `signed_url.py` — moved verbatim (fix the stale 24h-TTL docstring); both sides re-export.
- `storage/` — api version canonical (it has the hardened `read_figure_bytes`); config injected via explicit init, not `api.config` import; worker re-exports. The `resolve()/relative_to` check thereby reaches the worker (DUP-2).
- `constants.py` — `STUB_USER_ID`, `DEFAULT_WORKSPACE_ID`, TTL/timeout values shared by both services (BP-8 cross-service portion), the chapter-INSERT SQL constant (DUP-18).

**Build plumbing:** compose changes to `build: {context: ., dockerfile: api/Dockerfile}` (ditto worker); Dockerfiles `COPY shared/ ./shared/` + `pip install ./shared` before the service `COPY`. Railway: each service's root directory moves to repo root (manual dashboard step) with `dockerfilePath: api/Dockerfile` / `worker/Dockerfile`.

**Step 1 of the wave (gating):** prove the Railway build on a throwaway service *before* moving any code. **Fallback** if Railway misbehaves: `scripts/sync-shared.sh` copying `shared/` into `api/_shared/` + `worker/_shared/`, with a CI job failing on divergence.

**Explicitly out of the package:** LLM routing (DUP-7 — hardening ported both ways in wave 3 instead; the async/sync split makes a forced abstraction worse), frontend constant mirrors (comment-linked literals), DB pool code (DUP-14's pool knobs get service-prefixed env names instead: `API_DB_POOL_*` / `WORKER_DB_POOL_*`, old names honored as fallback).

### Wave 3 — Backend cleanup (`r10/wave3-backend`)

Worker cluster: WORK-5 (stale `generating` claim reclaim with claim timestamp), WORK-6 (beat schedule — beat process added to compose + Railway — and the NULL-corpus feed check fix), WORK-7 (`_write_feed_posts_index` from `generate_chapter`), WORK-8 (element-shape filtering for summary/synthesis JSON), WORK-9 (3-attempt backoff for both vision page-extraction paths), WORK-17 (persona fallback restricted to feed-eligible), DUP-5 (extract `worker/lib/event_loop.py`, fixing `metadata_extractor`'s regressed lock pattern; consolidate the six `_get_config` readers into `worker/lib/settings.py`), DUP-6 (`build_post_sources` in `worker/lib/persona.py`), DUP-12 (`resolve_enabled_personas` + archivist `_get_paper_ids` helpers), DUP-7 (port Ollama 5xx retry to api, empty-response guard semantics to worker).

API cluster: API-2 (move summary rate-check to the dispatch branch), API-3 (`asyncio.to_thread` batch for signed-URL hydration), API-4 + BP-12 (wire Settings/Account to `/users/me`, implement or drop `default_corpus_id`, align conventions; audit-log view in Settings), API-5/DUP-13/BP-15 (module-level `api/celery_client.py`; delete dead `_get_redis`), API-6/BP-13 (auth-gate both endpoints), API-10 (`ON CONFLICT DO NOTHING` upserts for likes/bookmarks), API-11 (APA 20/21-author boundaries), API-12/BP-5 (pydantic model + duplicate-ID rejection for orderings), API-13 (datetime-safe sort key), API-14 (transactional `clear_all_papers`, hoist `_cleanup_artifacts`), API-15 (dispatch-before-status-write + guarded follow-up UPDATE), API-16 (atomic JSONB element delete), API-19 (Content-Length pre-check), DUP-16 (`_paper_from_row`/`_feed_from_row` helpers, unified list SQL), DUP-17/API-20 (`_load_conversation_and_sources` extraction in replies.py), BP-1/BP-2 (shared LLM-exception→status mapping; align out-of-range codes on 404), BP-3 (standardize DELETE on 204 + 404-on-missing; document intentionally-idempotent ones), BP-4 + API-7 (decision: promote the 17 inline request models into `api/models/`, add `response_model=` to list/get endpoints, delete the dead post-shape/`Chunk`/`Figure`/`PaperCreate`/`Corpus`/`User` models + `test_models.py`), BP-6 (rate-limit knobs into `Settings`; delete `generation_limit_per_day` with DEP-5), BP-10 (audit the bulk clears, workspace delete, and remaining destructive gaps), BP-14 (`search_use_normalized_posts` into `Settings`; `_escape_like` to a shared module), BP-17 (batched `unnest` inserts in reorder/apply-ordering), BP-18 (LIMIT caps hoisted to `api/constants.py`).

### Wave 4 — Frontend (`r10/wave4-frontend`)

Shared extractions first (they unblock the rest): DUP-8 (`lib/timeAgo.ts`), DUP-9 (`_shared/AsyncState.tsx` — Spinner + EmptyState), DUP-10 (`Feed/_shared/SourcesList.tsx`; Avatar gains a size prop and replaces UserPostCard's inline copies), DUP-11 (`hooks/usePollTask.ts`, modeled on the ListenView variant), DUP-19 (promote `Md` to `components/_shared/`), BP-11 (promote `Section`/`Toggle`/`Slider`/`DangerButton`/ghost-pill from `Settings/primitives.tsx` to `components/_shared/`; adopt at the cited reinvention sites), BP-9 (AuthContext consumes `lib/api.ts`'s `request()`; single `API_BASE`).

Bugs and a11y: FE-2 (auto-play sets `loadedSrcRef` — use `playAtIndex`), FE-3 (suppress global single-letter nav while Listen is active), FE-5 (try/catch/finally + error state for PaperChat/GroupChatView initial loads, IDB fallback), FE-6 (ReadingListDetail polls move to `usePollTask`), FE-7 (`import.meta.env.BASE_URL` prefixes), FE-8 (`safeLocal` wrapper for all localStorage access — shared-origin rule), FE-9 (ParentPostCard keyboard affordance), FE-13 (un-nest ExploreView buttons), FE-14 (menuitem roles + Escape for WorkspaceDropdown), FE-15 (long-press timer into a ref), FE-16 (reset like-state on feedId change), FE-17 (active sentinel in ActivityTimeline), FE-18 (fix `text-text-primary` token), FE-19 (catch in LoginPage submit), FE-20 (Settings toggle gating single-letter shortcuts; delete dead `g`/`?` arms), FE-21 (stable DM bubble keys).

Features: FE-4 — group-chat picker modal (minimal: name field + paper multi-picker + create, using the promoted primitives and the existing `createGroupChat` wrapper), with a new Playwright spec. FE-11/FE-12/DEP-6 dead exports: `createGroupChat` becomes live; the genuinely dead wrappers (`getPaper`, `applyReadingListOrdering`, tag CRUD trio, `networkFirst`, `PersonaData` re-export, `StorageTab` dead props) are deleted or adopted here since wave 4 owns these files.

### Wave 5 — LOW sweep + re-review (`r10/wave5-lows`)

`ruff check --fix` across api/ + worker/ (DEP-8/API-18); delete `figure_describer.py` (WORK-10/DEP-3), `preference_tasks.get_preferences` (WORK-11), podcast-segment storage methods both sides (WORK-13), `rasterize_page` (WORK-15), `fence_lines` from the shared sanitize module if still uncalled after consolidation (WORK-16), `propose_ordering`'s unused `corpus_id` (WORK-14), dead api endpoints after retargeting their security tests (API-9), `ENGAGEMENT_RANGES` api copy + stale `feed_id` comments (API-17/DUP-15/BP-16), dead api config fields (DEP-5/API-8), `pydantic-settings` from worker requirements (DEP-4), `@playwright/test` from frontend devDeps (DEP-7). Docs: `.env.example` gains the undocumented operator vars incl. `SIGNED_URL_KEY`, `POSTGRES_PASSWORD`/`REDIS_PASSWORD` coupling notes (DEP-9); `backfill_metadata.py` gets a "run manually" header or is deleted (DEP-10); FEATURES.md trued up; BP-19 logging nits (`.warn`→`.warning`, bind-convention comment). DUP-20 grab-bag clones fixed where their file is already open, otherwise noted as opportunistic.

**Exit: Round-10.5 regression pass** — re-verify all 93 findings against source with the same verified-only discipline as the review; produce `FICINO_REVIEW_R10_5.md` status table (fixed / deferred-with-reason).

## Execution mechanics

- **TDD** for every bug-category finding: failing test → fix → green. Dead-code and doc items: suite stays green.
- **Parallel subagents** (subagent-driven-development) only for clusters with disjoint files; contested files (`replies.py`, `settings.py`, `persona_tasks.py`, `App.tsx`) are sequential in the main session.
- **Wave gate:** new tests green → full pytest → eslint/tsc/build → Playwright e2e on the local Ollama compose stack → `/code-review` on the wave diff → merge to main.
- **State** lives in this spec, the implementation plan, and the task list — each wave independently resumable across sessions.

## Risks

1. **Railway root-directory change** — gated by throwaway-service proof; `sync-shared.sh` + CI divergence check as fallback.
2. **Settings consolidation changes observable behavior** — characterization tests first; deliberate updates where old behavior was the bug.
3. **WORK-3 failure-mode flip** — baseline-restore semantics (above) keep single-user `.env`-key self-hosts working; only the silent cross-tenant borrow becomes an error.
4. **Group-chat modal scope creep** — pinned to name + picker + create.
5. **Ollama e2e flakiness** — triage via the e2e-triage skill, not blind timeout bumps.

## Success criteria

- All 8 HIGHs fixed with regression tests, wave 1.
- `shared/ficino_shared` deployed to both images (compose + Railway) with the mirrored files reduced to re-exports.
- Round-10.5 pass shows every finding fixed or deferred-with-written-reason; zero new HIGHs introduced.
- CI (ruff + pytest + frontend checks) green on `main` and required for every wave merge.
- Playwright e2e green at every wave gate, including the new group-chat spec.
