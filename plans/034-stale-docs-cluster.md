# Plan 034: Fix the stale docs cluster (TEST_PLAN, password script, env pointer, README dev section)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- docs/TEST_PLAN.md docs/saas-deploy.md FEATURES.md .env.example README.md AGENTS.md`
> If any in-scope file changed since this plan was written, compare against
> the live files before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/031-agents-md.md (README's dev section points at AGENTS.md), plans/032-figure-detect-env-docs.md (same file: .env.example — land first to avoid conflicts)
- **Category**: docs
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

Actively-wrong docs are worse than missing ones. Four stale spots: `docs/TEST_PLAN.md` points at a dead host and describes setup ("install Playwright in frontend/", "create playwright.config.ts") that was all done differently (Playwright at repo root, config exists); `FEATURES.md` documents an operator script at `/tmp/set-my-password.sh` — an ephemeral path outside the repo that appears in no runbook; `.env.example:35` references `docs/deployment.md (TODO)`, which does not exist; README's Development section documents only api/worker pytest while the frontend and e2e gates live nowhere in the docs (only in CI YAML).

## Current state

- `docs/TEST_PLAN.md:4` — App URL `https://umzcaio.ito.umt.edu/ficino` (superseded by ficino.app / localhost:3000/ficino). Lines 8-11 describe already-done setup. Its manual-checklist role is now filled by the e2e specs in `tests/e2e/`.
- `FEATURES.md:177` — "Operator script at `/tmp/set-my-password.sh` hits Supabase's admin API to rewrite a user's password directly".
- `.env.example:35` — "See docs/deployment.md (TODO)." — that file has never existed; the real runbook is `docs/saas-deploy.md`.
- `README.md:354-378` — Development section covers only api/worker pytest + the `pip install ./shared` prerequisite.
- Post-plan-031, `AGENTS.md` exists with the full gate list (frontend lint/test/build, docker-exec pytest, ruff, playwright + shared-dev-DB warning).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Link/reference check | `grep -rn "TEST_PLAN\|deployment.md\|set-my-password" --include="*.md" --include="*.example" .` | only intended references remain |
| Markdown sanity | read each edited file end-to-end | no broken sections |

## Scope

**In scope**:
- `docs/TEST_PLAN.md` (delete)
- `docs/saas-deploy.md` (add password-override section)
- `FEATURES.md` (fix line 177's pointer)
- `.env.example` (fix line 35's pointer)
- `README.md` (dev section: point at AGENTS.md + one-line frontend/e2e summary)

**Out of scope**:
- Any other docs page; `docs/bugs001.md`/`bugs002.md` are historical reports — leave them.
- Recreating the actual password script as a repo file — the runbook section documents the PROCEDURE (Supabase dashboard or Admin API with the service-role key); do not invent a script.
- `FICINO_REVIEW*.md` historical reports.

## Git workflow

- Branch: `advisor/034-stale-docs-cluster` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): `docs: fix stale references (TEST_PLAN, password script, env pointer, dev gates)`.

## Steps

### Step 1: Delete TEST_PLAN.md

`git rm docs/TEST_PLAN.md`. Then `grep -rn "TEST_PLAN" --include="*.md" --include="*.ts" --include="*.json" .` — fix any reference (none known; report if found).

### Step 2: Password-override procedure into the runbook

Add a short "Admin password override" section to `docs/saas-deploy.md` (operator runbook tone, ~8 lines): when corporate link scanners burn the OTP recovery flow, the operator can set a user's password directly via the Supabase dashboard (Authentication → Users → select user) or via the Admin API (`PUT /admin/users/{id}` with the service-role key — note the service-role key is highly sensitive, never expose it client-side, reference where in the Supabase dashboard it lives). Do NOT include any real key, project URL, or user id.

### Step 3: Fix the two pointers

- `FEATURES.md:177` — replace the `/tmp/set-my-password.sh` sentence with a pointer to the new runbook section (`docs/saas-deploy.md#admin-password-override` — use the actual anchor your heading produces).
- `.env.example:35` — replace "See docs/deployment.md (TODO)." with "See docs/saas-deploy.md."

### Step 4: README Development section

At the end of `README.md:354-378`, add ~4 lines: frontend gates (`cd frontend && npm run lint && npm test && npm run build`), e2e (`npx playwright test` from repo root — needs the dev stack at localhost:3000/ficino, hits a shared dev DB), and "Agent-facing command reference: `AGENTS.md`." (Adjust if 031 hasn't landed — that's a dependency; STOP instead.)

**Verify**: the reference grep from the Commands table → clean; read each edited region.

## Test plan

- Docs-only; the reference grep and the read-through are the checks.

## Done criteria

- [ ] `docs/TEST_PLAN.md` deleted, no dangling references
- [ ] saas-deploy.md has the override section; FEATURES.md points at it
- [ ] `.env.example` no longer references the nonexistent file
- [ ] README dev section covers frontend + e2e + AGENTS.md pointer
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

- Something references `docs/TEST_PLAN.md` that this plan didn't anticipate (report the reference).
- Plan 031 or 032 hasn't landed (file expectations unmet) — land them first or report.
- The Supabase dashboard flow described in Step 2 is wrong for the project's Supabase version — describe what the dashboard actually offers and note the discrepancy.

## Maintenance notes

- `/tmp` paths are not documentation. Any future operator helper must live in the repo (e.g. `scripts/`) and be referenced from the runbook.
- Historical review reports (`FICINO_REVIEW*.md`, `docs/bugs00*.md`, `review/`) are intentionally exempt from staleness fixes — they're dated records, not living docs.
