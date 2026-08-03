# Plan 037: Add a CI gate for the Playwright e2e suite

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- .github/workflows/ci.yml playwright.config.ts tests/e2e/ docker-compose.yml`
> If any in-scope file changed since this plan was written, compare against
> the live files before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: M–L
- **Risk**: MED
- **Depends on**: plans/036-e2e-fixture-seeding.md (its fixture mechanism makes specs data-independent — without it a CI e2e job has nothing reliable to run), plans/022-full-schema-init-sql.md (CI loads the full schema from init.sql alone — the e2e job's database depends on that)
- **Category**: tests
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

The 219-test Playwright suite — the only end-to-end verification layer — runs manually against a developer's live stack, when someone remembers. The frontend CI job verifies build/lint/unit but never boots the app. Regressions in real user flows are currently caught in production. With plan 036's fixtures making the suite data-independent, a CI job can boot the compose stack, seed fixtures, and gate on the result.

## Current state

- `.github/workflows/ci.yml` — 5 jobs: python-lint, api-tests, worker-tests, shared-tests, frontend. api-tests/worker-tests already show the postgres-service + schema-load pattern (post-022: one `psql -f infra/postgres/init.sql` step).
- `playwright.config.ts` — `workers: 1, retries: 0, fullyParallel: false`, projects `desktop` + `mobile`, baseURL from `E2E_BASE_URL` or `http://localhost:3000/ficino`.
- `docker-compose.yml` — 5 services (frontend on :3000, api, worker, postgres, redis) with health checks; env from `.env`.
- Root `package.json` holds `@playwright/test` (e2e lives at repo root, not in frontend/).
- LLM dependency: specs that require REAL generation (LLM calls) can't run in CI without keys — plan 036 categorized these as environment gates in `tests/e2e/SKIPS.md`. The CI job runs the fixture-runnable subset; the honest way to select it is a Playwright project or grep tag (Step 2).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| YAML lint | `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` | exit 0 |
| Local rehearsal | replicate the job's steps locally: `docker compose up -d --build`, seed fixtures, `E2E_BASE_URL=http://localhost:3000/ficino npx playwright test --project=desktop <subset>` | green |
| Real gate | push and watch the Actions run | e2e job green (report the run URL) |

## Scope

**In scope**:
- `.github/workflows/ci.yml` — one new `e2e` job
- `playwright.config.ts` — only if a CI project/tag selection needs a config entry
- `tests/e2e/SKIPS.md` — record which specs the CI job runs vs skips and why (one line)
- Optionally `tests/e2e/helpers/` — only if the plan-036 helper needs env parameterization it doesn't already have

**Out of scope**:
- Changing spec files (036 owns them).
- Production code, docker-compose.yml service definitions.
- Secrets/LLM keys in CI — do NOT add paid API keys to CI; LLM-dependent specs stay out of the gate (documented in SKIPS.md).
- Playwright browser caching refinements beyond the standard `npx playwright install --with-deps chromium` step.

## Git workflow

- Branch: `advisor/037-e2e-ci-gate` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): `test(ci): add playwright e2e gate job`.

## Steps

### Step 1: Design the job

New `e2e` job in `.github/workflows/ci.yml`:

- `runs-on: ubuntu-latest`.
- Checkout; `actions/setup-node@v5` (node 22+, `cache: npm` if a root lockfile covers it).
- Env: `AUTH_PROVIDER=none`, `STORAGE_PROVIDER=local`, `DATABASE_URL`/compose env pointed at the job's postgres — decide between two shapes (pick the one the compose file supports with the least surgery; document the choice):
  - **A. Full compose**: `docker compose up -d --build` with a CI env file (`.env.ci` — create it in-repo with CI-safe dummy values, NO secrets), wait on health checks, run against `http://localhost:3000/ficino`.
  - **B. Service postgres + locally-run api/worker**: heavier to wire; only if A proves unworkable.
- Seed: apply `infra/postgres/init.sql` (post-022 full schema), then run the plan-036 fixture helper against the CI database.
- Run: `npx playwright install --with-deps chromium`, then the CI subset (Step 2).
- Upload `tests/results/` as an artifact on failure (`actions/upload-artifact@v4`, `if: failure()`).

### Step 2: Select the CI-runnable subset

From `tests/e2e/SKIPS.md` (plan 036), determine which specs are fixture-runnable without LLM keys. Selection mechanism, in order of preference: (a) a `ci` Playwright project in `playwright.config.ts` with a `grep`/`testIgnore` that excludes LLM-dependent and known environment-gated specs; (b) an explicit spec-file list in the workflow. Keep the desktop project only (mobile doubles runtime; note mobile as a follow-up).

### Step 3: Local rehearsal

Reproduce the job locally end-to-end (command table). The job definition must be born green — do not push an untested CI job and iterate on CI.

### Step 4: Real gate

Push (or ask the operator to push) and confirm the Actions run is green; paste the run URL in your report. If flakes appear, fix the SUITE (timeouts, missing waits), never paper over with retries — `retries: 0` is deliberate.

## Test plan

The e2e job itself. Born-green locally (Step 3) + green on the real runner (Step 4).

## Done criteria

- [ ] `ci.yml` parses; new `e2e` job present with artifact upload on failure
- [ ] Local rehearsal green
- [ ] Real Actions run green (URL in report)
- [ ] SKIPS.md updated with the CI run/skip split
- [ ] No LLM/secret values anywhere in the workflow or `.env.ci`
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 036's fixture mechanism doesn't exist or isn't env-parameterizable — land 036 first.
- Plan 022 hasn't landed (CI can't build the full schema from init.sql alone) — land 022 first.
- The compose stack can't boot in GitHub Actions runners as shaped (resource limits, port conflicts) — report what failed; shape B is the fallback, not improvisation.
- The suite is green locally but flakes twice on the real runner with distinct causes — report the causes; the job may need to land as non-blocking (`continue-on-error`) for one soak week, but ONLY with the operator's sign-off, never silently.
- `.env.ci` would need any real secret — it must not; report if some spec absolutely requires one.

## Maintenance notes

- New e2e specs default INTO the gate unless they're LLM-dependent (documented in SKIPS.md) — keep the `ci` project selection rules obvious.
- Runtime watch: if the job exceeds ~15 min, split by spec area rather than raising timeouts.
- Mobile project and LLM-backed smoke (with a budget-capped key) are named follow-ups, deliberately out of scope.
