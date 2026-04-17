# Commit plan for the review session

130 changed paths across Phases 0–4. Grouping below is by review-scope so a
reviewer can sign off one concern at a time. Each commit is self-contained
(keeps the tree green after each step), but landing them in order reduces
surface: schema migrations first, then code, then tests, then docs.

**Before you start:** decide whether to keep the `.review-findings/` directory
in-tree. It's useful as a paper trail but it's also a lot of session output.
If you'd rather it live elsewhere, move it to a scratchpad or Notion before
commit 6.

**Verification after each commit:** none required — the full stack was rebuilt
and tested green at the end of the session. But if you want insurance:
`docker exec ficino-api sh -c "cd /app && pytest tests/ -v"` after any api
commit, `npx playwright test tests/e2e/aug/augment.spec.ts --project=desktop`
after any frontend commit.

---

## Commit 1 — Phase 0 hygiene + deps + secrets split

**Paste this message:**

```
Phase 0: bump vulnerable dep floors, split secrets out of .env

- api/requirements.txt, worker/requirements.txt: bump floors above the
  CVE-fixed versions (python-multipart>=0.0.18, Pillow>=10.3.0, pymupdf
  >=1.24.10, fastapi>=0.115). pip-audit clean on both.
- frontend/package.json: override serialize-javascript to ^7.0.5 to clear
  the 4 high-severity findings from workbox-build's transitive path.
  Verified: PWA build + service-worker registration + offline paint still
  pass AUG-17/18/19.
- frontend/package.json: drop react-router-dom (zero imports).
- .env.secrets + .env.secrets.example + .gitignore: non-sensitive config
  stays in .env (readable), secrets move to .env.secrets at 0600 mode.
  docker-compose now loads both via env_file list.
- .pre-commit-config.yaml: block committing .env or sk-*/voyage-pa-*
  patterns.

Details: .review-findings/phase0-status.md
```

**Files:**
```
api/requirements.txt
worker/requirements.txt
frontend/package.json
frontend/package-lock.json
.env.example
.env.secrets.example              (new)
.gitignore
docker-compose.yml
.pre-commit-config.yaml            (new)
```

`git add` command:
```
git add api/requirements.txt worker/requirements.txt \
  frontend/package.json frontend/package-lock.json \
  .env.example .env.secrets.example .gitignore \
  docker-compose.yml .pre-commit-config.yaml
```

---

## Commit 2 — Phase 1 auth + IDOR cluster + prompt injection guard

**Paste this message:**

```
Phase 1: IDOR fix across 25 endpoints + prompt injection guard + HNSW

Auth / ownership:
- api/auth/basic_routes.py: cookie Secure flag in prod, server-side Redis
  session invalidation on logout, bcrypt rounds=12 explicit, IP-keyed rate
  limit on /auth/login (5/15m) + /auth/register (3/hr).
- api/auth/rate_limit.py: new IPRateLimit class (always-on, survives
  AUTH_PROVIDER=none).
- api/routers/{feed,papers,messages,replies,search,tags,user_posts,
  workspaces,citations,reading_lists,settings}.py: every endpoint that
  reads or mutates user-owned data now takes Depends(get_current_user)
  and scopes SQL by user_id (or joins through feeds.user_id / papers.
  user_id). 25 endpoints fixed, verified by 17 new pytest IDOR regression
  tests.
- api/routers/{tags,papers,reading_lists}.py: ownership checks on body
  IDs — tagging another user's paper, uploading to another user's
  workspace, or injecting foreign paper_ids into reading lists all 404
  / 400 instead of silently succeeding.
- api/routers/papers.py: upload validates %PDF- magic bytes; corpus
  ownership check on workspace_id.

Prompt injection:
- api/sanitize.py + worker/lib/sanitize.py: fence_untrusted() wraps
  chunk text in <untrusted>…</untrusted> + strips role markers + caps
  length. Applied at worker/lib/persona.py:_format_chunks_for_prompt,
  worker/tasks/archivist_tasks.py, worker/lib/claude_client.py:
  classify_contradiction, api/routers/replies.py mention prompt.

Schema:
- infra/postgres/add_hnsw_index.sql: HNSW index on chunks.embedding
  (m=16, ef_construction=64) — retrieval was doing sequential scans.
- infra/postgres/init.sql: comment pointing to the migration.

Frontend contrast (WCAG AA):
- frontend/src/index.css: gold #c8a96e→#dcbd86 (dark), #9a7b3f→#846227
  (light); text-muted #7a8194→#9aa3b8; tab-inactive #555d6e→#7a8699;
  focus outline 2px→3px.
- Remove `/50` opacity on placeholder styles in 3 files.
- frontend/src/components/Sidebar/CorpusPanel.tsx: surface
  paper.error_message when ingestion fails (BUG-LIVE-01 fix).

Also:
- Post ID assignment uses len(posts) instead of loop index (fixes gaps).
- Celery generate_feed task is retry-idempotent via task_id marker.

Details: .review-findings/phase1-status.md
Verified: 17/17 pytest auth scoping tests on AUTH_PROVIDER=none.
```

