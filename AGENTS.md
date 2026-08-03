# AGENTS.md

Map for agent-driven work in this repo — commands and rules, not essays. Detail lives in README.md and docs/.

## Project

Ficino is an academic-paper reading app with a personalized research feed (see README.md). One codebase, two deploy targets: self-host via Docker Compose, and SaaS on Railway + Supabase (ficino.app).

## Layout

- `frontend/` — React + Vite + TypeScript
- `api/` — FastAPI service
- `worker/` — Celery worker
- `shared/` — editable local package used by both api and worker (not on PyPI)
- `infra/postgres/` — database schema (`init.sql`) + upgrade migrations
- `tests/e2e/` — Playwright specs
- `plans/` — advisor execution plans

## Verification gates

- Frontend: `cd frontend && npm run lint && npm test && npm run build` (eslint 9, vitest, `tsc -b && vite build`; CI also runs `npx tsc -b` first).
- API/worker tests need real Postgres + Redis and run in containers: `docker compose up -d`, then
  `docker exec ficino-api sh -c "pip install --user -q -r requirements-dev.txt && python -m pytest tests/ -q"` (same with `ficino-worker`). Containers run as uid 10001 — the `--user` and `python -m pytest` (not bare `pytest`) are required.
- Bare-metal Python: `pip install ./shared` first, or collection fails with `ModuleNotFoundError: ficino_shared` (README "Testing").
- Lint: `ruff check api/ worker/ shared/` (ruff pinned at 0.15.20 in CI).
- e2e: `npx playwright test` from repo root. baseURL defaults to `http://localhost:3000/ficino` (override with `E2E_BASE_URL`) and assumes the dev deploy documented in README — in this checkout's compose the frontend is NOT port-published; the stack serves nginx internally (verify: `docker compose exec frontend wget -qO- http://127.0.0.1/ficino/ | head -1`). e2e hits a shared dev DB — runs accumulate junk data (known R10.5 deferral).

## Schema & migrations

`infra/postgres/init.sql` is the FULL schema. Any new migration must be folded into `init.sql` in the same PR; the standalone `add_*.sql` files are the upgrade path for pre-existing deployments.

## Dependencies

Runtime images and CI install from `api/requirements.lock` / `worker/requirements.lock` (uv-compiled). When floors in `requirements.txt` change, regenerate: `uv pip compile api/requirements.txt -o api/requirements.lock --python-version 3.11` (same for `worker/`). Prerequisite for any local Python run: `pip install ./shared`.

## Conventions

- Commits: conventional with scope — `fix(api): …`, `feat(frontend): …` (see `git log --oneline`).
- Fire-and-forget async actions get `.catch(() => {})` plus an explanatory comment; destructive/navigational ones surface an error (App.tsx:577-585).
- Testable component logic is extracted as exported plain functions — there is no component-test library (@testing-library/react). Exemplars: `startPoll` in `frontend/src/hooks/usePollTask.ts`, helpers in `GroupChatView`.

## Settled scope — do not "fix"

Rationale for each: `FICINO_REVIEW_R10_5.md`.

- api/worker LLM retry logic deliberately duplicated (comment-synced).
- ListenView's two hand-rolled pollers are deliberate.
- `components/_shared/Md.tsx` importing `Feed/_shared/InlineMd` across the boundary is deliberate.
- Four dead api Settings fields (`llm_provider`, `claude_model`, `ollama_llm_model`, `anthropic_api_key`) intentionally retained, documented in-code.
- Single-service literals (timeouts, backoff, session TTL, top_k) intentionally not consolidated.
- PostCard/UserPostCard DangerButton/card-shell duplication not converged.

## Git policy

Never commit or push unless the user explicitly asks. Commit style: conventional commits (above).
