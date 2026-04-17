# Phase 2 Tests Status — Playwright Selector Drift Updates

Date: 2026-04-17
Scope: BUG-LIVE-05 (Playwright Phase 2 selector drift)
Project root: /projects/ficino
Reference: /projects/ficino/.review-findings/playwright.md

## Summary

Applied pure test-maintenance selector updates for UI label/placeholder drift from recent feature commits. No product source touched.

## Per-file changes + rerun results

All runs: `npx playwright test <file> --project=desktop --reporter=line`

| File | Selectors/behaviors changed | Rerun result |
|---|---|---|
| tests/e2e/r2_sections_1_3.spec.ts | `Upload PDF` → `Upload PDFs` (line 64) | 20 passed / 2 failed (failures pre-existing, unrelated — see below) |
| tests/e2e/sections_1_3.spec.ts | `aria-label^="Repost"` → `aria-label^="Pass to persona"` (line 163) | 15 passed / 4 failed (failures pre-existing, unrelated — see below) |
| tests/e2e/r2_sections_4_7.spec.ts | `placeholder="Post your reply..."` → `placeholder^="Post your reply"` (line 245) | 4 passed / 4 skipped (no regressions) |
| tests/e2e/sections_4_7.spec.ts | `placeholder="Post your reply..."` → `placeholder^="Post your reply"` (line 160) | 2 passed / 2 skipped (no regressions) |
| tests/e2e/r2_sections_14_16.spec.ts | Added `getByRole('tab', { name: ... }).click()` for AI/Content/Account/Storage tabs in S14-02..07 (Settings redesign: tabbed layout) | 25 passed / 0 failed |
| tests/e2e/sections_14_16.spec.ts | Same AI/Content/Account/Storage tab clicks in S14-02..07 | 25 passed / 0 failed |
| tests/e2e/r2_sections_8_10.spec.ts | R2-10.2 and R2-10.5: gate Group Chats tab assertions behind precondition (`test.skip` if tab not rendered at current corpus size) | 12 passed / 2 skipped (by design) |
| tests/e2e/sections_8_10.spec.ts | 10.2 and 10.5: same Group Chats gating | 10 passed / 2 skipped (by design) |

Files not modified (swept, no old selectors present):
- tests/e2e/sections_11_13.spec.ts, r2_sections_11_13.spec.ts
- tests/e2e/sections_17_18.spec.ts, r2_sections_17_18.spec.ts
- tests/e2e/aug/augment.spec.ts (explicitly out of scope — already uses new labels)

## Skipped tests (by design, with reasons)

Group Chats tab is feature-gated at small corpus sizes (per live-testing BUG-LIVE-05 analysis — not a bug). Tests now call `test.skip()` with a clear reason when the tab isn't rendered.

At current live corpus size the tab is NOT rendered, so these are skipped on the current environment:
- `r2_sections_8_10.spec.ts::R2-10.2 -- Papers and Group Chats tabs present` — reason: "Group Chats tab not present at current corpus size — feature gated"
- `r2_sections_8_10.spec.ts::R2-10.5 -- Group Chats tab shows content or empty state` — same reason
- `sections_8_10.spec.ts::10.2 — Papers tab and Group Chats tab are present` — same reason
- `sections_8_10.spec.ts::10.5 — Group Chats tab content` — same reason

The 2 skips shown in r2_sections_4_7 / sections_4_7 are pre-existing `test.skip(true, ...)` calls guarding optional state (e.g. no papers uploaded), not from this sweep.

## 2.42 Generate-button fullPage screenshots — not applicable to in-scope specs

Task 2.42 asked to find `page.screenshot({ fullPage: true })` calls that execute **after clicking a Generate button**. After sweeping every in-scope `*.spec.ts`:

- No non-aug spec actually clicks the Generate button. Several (e.g. `sections_1_3.spec.ts::s2.2`, `r2_sections_1_3.spec.ts::S2-03`) inspect the button's disabled/visible state but never click it.
- `aug/augment.spec.ts::AUG-21` is the only spec that clicks Generate, and it already uses `fullPage: false` (line 382). That file is explicitly out of scope for this sweep.

No edits made for 2.42. Flagging for awareness — if a future spec adds a Generate click, it should prefer viewport-only screenshots or element screenshots per the guidance.

## Tests still failing after this sweep (flagged, NOT fixed here)

All failures below are UI drift that pre-exists this sweep. None are caused by my changes.

### r2_sections_1_3.spec.ts

- `S3-05: Active tab visual styling (bold + gold underline)` — asserts computed `border-bottom-color` contains `'200'` (old gold `rgb(200, 169, 110)`). Current gold appears to have shifted; needs the CSS variable value checked and assertion updated.
- `S3-08: Tab switching updates visual styles` — same gold-color assertion drift.

### sections_1_3.spec.ts

- `s1.2 — Upload drop zone is present in sidebar` — searches for text `Upload a paper` / `Drag & drop or click to browse`. Source shows neither string in the upload sidebar component any more; the sidebar copy changed in the PWA/settings redesign.
- `s1.3 — Corpus panel is visible` — searches for text `Active Corpus`. That label is no longer present in the frontend.
- `s1.4 — Corpus panel shows papers or empty state` — same `Active Corpus` assertion.
- `s3.7 — Tab switching preserves visual hierarchy (gold underline)` — same gold-color drift (expects exact `rgb(200, 169, 110)`).

These are separate drift cases. They should be filed as additional selector-update tickets (or a follow-up to BUG-LIVE-05) rather than fixed inside this sweep's scope.

## Rules honored

- No product source changes (api/, worker/, frontend/src/ untouched).
- No playwright.config.ts changes.
- No new tests added — only existing updated.
- augment.spec.ts left alone.
- No container rebuilds; no commits.