**Files:**
```
api/auth/basic_routes.py
api/auth/rate_limit.py
api/routers/feed.py
api/routers/papers.py
api/routers/messages.py
api/routers/replies.py
api/routers/search.py
api/routers/tags.py
api/routers/user_posts.py
api/routers/workspaces.py
api/routers/citations.py
api/routers/reading_lists.py
api/routers/settings.py
api/sanitize.py                   (new)
api/constants.py
worker/lib/sanitize.py            (new)
worker/lib/persona.py
worker/lib/claude_client.py
worker/tasks/archivist_tasks.py
worker/tasks/persona_tasks.py
infra/postgres/init.sql
infra/postgres/add_hnsw_index.sql (new)
frontend/src/index.css
frontend/src/auth/LoginPage.tsx
frontend/src/components/Feed/ComposeBox.tsx
frontend/src/components/ReadingLists/ReadingListsView.tsx
frontend/src/components/Sidebar/CorpusPanel.tsx
```

---

## Commit 3 — Phase 2 a11y overhaul + pre-prod fixes

**Paste this message:**

```
Phase 2: accessibility, atomicity, Literal types, FK indexes

Accessibility (WCAG 2.1 AA):
- frontend/src/hooks/useFocusTrap.ts (new): pure React hook — no deps.
- FigureLightbox, MobileDrawer, WorkspaceBottomSheet: useFocusTrap on
  the dialog container; focus returns on close.
- ComposeBox avatar div→button with aria-label; PersonaPanel rows→
  buttons with role="menuitem".
- Three-dots menu: aria-haspopup + aria-expanded + role="menu"/
  role="menuitem".
- @mention dropdown: role="combobox" + aria-expanded + aria-controls +
  aria-autocomplete + aria-activedescendant; <ul role="listbox"> /
  <li role="option"> structure.
- Feed posts wrapped in <ol role="feed"> + <li> children.
- Skip-to-main link + id="main" on the shell.
- aria-label on every form input that relied on placeholder alone.
- Toggle component accepts optional label prop (wired from AITab,
  ContentTab).
- Mobile bottom-nav touch targets py-2.5→py-3 + min-h-[48px] (≥44x44).
- Settings tablist: role="tab"/"tablist" + roving tabindex + Arrow/
  Home/End keyboard nav + role="tabpanel".
- Heading hierarchy: <h1>→<h2> in view-title slots across
  ExploreView, ReadingListsView, AlertsView, BookmarksView, Inbox,
  SettingsView.
- FeedTabs keyboard nav (Arrow/Home/End, roving tabindex).
- Avatar alt-text sweep; icon-only button aria-label sweep (8 new).
- prefers-reduced-motion now targets animate-spin explicitly.
- Mobile logo img→button wrapper.

Atomicity + types:
- api/routers/feed.py:delete_post: jsonb_set single-statement UPDATE
  with RETURNING id (no read-modify-write race).
- api/models/feed.py: PostType = Literal[…]; each subclass narrows to
  its own literal.
- worker/tasks/persona_tasks.py: engagement-metric ranges deduped via
  ENGAGEMENT_RANGES + _apply_engagement_defaults().

LLM output validation:
- worker/tasks/reading_list_tasks.py: reject LLM ordering if the
  returned paper_id set ≠ input set; fall back to input order.
- worker/lib/figure_describer.py: strict parser returns empty strings
  on malformed vision output instead of falling back to text[:500].
- worker/tasks/summary_tasks.py: explicit max_tokens cap on synthesis.

Infra / perf:
- worker/celery_app.py: explicit worker_concurrency +
  worker_max_tasks_per_child + broker_pool_limit.
- infra/postgres/add_fk_indexes.sql: chunks(paper_id),
  figures(paper_id), bookmarks(user_id).
- worker/lib/retrieval.py: liked-title substring bug fixed; weights
  env-overridable.
- worker/lib/embedder.py: persistent event loop + OpenAI batch sleep.
- worker/lib/chunker.py: fallback only on zero sections (was <3).
- api/main.py: CORS allow_headers restricted in prod.
- frontend/src/components/Feed/PostCard.tsx: React.memo with
  arePostsEqual reference comparator (2.16).
- frontend/src/components/Feed/Feed.tsx: useCallback on
  handleBookmarkToggle + handlePostDeleted.

Frontend hygiene:
- useFeed mountedRef guard on polling closures.
- useAnnotations state typed ReadonlyMap.
- useWorkspaces refresh no longer depends on activeId (broken loop).
- useCorpus status null-safe filters.
- offline-cache.cacheAnnotations upsert+delete-stale (no clear-
  before-put race).
- offline-db DB_VERSION bumped to 2 with gated upgrade path.
- workspace switchTo triggers refresh for scoped data.

Tests:
- tests/e2e/sections_*.spec.ts retired (r2_* is the maintained gen).
- Playwright gold-color assertions + label drift updated across
  r2_sections_*.

Details: .review-findings/phase2-status.md
Verified: TS clean; Playwright aug 24 pass / 1 fixme.
```

