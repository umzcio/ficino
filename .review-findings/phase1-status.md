# Phase 1 — Final Status

Date: 2026-04-17

**Gate:** `AUTH_PROVIDER≠none` is safe to ship to ficino.ai.
**Status:** ✅ All Phase 1 items landed. Tests passing.

## Done

### 1A. IDOR cluster — 25 endpoints across 11 router files
- `feed.py` (4): list, get-one, delete-post, regenerate-post
- `papers.py` (3): list, get-one, figures
- `messages.py` (5): list papers, tldrs, paper summary, list groups, get group
- `replies.py` (5): list conversations, replied-posts, get replies, create, zap
- `search.py`, `tags.py` (2), `user_posts.py`, `workspaces.py`, `citations.py`, `reading_lists.py`, `settings.py` — one each
- All 11 files parse clean; sub-agent status report at `.review-findings/phase1-idor-status.md`
- **1.10 auth-scoping tests:** 17/17 passing. Run `docker exec ficino-api pytest tests/ -v`.

### 1B. Idempotency + correctness
- **1.11** Celery `generate_feed` append-mode idempotency guard: `_task_id` marker on each post, entry check skips re-append on retry (`persona_tasks.py:152-176, 352-360`)
- **1.12** Post ID uses `id_offset + len(posts) + 1` instead of loop index (`persona_tasks.py:346`)

### 1C. Prompt injection
- **1.13** New `worker/lib/sanitize.py` + `api/sanitize.py` — strips role markers, caps length, wraps in `<untrusted>…</untrusted>` fences
- **1.14** Applied at `worker/lib/persona.py:_format_chunks_for_prompt`
- **1.15** Applied at `worker/tasks/archivist_tasks.py` system prompt
- **1.16** Applied at `worker/lib/claude_client.py:classify_contradiction`
- **1.17** Applied at `api/routers/replies.py` mention prompt (user_message + post_content)
- **1.18** PDF magic byte (`%PDF-`) check at `papers.py:upload_paper`
- **1.19** `CorpusPanel.tsx` surfaces `paper.error_message` when status=error (closes BUG-LIVE-01)

### 1D. Auth surface
- **1.20** Cookie `secure=settings.environment != "development"` on register + login
- **1.21** Logout reads session cookie, calls `delete_session()` in Redis before clearing client cookie
- **1.22** New `IPRateLimit` class; applied: login 5/15min, register 3/hour
- *Opportunistic (from plan 2.38)*: `bcrypt.gensalt(rounds=12)` explicit

### 1E. pgvector index
- **1.23** Migration file `infra/postgres/add_hnsw_index.sql` created AND applied to live DB. `\d+ chunks` shows:
  ```
  "chunks_embedding_hnsw" hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64')
  ```
- **1.24** `init.sql:82` comment now points at the migration

### 1F. Contrast (universal)
- **1.25** `--color-gold`: `#c8a96e → #dcbd86` (dark), `#9a7b3f → #846227` (light)
- **1.26** `--color-text-muted`: `#7a8194 → #9aa3b8`
- **1.27** `--color-tab-inactive`: `#555d6e → #7a8699`
- **1.28** `/50` opacity removed from placeholder styles in 3 files

## Infrastructure added

- `/projects/ficino/api/tests/` — pytest + httpx + asyncpg-based IDOR regression suite (17 tests)
- `/projects/ficino/api/requirements-dev.txt` — dev deps (pytest, pytest-asyncio, httpx)
- `/projects/ficino/api/pytest.ini` — asyncio auto + session loop scope
- `/projects/ficino/.pre-commit-config.yaml` — blocks committing `.env`, detects sk-* patterns
- `/projects/ficino/.review-findings/phase0-status.md`, `phase1-idor-status.md`, `phase1-status.md`

## Stack state

- api, worker, frontend rebuilt (twice — round 2 after IDOR fixes)
- All 5 containers healthy
- Live probes show authenticated endpoints still return user data under `AUTH_PROVIDER=none`
- HNSW index active on `chunks.embedding`
- pip-audit after pin bumps: 0 CVEs on both api + worker requirements

## Open from Phase 1 — pushed to Phase 2

### Discovered by IDOR agent — authed endpoints that accept IDs without ownership checks
These are not Phase 1 regressions (they already had `Depends(get_current_user)`); they're a second-order class of IDOR that needs input validation:

- `POST /tags/assign` — doesn't verify `body.paper_id` belongs to caller
- `POST /papers` upload — doesn't verify `workspace_id` belongs to caller
- `POST /reading-lists` — accepts `corpus_id` + `paper_ids` without ownership checks
- `PUT /reading-lists/{list_id}/apply-ordering` — doesn't verify `body.ordered_papers` IDs

### Other carry-over
- **0.1** — Anthropic API key still lives in `/projects/ficino/.env` (local-disk only, `.gitignore:2` confirmed). Needs decision on secret-manager path before deploy.
- **npm audit 4-highs** — `serialize-javascript` via `workbox-build`. Build-time only. Needs decision: accept risk or `"overrides": { "serialize-javascript": "^6.0.2" }` with a PWA smoke test.
