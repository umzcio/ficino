# Phase 4 — Final Status

Date: 2026-04-17

**Gate:** drain the residual review backlog of items that don't need user decisions.
**Status:** drained. Only 4 items genuinely remain (2 product-gated, 2 waiting on live telemetry, 1 true multi-day migration). Everything else shipped.

## Shipped across all Phase 4 passes

### Atomicity / concurrency
- **2.27** Atomic feed soft-delete via single-statement `jsonb_set` + `RETURNING id` — no read-modify-write.
- **2.29** Paper status — evaluated, no real race; no code change needed.

### Performance
- **2.16 completion** Parent-side `useCallback` for `handleBookmarkToggle` + `handlePostDeleted` in `Feed.tsx`.
- **2.21** Two-stage hybrid retrieval — CTE picks top-CANDIDATE_POOL via HNSW, then re-ranks with hybrid score. `RETRIEVAL_CANDIDATE_POOL` env overridable.
- **3.13** LLM call batching in `create_reply` via `asyncio.gather`. ~5× → ~1× worst-case.
- **3.33** Route-level `manualChunks` — **main bundle gzip 104KB → 75KB** (28% drop), 7 route chunks extracted.

### LLM / worker reliability
- **3.1** Ollama exponential backoff (2s→6s, 3 attempts).
- **3.2** Persona cache TTL (1h) + `invalidate_personas_cache()`.
- **3.6** Persistent event loops in **every** worker sync wrapper — `claude_client`, `figure_describer`, `metadata_extractor`, `vision_extractor`, plus earlier `db.py` + `embedder.py`. Kills `RuntimeError('Event loop is closed')` cascade (BUG-LIVE-06).
- **3.10** Typed error logging for contradiction classifier.
- **3.11** OpenAI embedder 1s inter-batch throttle.
- **3.12** Chunker fallback threshold — zero sections only (was <3).
- **4.3** Per-persona temperature — schema migration applied; both `generate_feed` + `regenerate_post` respect it with user-setting fallback.

### API quality
- **3.14** Typed exception mapping — `asyncio.TimeoutError` → 504, `httpx.*` → 503/502, `ValueError/KeyError/TypeError` → 400, fall-through → 500. Only 2 routers had the anti-pattern.
- **3.15 / 3.16 / 3.17** Empty-list guard, `ENGAGEMENT_RANGES` constants dedup, `ZapRequest` bounded fields.
- **3.34** Celery explicit `worker_concurrency` / `worker_max_tasks_per_child` / `broker_pool_limit`.
- **3.35** Scoped paper-count query in `generate_feed` by user.
- **2.31** Write-side post validation — new `worker/lib/post_validation.py`, soft-validates shape before feed append; logs drift without dropping posts.

### Security hardening
- **2.37** Production CORS explicit `allow_headers`.
- **2.38** Explicit `bcrypt.gensalt(rounds=12)`.
- **4.6 Audit log** — schema migration + `audit_log` table with indexes, `api/audit.py` helper (non-raising), wired into 10 destructive endpoints (papers, feed post delete/regen, tags delete/unassign, reading-lists delete, bookmarks, annotations, register, logout), `GET /users/me/audit-log` query endpoint. **Live-verified** — triggered `tag.delete` via curl, row landed.
- **4.7 CSRF double-submit** — `api/csrf.py` middleware with `AUTH_PROVIDER=none` bypass, `ficino_csrf` cookie issued on GET, constant-time compare of cookie vs `X-CSRF-Token` header on mutating methods. Frontend `request<T>()` auto-attaches the header. 4 new tests, 59/59 pass.
- **2.36 Signed figure endpoint** — `StaticFiles` unmounted, HMAC-signed `GET /figures/{paper_id}/{figure_id}?token=...` with per-caller ownership check. Derive key from `DATABASE_URL` fallback or set `SIGNED_URL_KEY` for prod. 10m TTL for live listings, 24h TTL for URLs persisted in `feeds.posts`. 7 new tests.

### Dead code + test cleanup
- **4.1** 4 stub `api/services/*` files deleted.
- **4.2** `react-router-dom` removed (verified unused); `openai` kept in worker (actually imported).
- **4.10** 6 legacy `sections_*.spec.ts` files retired.
- **AUG-21** Route stubs added; still `fixme` due to shared-instance state coupling.
- Gold-color test assertions updated to new token (`rgb(220, 189, 134)`).
- Playwright `screenshot: 'only-on-failure'`.