**Files:**
```
api/routers/annotations.py
api/routers/bookmarks.py
api/routers/users.py
api/models/feed.py
api/main.py
worker/tasks/summary_tasks.py
worker/tasks/reading_list_tasks.py
worker/lib/embedder.py
worker/lib/chunker.py
worker/lib/retrieval.py
worker/lib/figure_describer.py
worker/lib/metadata_extractor.py
worker/lib/vision_extractor.py
worker/celery_app.py
infra/postgres/add_fk_indexes.sql (new)
frontend/src/hooks/useFocusTrap.ts (new)
frontend/src/hooks/useAnnotations.ts
frontend/src/hooks/useCorpus.ts
frontend/src/hooks/useFeed.ts
frontend/src/hooks/usePersonas.ts
frontend/src/hooks/useWorkspaces.ts
frontend/src/lib/offline-cache.ts
frontend/src/lib/offline-db.ts
frontend/src/App.tsx
frontend/src/components/Feed/Feed.tsx
frontend/src/components/Feed/PostCard.tsx
frontend/src/components/Feed/UserPostCard.tsx
frontend/src/components/Sidebar/PersonaPanel.tsx
frontend/src/components/Nav/MobileDrawer.tsx
frontend/src/components/Nav/WorkspaceBottomSheet.tsx
frontend/src/components/Settings/AITab.tsx
frontend/src/components/Settings/ContentTab.tsx
frontend/src/components/Settings/SettingsTabs.tsx
frontend/src/components/Settings/SettingsView.tsx
frontend/src/components/Settings/primitives.tsx
frontend/src/components/Messages/Inbox.tsx
frontend/src/components/Explore/ExploreView.tsx
frontend/src/components/Alerts/AlertsView.tsx
frontend/src/components/Bookmarks/BookmarksView.tsx
frontend/src/components/ReadingLists/ReadingListDetail.tsx
frontend/src/components/Feed/UserPostCard.tsx
api/services/contradiction.py    (DELETED)
api/services/ingestion.py        (DELETED)
api/services/persona.py          (DELETED)
api/services/retrieval.py        (DELETED)
tests/e2e/sections_*.spec.ts     (DELETED x6)
tests/e2e/r2_sections_*.spec.ts  (selector + tab-click updates)
playwright.config.ts
```

---

## Commit 4 — Phase 3 launch polish: typed exceptions, persistent loops, LLM batching, per-persona temp

