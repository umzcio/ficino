# Plan 036: Replace data-dependent e2e skips with explicit fixtures

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- tests/e2e/`
> If any in-scope file changed since this plan was written, compare against
> the live specs before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but plan 037 builds on this one)
- **Category**: tests
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

~23 e2e tests silently skip when the shared dev DB happens to lack data (`test.skip(true, 'No posts in feed…')` and variants across feed rendering, bookmarks, feed history, and paper chat). The same commit can report 219 passed or dozens of silent skips depending on mutable dev-DB contents — a green run proves nothing about those paths. This is distinct from the settled R10.5 test-infra items (bare skips in review.spec.ts, junk-data accumulation): the conditional-skip pattern is NOT in the deferral list.

## Current state

- Conditional skips (verified counts via grep): `tests/e2e/r2_sections_4_7.spec.ts` (~15 sites: lines 32,50,59,107,116,138,147,181,189,221,230,272,278,303,312), `tests/e2e/r2_sections_8_10.spec.ts` (~6 sites: lines 108,138,295,333,345,445), `tests/e2e/aug/augment.spec.ts:440`. Typical shape (read several before editing):

```ts
  const posts = page.locator('article');
  if (await posts.count() === 0) {
    test.skip(true, 'No posts in feed — skipping');
  }
```

- The specs hit the live dev stack (`playwright.config.ts`: baseURL `http://localhost:3000/ficino`, workers: 1, retries: 0) backed by the dev Postgres (docker-compose service `ficino-postgres`, user/db/password `ficino`).
- The feeds table shape: `feeds (id, user_id, corpus_id, tag_filter, posts jsonb, paper_count, post_count, generation_duration_ms, created_at, ...)`. Feed posts are JSONB blobs — a fixture feed needs only plausible post objects (see `worker/tasks/persona_tasks.py:725-775` for the fields posts carry: `id`, `persona`, `post_type`, `content`, `time`, `paper_ref`, `sources`, `category`, ...). Read 2-3 specs' expectations to learn the minimum fields their selectors need (article rendering, source reveal, bookmark button).
- User/workspace scoping: the dev stack runs with some AUTH_PROVIDER — check `.env` (do not print secrets; only check `AUTH_PROVIDER` and dev user ids) and how specs authenticate, so the fixture feed's `user_id`/`corpus_id` match what the browser session sees. `infra/postgres/init.sql` has the feeds/users/workspaces DDL.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Stack up | `docker compose up -d` | healthy |
| Run affected specs | `npx playwright test tests/e2e/r2_sections_4_7.spec.ts tests/e2e/r2_sections_8_10.spec.ts --project=desktop` | pass WITHOUT the data-dependent skips firing |
| Full suite | `npx playwright test --project=desktop` | pass or only pre-existing/env skips |

## Scope

**In scope**:
- `tests/e2e/helpers/` (create — seed/ensure helpers)
- `tests/e2e/r2_sections_4_7.spec.ts`, `tests/e2e/r2_sections_8_10.spec.ts`, `tests/e2e/aug/augment.spec.ts` (replace conditional skips with fixture usage)
- `tests/e2e/fixtures/` (create — fixture JSON/SQL if that's the chosen mechanism)

**Out of scope**:
- The settled R10.5 test-infra items: bare `test.skip()`s in `review.spec.ts`, the triplicated `navTo` helper, `withDmIds` re-stamping, junk-data accumulation. Do not "improve" those here.
- CI wiring of e2e (plan 037).
- Any spec not exhibiting the conditional-skip pattern.
- Production code — fixtures must use existing API/DB surfaces only.

## Git workflow

- Branch: `advisor/036-e2e-fixture-seeding` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): `test(e2e): replace data-dependent skips with explicit fixtures`.

## Steps

### Step 1: Choose the seed mechanism (decide from evidence, then follow through)

Two candidate mechanisms; pick ONE based on what the specs actually need:

