# Plan 031: Add a root AGENTS.md for agent-driven development

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- README.md .github/workflows/ci.yml docker-compose.yml`
> If any referenced file changed since this plan was written, verify the
> commands below are still accurate before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/022-full-schema-init-sql.md, plans/023-python-dep-lockfiles.md (this file documents the schema rule and lock workflow those plans establish — land them first so AGENTS.md is born accurate)
- **Category**: dx
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

This repo is heavily agent-driven (`.agents/skills/`, `plans/`, `review/`, ~20 agent-tool config directories, multiple committed audit reports) but has NO root `AGENTS.md`/`CLAUDE.md`. Every agent session re-derives the same facts: the three different test invocations (docker-exec pytest for api/worker, the `pip install ./shared` prerequisite, vitest at `frontend/`, Playwright against a live dev DB), the schema/migration rule, and the settled-scope conventions recorded only inside `FICINO_REVIEW_R10_5.md` — and agents regularly "fix" deliberate decisions without that context. One file eliminates the re-derivation and the accidental churn.

## Current state

- No `AGENTS.md` or `CLAUDE.md` at the repo root (verified via `git ls-files`).
- The facts to document, verified during the audit:
  - Frontend gates: `cd frontend && npm run lint && npm test && npm run build` (eslint 9, vitest, `tsc -b && vite build`).
  - API/worker tests need real Postgres and run in containers: `docker compose up -d`, then `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` (same for `ficino-worker`).
  - Bare-metal Python: `pip install ./shared` first (local editable package, not on PyPI — README.md:364-378 documents the ModuleNotFoundError otherwise).
  - Lint: `ruff check api/ worker/ shared/`.
  - e2e: `npx playwright test` from repo root, requires the dev stack at `http://localhost:3000/ficino`, hits a SHARED dev DB (runs accumulate junk data — known, R10.5 deferral).
  - Schema rule (post-plan-022): `init.sql` is the full schema; new migrations must be folded into it in the same PR; standalone `add_*.sql` files are the upgrade path for pre-existing deployments.
  - Dependency locks (post-plan-023): runtime images/CI install from `requirements.lock`; regenerate with the command in the lock header when floors change.
  - Settled scope (from `FICINO_REVIEW_R10_5.md` — do NOT "fix" these): api/worker LLM retry logic deliberately duplicated (comment-synced); ListenView's two hand-rolled pollers deliberate; `_shared/Md.tsx` importing `Feed/_shared/InlineMd` across the boundary deliberate; four dead api Settings fields (`llm_provider`, `claude_model`, `ollama_llm_model`, `anthropic_api_key`) intentionally retained, documented in-code; single-service literals (timeouts, backoff, session TTL, top_k) intentionally not consolidated; PostCard/UserPostCard DangerButton/card-shell duplication not converged.
  - Conventions: conventional commits with scope (`fix(api): …`, `feat(frontend): …` — see `git log --oneline -20`); fire-and-forget async actions get `.catch(() => {})` + comment, destructive/navigational ones surface an error (App.tsx:577-585); testable logic in components is extracted as exported plain functions (no @testing-library/react — exemplars: usePollTask's `startPoll`, GroupChatView's helpers).
  - Commit policy: never commit/push unless the user explicitly asks.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Render check | `cat AGENTS.md` | content as written; no broken markdown |

## Scope

**In scope**:
- `AGENTS.md` (create, repo root)

**Out of scope**:
- `README.md` — leave it; AGENTS.md links to it rather than duplicating prose.
- The `.agents/` directory and skills — not part of this plan.

## Git workflow

- Branch: `advisor/031-agents-md` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): `docs: add AGENTS.md with verification gates and settled-scope conventions`.

## Steps

### Step 1: Write AGENTS.md

Create `<repo>/AGENTS.md` with these sections, concise (target ≤ 80 lines; commands and rules, not essays):

1. **Project** — two sentences: what Ficino is (link README.md), the two deploy targets (self-host compose / SaaS Railway+Supabase).
2. **Layout** — one line each: `frontend/` (React+Vite+TS), `api/` (FastAPI), `worker/` (Celery), `shared/` (editable package used by both), `infra/postgres/` (schema), `tests/e2e/` (Playwright), `plans/` (advisor execution plans).
3. **Verification gates** — the exact commands from "Current state" (frontend gates; docker-exec pytest for api/worker incl. the `pip install ./shared` bare-metal note; ruff; playwright invocation + shared-dev-DB warning).
4. **Schema & migrations** — the post-022 rule.
5. **Dependencies** — the post-023 lock rule + `pip install ./shared` prerequisite.
6. **Conventions** — commit style, async-error-handling convention, testable-logic extraction pattern, "no component-test library — extract plain functions".
7. **Settled scope — do not "fix"** — the bullet list from "Current state", each one line with a pointer to `FICINO_REVIEW_R10_5.md` for rationale.
8. **Git policy** — never commit/push unless explicitly asked; conventional commits.

### Step 2: Accuracy pass

For every command in the file, verify it exists where claimed: `grep` ci.yml for the pytest invocations, `cat frontend/package.json` for the npm scripts, confirm `ruff.toml` exists at root. Fix any inaccuracy you introduced. Do NOT copy README prose — link it.

**Verify**: `cat AGENTS.md` renders cleanly; every command path exists (`ls` each referenced path).

## Test plan

- Docs-only; the test is the accuracy pass in Step 2 plus the next agent session not needing to re-derive the gates.

## Done criteria

- [ ] `AGENTS.md` exists at repo root with all 8 sections
- [ ] Every command in it is verified against the repo (Step 2)
- [ ] Only `AGENTS.md` modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- Plans 022/023 haven't landed — write sections 4/5 from the POST-land truth only if they're DONE; otherwise land them first or report.
- A command in "Current state" turns out to be wrong (drift) — report the correct one.

## Maintenance notes

- AGENTS.md must be updated whenever verification commands, the schema rule, or the settled-scope list changes — it's listed in every plan's blast radius going forward by convention.
- Keep it under ~100 lines forever; it is a map, not a manual. Detail lives in README/docs; AGENTS.md points.