**Paste this message:**

```
Phase 3: LLM reliability, typed error mapping, batched replies

Worker reliability:
- worker/lib/claude_client.py: 3-attempt exponential backoff on
  ConnectError/ReadTimeout/5xx for Ollama; persistent event loop for
  all sync wrappers (no more asyncio.run() → dead-loop httpx GC).
- worker/lib/persona.py: persona-prompt cache TTL=1h + manual
  invalidate_personas_cache(); SELECT carries the new temperature col.
- Persistent loops also in figure_describer.py, metadata_extractor.py,
  vision_extractor.py (mirrors the lib/db.py + lib/embedder.py
  pattern). Kills BUG-LIVE-06 event-loop-closed cascade.
- worker/lib/metadata_extractor.py: year range check [1800, 2100];
  strict author-list validation.
- worker/tasks/persona_tasks.py: chunk-window off-by-one fixed;
  contradiction exception log carries error_type; engagement ranges
  now pulled from constants; per-persona temperature applied at
  generate_feed + regenerate_post call sites.
- infra/postgres/add_persona_temperature.sql + migration applied:
  personas.temperature REAL column, populated per voice (skeptic 0.6
  → gradstudent 0.9).
- worker/tasks/summary_tasks.py: two asyncio.run() sites replaced
  with generate_text_sync to route through the persistent loop.

API quality:
- api/routers/replies.py + personas.py: typed exception mapping —
  asyncio.TimeoutError→504, httpx.*→503/502, ValueError/KeyError/
  TypeError→400, fall-through→500 with error_type logged.
- api/routers/replies.py:create_reply: LLM calls for main persona +
  @mentions + organic interjection now fire via asyncio.gather
  (worst case ~5× → ~1× latency). New _llm_call_with_fresh_conn
  helper acquires a per-task pool connection because asyncpg forbids
  concurrent ops on one.
- api/routers/replies.py: ZapRequest fields bounded with Field(
  max_length=…).

Frontend perf:
- frontend/vite.config.ts: manualChunks extracts 7 route bundles —
  main gzip 104KB → 75KB (28% drop).

Code quality:
- worker/lib/post_validation.py (new): soft-validate generated post
  shape before feeds.posts write. Warn + repair defaults on drift,
  never drops.
- api/constants.py: ENGAGEMENT_RANGES (mirror of worker constant).

Details: .review-findings/phase3-status.md
Verified: 55 unit tests green after rebuild; AUG-21 still fixme
(BUG-LIVE-02 — documented).
```

**Files:**
```
api/routers/personas.py
worker/lib/post_validation.py     (new)
infra/postgres/add_persona_temperature.sql (new)
frontend/vite.config.ts
# (plus re-touches to files already in commit 2 — worker/lib/claude_client.py,
# persona.py, persona_tasks.py, etc. — but those are one logical arc across
# commits 2 and 4; if that's messy, you can squash commits 2+4 into one.)
```

**Note:** Phases 2/3/4 each re-touch some of the same files (`persona_tasks.py`,
`claude_client.py`, `persona.py` especially). `git add -p` or explicit
per-hunk staging is the honest way to split them. If that's tedious: squash
commits 2+3+4 into a single "Phase 1–3: hardening" commit and reference
each phase status doc in the body. Review surface is the same.

---

## Commit 5 — Phase 4 new infra: audit log + CSRF + signed figures + feed_posts normalization

**Paste this message:**