- **A. DB fixture insert (preferred if specs only need READ paths)** — a helper that inserts a fixture feed row (and any needed paper/workspace rows) directly into the dev DB via `docker exec ficino-postgres psql`, tagged so it's identifiable (e.g. a marker in `tag_filter` or a fixed feed id namespace), with a matching cleanup. No LLM spend, deterministic, fast. Downside: writes to the shared dev DB (already a known condition — R10.5 item; keep fixtures clearly marked and idempotent: INSERT ... ON CONFLICT DO UPDATE with fixed ids).
- **B. API-driven seeding** — upload a small PDF + trigger generation. Realistic but slow, LLM-dependent, and costs API spend. Use only if specs exercise paths DB fixtures can't produce (check: do any conditional-skip specs require REAL generation output, e.g. TTS or podcast status? If yes, those specs keep an ENV-gated skip — that's honest, not silent).

Document the choice and reasoning in a header comment in the helper file.

### Step 2: Build the helper

`tests/e2e/helpers/ensureFeed.ts` (or `.sql` + a thin TS wrapper): exports `ensureFeedWithPosts(page-less context)` that idempotently creates the fixture data (fixed fixture ids under a reserved uuid namespace like `e2e00000-...`) and returns what it created. Include `cleanupFixtures()` and wire it into the specs' afterAll (or leave fixtures in place idempotently — decide and document; the dev DB already accumulates junk, so idempotent leave-in-place with fixed ids is acceptable and simpler).

### Step 3: Convert the conditional skips

For each of the ~23 sites: replace `test.skip(true, 'No posts…')` with a `beforeAll`/`beforeEach` call to the helper, and let the test FAIL HARD if its preconditions still aren't met (a missing fixture after seeding is a real failure — that's the point). Preserve genuinely environmental skips (missing TTS key, offline-mode skips — keep those, they're environment gates, not data gates).

**Verify**: run the two r2 spec files (command table) with the dev DB in a state that WOULD previously have skipped (e.g. fresh fixture ids prove the helper created the data) → tests run and pass instead of skipping.

### Step 4: Skip inventory

Add a short `tests/e2e/SKIPS.md`: every remaining skip in the suite, one line each, categorized (environment-gated vs settled-deferral vs product-gap like the mobile-nav skips). This is the tracking artifact R10.5 noted was missing.

**Verify**: full desktop project run (command table) → green, and `grep -rn "test.skip(true" tests/e2e/` returns 0 (or only documented environment gates listed in SKIPS.md).

## Test plan

The converted specs themselves. Success = the previously-skipped tests execute against fixtures and pass; a forced-broken fixture makes them FAIL (spot-check one by temporarily breaking a fixture field, then revert).

## Done criteria

- [ ] `grep -rn "test.skip(true" tests/e2e/` → 0 matches (or only SKIPS.md-documented environment gates)
- [ ] The two r2 spec files pass on desktop with fixtures, no data-dependent skips firing
- [ ] Full desktop project green
- [ ] `tests/e2e/SKIPS.md` exists and covers every remaining skip
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The dev stack won't come up or the specs can't authenticate (missing `.env`, missing LLM keys for specs that need them) — report what's missing; do NOT commit or print any secret values.
- A meaningful subset of the conditional-skip specs turns out to need REAL LLM-generated content (not fixture-able JSON) — convert what's fixture-able, leave the rest as documented environment gates in SKIPS.md, and report the split.
- The feeds/posts schema differs from what's described (drift) — report the actual shape.
- Fixture inserts conflict with live dev data in a way ON CONFLICT handling can't resolve.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- New specs must use the fixture helper for data preconditions — `test.skip(true, ...)` for missing data is now banned (SKIPS.md says so).
- The reserved fixture uuid namespace keeps fixtures identifiable; if the dev DB ever gets a cleanup script, it keys off that namespace.
- Plan 037 (CI gate) reuses this fixture mechanism against a scratch CI database — keep the helper env-agnostic (parameterize the psql target).