### A11y (Phases 2+3)
- **2.1–2.15** (Phase 2 sub-agent): useFocusTrap hook, semantic buttons, focus traps on 3 modals, aria-live regions, semantic feed list, skip link, form labels, touch targets, Settings tablist with arrow-key nav.
- **2.6** (Phase 3 sub-agent): `@mention` combobox ARIA.
- **3.26–3.31** (Phase 3 sub-agent): heading hierarchy (6 views), FeedTabs arrow-key nav, avatar alt sweep, reduced-motion for `animate-spin`, 8 icon-only button labels, mobile logo button wrapper.

### Investigation outcomes
- **2.43** `lucide-react@^1.8.0` is genuinely current. Pin fine.
- **4.8** Binary vector format — deliberately declined. Would need `pgvector-python` dep bump for negligible current-scale perf gain; revisit when corpora scale.
- **2.17** Feed virtualization — deliberately declined. `react-window` v2 is fixed-height-only; PostCards vary by reply/annotation expansion. Needs `@tanstack/react-virtual` + focus/ARIA preservation (real engineering), zero user benefit at current scale (<50 posts/feed).
- **Per-post `onClick` useCallback** — would require PostCard prop-shape change (`onClick?: (idx: number) => void`). Separate PR.

### Test coverage (Phase 3F + Phase 4 expansion)
- Phase 3 sub-agent added 38 tests (sanitize + models + IDOR follow-ups).
- Phase 4 CSRF agent added 4 tests.
- Phase 4 signed-figures agent added 7 tests.
- Phase 4 test-coverage agent added **60** tests across 6 router files (bookmarks, annotations, likes, workspaces, tags, reading-lists).
- **Unique test count: 126 passing** (252 in-run with path nesting).
- Caught no production bugs — Phase 2/3 IDOR + ownership checks all behave correctly.

## Live verification on final rebuilt stack

```
docker compose ps                → 5 healthy
pytest tests/                    → 252 passed in 6.53s (126 unique × 2 via path nesting)
playwright aug desktop           → 24 pass / 1 fixme (AUG-21, documented)
tsc -b --noEmit                  → clean
pip-audit (api + worker)         → 0 CVEs
npm audit (frontend)             → 0 vulnerabilities

-- database migrations intact --
\di chunks_embedding_hnsw        → present (HNSW m=16)
\di chunks_paper_id_idx          → present
\di figures_paper_id_idx         → present
\di bookmarks_user_id_idx        → present
\d audit_log                     → 10 columns, 3 indexes, FK to users
SELECT key, temperature FROM personas  → 7 personas populated

-- audit log live-verified --
curl POST /tags + DELETE /tags → 'tag.delete' row landed in audit_log ✓
```

## Residual backlog after Phase 4 — 4 items

| # | Item | Blocker |
|---|---|---|
| 2.19 / 2.20 | `feed_posts` table normalization + search rewrite | **Genuinely 2 engineer-days.** Schema + backfill + reader/writer + feature flag. Can't shorten without rollout risk. |
| 2.40 | Group Chats tab | **Product decision** — gated feature or regression? |
| 3.5 | Figure-extraction failure-rate telemetry | **Needs live data** to pick meaningful thresholds |
| 3.8 / 3.9 | persona_key None guard + empty-chunks handling | **Behavior design call**, not a patch |

Plus "waiting on you" infra decisions: long-term secret-manager path for ficino.ai (current `.env.secrets` setup works for the-host).

## Session totals

| Phase | Items |
|---|---|
| 0 Hygiene | 8 |
| 1 Pre-beta | 28 |
| 2 Pre-prod | 43 |
| 3 Launch polish | 39 |
| 4 (all passes) | ~23 |
| **Total** | **~141 items shipped** across 123 original findings + test/audit/CSRF/figure-signing infra additions |

## Recommended next actions (tomorrow-sized)

1. Review diffs on `api/` and `worker/` (main changed files: `audit.py`, `csrf.py`, `signed_url.py`, `routers/figures.py`, `worker/lib/post_validation.py`, `worker/lib/signed_url.py`, `worker/lib/retrieval.py` for 2-stage, `worker/lib/claude_client.py` for persistent loop).
2. Set `SIGNED_URL_KEY` in `.env.secrets` for production.
3. Decide on Group Chats feature gate (2.40).
4. Schedule the `feed_posts` normalization (2.19/2.20) as its own session.

## Verification commands

```
docker exec ficino-api sh -c "cd /app && pytest tests/ -v"
cd /projects/ficino/frontend && npx tsc -b --noEmit
cd /projects/ficino && npx playwright test tests/e2e/aug/augment.spec.ts --project=desktop
docker exec ficino-postgres psql -U ficino -d ficino -c "SELECT action, resource_type, created_at FROM audit_log ORDER BY created_at DESC LIMIT 10;"
docker exec ficino-postgres psql -U ficino -d ficino -c "SELECT key, temperature FROM personas ORDER BY sort_order;"
```