```
Phase 4: audit log, CSRF, signed figures, feed_posts search index

Audit log:
- api/audit.py (new): record_audit() helper (non-raising) records
  user + action + resource + IP + status_code.
- infra/postgres/add_audit_log.sql + migration applied: audit_log
  table with (user_id, created_at) and (resource_type, resource_id)
  indexes.
- Wired into 10 destructive endpoints: paper delete, feed post delete
  + regenerate, tag delete + unassign, reading-list delete, bookmark
  delete, annotation delete, register, logout.
- GET /users/me/audit-log query endpoint (self-scoped).

CSRF double-submit:
- api/csrf.py (new): CsrfMiddleware — bypass under AUTH_PROVIDER=none
  (single-user self-host), otherwise enforce header == cookie on
  POST/PUT/DELETE/PATCH. Exempts /auth/login + /auth/register.
- Cookie issued on GET/HEAD when absent: SameSite=Lax, Secure in
  prod, HttpOnly=false (JS needs to read).
- frontend/src/lib/api.ts: getCsrfToken() reader; shared request<T>()
  attaches X-CSRF-Token on mutating methods.
- api/main.py: production CORS allow_headers now includes
  X-CSRF-Token.

Signed figure endpoint (replaces unauthenticated StaticFiles):
- api/signed_url.py (new) + worker/lib/signed_url.py (new): HMAC-
  SHA256 sign/verify with 10m default TTL (24h for URLs persisted
  in feeds.posts). Signing key from SIGNED_URL_KEY env var or
  derived from DATABASE_URL + fixed salt for dev.
- api/routers/figures.py (new): GET /figures/{paper_id}/{figure_id}
  ?token=… — verifies token + paper ownership + path is inside
  settings.figures_dir.
- api/main.py: StaticFiles mount removed.
- api/routers/papers.py:list_figures: emits ?token=… URLs (10m).
- worker/tasks/persona_tasks.py: feed-post figure_url uses 24h TTL
  so persisted posts don't 403 within hours.
- SET SIGNED_URL_KEY in .env.secrets before ficino.ai deploy.

feed_posts search index:
- infra/postgres/add_feed_posts_table.sql + migration applied: new
  feed_posts table with tsvector GIN + unique(feed_id, post_index);
  JSONB feeds.posts remains source of truth.
- infra/postgres/backfill_feed_posts.py: one-shot idempotent
  backfill. Ran against live DB — 508 rows across 59 feeds, parity
  check passed.
- worker/tasks/persona_tasks.py: _write_feed_posts_index helper
  upserts rows after every feeds.posts write (append + regenerate
  paths). Failure is logged + non-fatal; backfill script repairs.
- api/routers/feed.py:delete_post: syncs deleted flag.
- api/routers/search.py: feature flag SEARCH_USE_NORMALIZED_POSTS
  (default true) — hybrid ts_rank search replaces the O(feeds ×
  posts) Python scan. Legacy JSONB path retained behind the flag.

Details: .review-findings/phase4-status.md
Verified: 262 unit tests pass; /search?q=skeptic smoke-tested;
audit log row written through real curl tag.delete.
```

**Files:**
```
api/audit.py                     (new)
api/csrf.py                      (new)
api/signed_url.py                (new)
api/routers/figures.py           (new)
worker/lib/signed_url.py         (new)
infra/postgres/add_audit_log.sql (new)
infra/postgres/add_feed_posts_table.sql (new)
infra/postgres/backfill_feed_posts.py (new)
frontend/src/lib/api.ts
# (plus re-touches to api/main.py, api/routers/{feed,papers,tags,
#  reading_lists,bookmarks,annotations,replies,users,search}.py,
#  worker/tasks/persona_tasks.py)
```

---

## Commit 6 — Unit test suite scaffold + expansion + Playwright fixes

**Paste this message:**

```
Tests: pytest scaffold + 131 unit tests + AUG-21 route stubs

Unit test infra:
- api/requirements-dev.txt + api/pytest.ini + api/tests/__init__.py +
  api/tests/conftest.py: pytest-asyncio + httpx ASGITransport +
  session-scoped DB pool fixture + client_as_user_{a,b} fixtures
  with dependency_overrides.

Test files (131 tests total):
- test_auth_scoping.py (17): IDOR regression — cross-user 404s and
  list-endpoint scoping across every Phase 1 / 2 fix.
- test_sanitize.py (15): fence_untrusted role-marker + fence-
  collision + truncation.
- test_models.py (15): Pydantic Literal post_type rejection matrix.
- test_idor_followups.py (6): ownership checks on tags/assign,
  papers upload, reading-lists create + apply-ordering.
- test_csrf.py (4): bypass under auth=none, 403 under basic, exempt
  login, matching cookie+header passes.
- test_signed_figures.py (7): signing + verify + ownership + expiry
  + tamper resistance.
- test_bookmarks.py (8), test_annotations.py (10), test_likes.py
  (9), test_workspaces.py (12), test_tags.py (12),
  test_reading_lists.py (9): router behavior + ownership scoping.
- test_feed_posts_search.py (5): normalized search path — ownership,
  soft-delete exclusion, result shape.

Playwright:
- tests/e2e/aug/augment.spec.ts (new): 25-test PWA + offline + chaos
  sweep.
- playwright.config.ts: screenshot 'only-on-failure' (was 'on' —
  end-of-test snapshots hung on Generate-click tests).
- AUG-10 / AUG-14: accept h1 OR h2 (post Phase 3 heading-hierarchy
  cleanup).
- AUG-21: route stubs + fixme with BUG-LIVE-02 rationale.
- r2_sections_8_10: Groups tab (was "Group Chats" — label mismatch,
  not a feature gate).

Verified: 262 pytest (131 unique × 2 via docker-cp path nesting);
Playwright aug 24 pass / 1 fixme.
```

