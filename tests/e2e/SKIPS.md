# E2E skip inventory

Tracking artifact for plan 036 (and the R10.5 note that no such inventory
existed). Every skip/fixme in the suite, one line each, categorized.

**Rule (plan 036 maintenance):** `test.skip(true, …)` for MISSING DATA is
banned. New specs must seed data preconditions via
`tests/e2e/helpers/ensureFeed.ts` and fail hard when a seeded precondition
is absent. Skips are only acceptable for genuine environment gates, and
they must be listed here.

## How to run

The suite runs against a throwaway loopback stack (`docker-compose.e2e.yml`,
compose project `ficino-e2e`), never against a real deployment:

- **Gate (`ci` project):** `scripts/e2e-stack.sh up && scripts/e2e-stack.sh ci`.
  No LLM or embedding backend; the exclusions are under "CI gate split" below.
- **Full suite (desktop + mobile, real local models):**
  `scripts/e2e-stack.sh up --ollama && scripts/e2e-stack.sh full`. It seeds
  one real paper first.
- Use a fresh `up` for every acceptance run, and always finish with
  `scripts/e2e-stack.sh down` (it removes the stack's containers and volumes).
- Each run writes a JSON report to `tests/results/e2e-ci.json` or
  `tests/results/e2e-full.json` that lists every skipped test. Every skip
  must match an entry in this file; a skip not listed here is a failure to
  investigate, the same as a failed test.

## Environment-gated (legitimate, kept)

- `review.spec.ts:140` (R-06) — `test.skip(true, …)`: service worker cannot
  register under a self-signed HTTPS cert in the local environment; needs a
  trusted cert or non-HTTPS localhost origin. Only surviving
  `test.skip(true, …)` in the suite.

## Settled R10.5 deferral (out of scope for plan 036, do not "fix" here)

- `review.spec.ts:71` (R-03) — bare `test.skip()` when the compose box is
  absent (feature gated/renamed).
- `review.spec.ts:91` (R-04) — bare `test.skip()` in single-workspace mode
  (dropdown renders only with ≥2 workspaces).
- `review.spec.ts:169` (R-07) — bare `test.skip()` when no sign-out UI is
  visible (AUTH_PROVIDER=none).

## Product-gap skips (mobile viewport — see wave-5 report PRODUCT BUGS)

- `r2_sections_14_16.spec.ts:54` — Settings unreachable on the mobile
  viewport (no bottom-nav item, no keyboard shortcut).
- `r2_sections_14_16.spec.ts:220` — section tests desktop's Main-navigation
  bar + Settings, both absent on mobile.
- `r2_sections_11_13.spec.ts:496` — no Alerts nav icon on the mobile bottom
  nav to check a badge on.
- `aug/augment.spec.ts:289` — Settings unreachable on the mobile viewport.

## fixme (isolation debt, not data-dependent)

- `aug/augment.spec.ts:424` (AUG-21) — `test.fixme`: rapid Generate-button
  double-click needs a seeded per-test workspace or local backend for
  isolation; route stubs already in place. The former conditional skip
  inside it is now a hard assertion (fixtures seeded by beforeAll).

## Converted by plan 036 (were data-dependent conditional skips)

- `r2_sections_4_7.spec.ts` — 15 sites (feed posts / thread / figure /
  reply buttons / sources) → fixtures via `ensureFeedFixtures()` in
  `test.beforeAll`; missing preconditions now fail hard.
- `r2_sections_8_10.spec.ts` — 6 sites (bookmarkable posts, feed history,
  paper chat) → same.
- `aug/augment.spec.ts:440` (inside AUG-21) → hard assertion.

## CI gate split (plan 037)

The `e2e` job in `.github/workflows/ci.yml` runs the `ci` Playwright project
(desktop viewport, fixtures seeded by globalSetup) against a compose stack
with NO LLM/embed backend. Everything runs EXCEPT:

- `round9_core_flows.spec.ts` — R9-01 waits on real upload processing
  (embeddings) and R9-02 expects a real archivist (LLM) reply. Excluded via
  `testIgnore`.
- `wave4_group_chat.spec.ts` — `uploadAndWaitComplete` needs embeddings and
  the synthesis poll needs an LLM. Excluded via `testIgnore`.
- `r2_sections_14_16.spec.ts:320` (R2-S16-09) — keyboard "." dispatches a
  REAL feed generation. Excluded via `grepInvert`.
- `review.spec.ts:140` (R-06) — still self-skips in CI (unconditional
  `test.skip(true, …)`), as do the AUTH_PROVIDER=none bare skips above.
  On the CI job's FRESH database R-04 always skips too (exactly one
  workspace → dropdown not rendered); on a junk-accumulated dev DB it runs.

New specs default INTO the gate; if one needs real generation, exclude it
in the `ci` project and list it here. Mobile project and an LLM-backed
smoke with a budget-capped key are named follow-ups (plan 037).
