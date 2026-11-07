# AGENTS.md

Map for agent-driven work in this repo — commands and rules, not essays. Detail lives in README.md, server/README.md, deploy/README.md and docs/.

## Project

Ficino is an academic-paper reading app with a personalized research feed (see README.md). Self-host only: one Docker Compose stack (postgres, api, worker, web). The hosted service was shut down in October 2026; the Python services were removed at the git tag `python-final`.

## Layout

- `frontend/` — React + Vite + TypeScript (the `web` image: the build behind nginx)
- `server/` — the backend (Node, TypeScript, Hono, postgres.js, pg-boss): `src/api` and `src/worker` entries from one image, `migrations/`, the restore and re-embed CLIs, the vitest suite
- `deploy/` — host override examples (`loopback/`, `tailnet/`), the tailnet web nginx template, deploy checks (`deploy/test/`)
- `docker-compose.yml` — the generic stack (project `ficino`, no published ports); `docker-compose.e2e.yml` — the e2e stack (project `ficino-e2e`)
- `tests/e2e/` — Playwright specs; `tests/e2e/SKIPS.md` — the skip inventory
- `scripts/e2e-stack.sh` — drives the e2e stack
- `docs/superpowers/` — specs, plans and the per-plan carryover records; `plans/` — advisor execution plans

## Verification gates

- Server: `cd server && npm ci && npm run typecheck && npm test && npm run build` (Node ≥ 22.18; the suite starts and removes its own throwaway Postgres, `pgvector/pgvector:pg18` on 127.0.0.1 only).
- Frontend: `cd frontend && npx tsc -b && npm run lint && npm test && npm run build` (as CI runs it).
- Deploy: `npm run test:deploy` from the repo root (renders every compose layer, runs the web nginx template in throwaway `ficino-deploytest-*` containers).
- e2e: `scripts/e2e-stack.sh up && scripts/e2e-stack.sh ci`, then `scripts/e2e-stack.sh down`. The full suite is `up --ollama` + `full`, a fresh `up` per acceptance run. Reports land in `tests/results/e2e-<ci|full>.json`; any skip not listed in `tests/e2e/SKIPS.md` is a failure.

## Schema & migrations

Numbered SQL files in `server/migrations/` (`NNNN_name.sql`), applied in order by the runner in `server/src/db/migrate.ts` (`npm run migrate` in a checkout, `node dist/db/migrate-cli.js` in the image; the api and worker also migrate at boot). Add a new numbered file; never edit an applied one. The archive restore is data-only into a schema the runner migrated, so keep the schema restore-compatible: no CHECK or enum constraints on status columns, `chunks.embedding` stays `vector(1024)`.

## Dependencies

`server/package-lock.json` is the backend lockfile (`frontend/package-lock.json` the frontend's; the root `package-lock.json` holds Playwright for e2e and the deploy checks); install with `npm ci`. The server image keeps production dependencies only, so it has no `tsx`: inside it run `node dist/...`, never `npm run <script>`.

## Standing rules

- jsonb writes go through `sql.json(...)`; postgres.js double-encodes `JSON.stringify`.
- Integer route params are parsed with `pyInt`.
- Never mount a router at `/` with `use('*', requireUser)`.
- Never `docker compose down -v` except `docker compose -p ficino-e2e -f docker-compose.e2e.yml down -v` (what `scripts/e2e-stack.sh down` runs).
- Every built compose service names its image (`ficino-server:local`, `ficino-web:local`; e2e `ficino-server:e2e`, `ficino-web:e2e`); compose must never default-name one.
- Postgres is `pgvector/pgvector:pg18`; never a `-trixie` tag.
- No `0.0.0.0` publish; tracked publishes are on `127.0.0.1` only.

## Conventions

- Commits: conventional with scope — `fix(server): …`, `feat(frontend): …`, `chore(deploy): …` (see `git log --oneline`).
- Fire-and-forget async actions get `.catch(() => {})` plus an explanatory comment; destructive/navigational ones surface an error (App.tsx:577-585).
- Testable component logic is extracted as exported plain functions — there is no component-test library (@testing-library/react). Exemplars: `startPoll` in `frontend/src/hooks/usePollTask.ts`, helpers in `GroupChatView`.

## Settled scope — do not "fix"

Rationale for each: `FICINO_REVIEW_R10_5.md`.

- ListenView's two hand-rolled pollers are deliberate.
- `components/_shared/Md.tsx` importing `Feed/_shared/InlineMd` across the boundary is deliberate.
- Single-service literals (timeouts, backoff, session TTL, top_k) intentionally not consolidated.
- PostCard/UserPostCard DangerButton/card-shell duplication not converged.

## Git policy

Never commit or push unless the user explicitly asks. Commit style: conventional commits (above).