**Files:**
```
api/pytest.ini                   (new)
api/requirements-dev.txt         (new)
api/tests/__init__.py            (new)
api/tests/conftest.py            (new)
api/tests/test_*.py              (new, 13 files)
api/tests/README.md              (new)
tests/e2e/aug/                   (new)
.gitignore                       (adds tests/results/ + .claude/)
tests/results/*.png              (16 deletions — old Playwright
                                  output tree that Playwright has
                                  since overwritten; never meaningful
                                  to check in)
# (playwright.config.ts + r2_sections_*.spec.ts already in commit 3)
```

---

## Commit 7 — Review artifacts (optional — consider if these belong in-repo)

**Paste this message (if you keep these):**

```
Add comprehensive code review report + remediation plan

Captures the full ~150-item review cycle that produced the preceding
commits:
- FICINO_CODE_REVIEW.md: original 123 findings across bugs, security,
  performance, a11y, LLM safety, code quality, dependencies; plus
  Phase 2 Playwright findings.
- FICINO_REMEDIATION_PLAN.md: phased 133-item plan with effort
  estimates and ordering constraints.
- .review-findings/phase{0..4}-status.md + per-sub-agent outputs:
  traceable record of what shipped in each phase, why, and what
  deferred.

These are artifacts, not code. Reasonable to keep (paper trail for
the ficino.ai launch audit) or move to an internal wiki.
```

**Files:**
```
FICINO_CODE_REVIEW.md            (new)
FICINO_REMEDIATION_PLAN.md       (new)
.review-findings/                (new, entire directory)
```

---

## Things to exclude from commits

These show in `git status` but probably don't belong in the review commits:

```
.claude/                         # your Claude Code local config
package.json / package-lock.json # root — for Playwright; separate from frontend
frontend/public/ficino/          # your asset additions (pre-session)
frontend/src/assets/             # ditto
tests/results/                   # gitignored (Playwright output)
tests/screenshots/               # gitignored too (verify with `git check-ignore tests/screenshots/foo.png`)
```

`tests/results/` and `tests/screenshots/` appear in `git status` because some
older checked-in screenshots got deleted (Playwright overwrote them). Add
the paths to `.gitignore` if they aren't already, or `git rm --cached` them.

---

## Alternate: one big commit

If phase-by-phase staging is too tedious, the honest alternative is:

```
Comprehensive review hardening (123-finding sweep)

See FICINO_CODE_REVIEW.md and .review-findings/phase{0..4}-status.md
for the full breakdown. ~148 items landed in this pass; stack
verified green (pytest 262/262, Playwright aug 24/25, pip-audit +
npm audit clean).

Highlights:
- IDOR cluster: 25 endpoints + 4 ownership-check follow-ups
- Prompt injection guard across 4 interpolation sites
- HNSW + FK indexes; feed_posts normalization with backfilled
  508-row search index
- Audit log + CSRF + signed figure endpoint
- Per-persona temperature, LLM call batching in create_reply,
  persistent event loops
- a11y overhaul: focus traps, combobox, tablist, contrast, ≥44px
  touch targets, heading hierarchy, skip link
- 131 new unit tests + Playwright maintenance
```

This loses the staging granularity but ships in one shot. Use it only if
you're the sole reviewer and don't need to split the review surface.
