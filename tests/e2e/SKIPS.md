# E2E skip inventory

Tracking artifact for plan 036 (and the R10.5 note that no such inventory
existed). Every skip/fixme in the suite, one line each, categorized.

**Rule (plan 036 maintenance):** `test.skip(true, …)` for MISSING DATA is
banned. New specs must seed data preconditions via
`tests/e2e/helpers/ensureFeed.ts` and fail hard when a seeded precondition
is absent. Skips are only acceptable for genuine environment gates, and
they must be listed here.

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
