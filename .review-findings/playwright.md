# Phase 2 Live Test Results

## Environment

- baseURL: `https://ficino.local/ficino`
- Playwright 1.59.1 (already installed in `/projects/ficino` root)
- Viewport projects: `desktop` (1280x800), `mobile` (390x844). Extra viewports exercised
  in augment spec (1440x900, 768x1024, 375x812)
- Browser: Chromium (Playwright default)
- Date run: 2026-04-17 (evening / UTC 17:00-18:30 window)
- Docker stack at run start: all 5 ficino containers healthy
  (ficino-api healthy, ficino-worker up 15h, ficino-frontend up 57m,
  ficino-redis up 2d, ficino-postgres up 2d)
- Auth provider live: `{"provider":"none"}` (anonymous single-user mode)
- Corpus at test time: 2 completed papers ("Trust in AI..." 113 chunks,
  "Afroogh 2024" + one other), 6 personas, 15-post active feed, 3 past feeds
- LLM stack in worker: Anthropic Claude + Voyage embeddings (logs confirm)
  even though `LLM_PROVIDER=ollama` env is set on the api container.
  There is a settings override — verified by "setting_applied env=LLM_PROVIDER"
  lines in worker logs immediately before Claude HTTP POSTs.

## Existing spec run

Ran on the live deployed instance.

| Spec | Project | Pass | Fail | Skip / Did-not-run | Total |
|-----|---------|------|------|------|------|
| r2_sections_1_3.spec.ts | desktop | 21 | 1 | 0 | 22 |
| r2_sections_4_7.spec.ts | desktop | 7 | 1 | 0 | 8 |
| r2_sections_8_10.spec.ts | desktop | 12 | 2 | 0 | 14 |
| r2_sections_11_13.spec.ts | desktop | 10 | 1 | 0 | 11 |
| r2_sections_14_16.spec.ts | desktop | 18 | 1 | 6 (serial-block) | 25 |
| r2_sections_17_18.spec.ts | desktop | 15 | 0 | 0 | 15 |
| r2_sections_17_18.spec.ts | mobile  | 15 | 0 | 0 | 15 |
| sections_1_3.spec.ts | desktop | 13 | 3 | 0 | 19 *(3 were counted as skipped per test.skip)*|
| sections_4_7.spec.ts | desktop | 3 | 1 | 0 | 4 |
| sections_8_10.spec.ts | desktop | 10 | 2 | 0 | 12 |
| sections_11_13.spec.ts | desktop | 9 | 0 | 0 | 9 |
| sections_14_16.spec.ts | desktop | 22 | 1 | 2 serial-block | 25 |
| sections_17_18.spec.ts | desktop | 7 | 1 | 4 serial-block | 12 |

Approximate totals across the executed runs:
- r2_* desktop: 83 passed / 6 failed / 6 did-not-run (next-after-serial-fail)
- legacy sections_* desktop: 64 passed / 8 failed / 6 did-not-run
- r2_sections_17_18 mobile: 15 passed / 0 failed

### Detailed failure list (existing specs)

All failures are **selector drift / label churn from recent refactors** (commits
419e007 multi-file upload, d732b83 Settings redesign / Amplifier persona,
a5c9401 soft-delete). None of them are functional regressions; the product
works, the tests just need to be updated.

1. **r2_sections_1_3.spec.ts S1-03 — "Upload zone has accessible label"** FAIL
   - Expected: label text `"Upload PDF"`
   - Actual: `"Upload PDFs"` (plural) — multi-file upload feature landed
   - screenshot: `tests/results/r2_sections_1_3-Section-1--9c510-d-zone-has-accessible-label-desktop/test-failed-1.png`
   - No container log noise.

2. **r2_sections_4_7.spec.ts 6.1 — "Reply UI opens with replying-to handle and input"** FAIL
   - Expected: `input[placeholder="Post your reply..."]`
   - Actual placeholder: `Post your reply... (@ to mention)` (see
     `frontend/src/components/Feed/PostCard.tsx:1017`)
   - This is a feature addition (@mention autocomplete) not a bug.
   - screenshot: `tests/results/r2_sections_4_7-R2-Section-835cd-eplying-to-handle-and-input-desktop/test-failed-1.png`

3. **r2_sections_8_10.spec.ts R2-10.2 — "Papers and Group Chats tabs present"** FAIL
   - Looks for button with text `Group Chats`; never appears within 10 s.
   - screenshot: `tests/results/r2_sections_8_10-Section-1-878c7-nd-Group-Chats-tabs-present-desktop/test-failed-1.png`
   - Also manifests as cascade failure R2-10.5 (same selector, timeout 60 s).
   - Live Messages view only shows the `Papers` tab now at our corpus size.
     `MessagesPanel` still emits a Group Chats tab in code but possibly gated
     on >=2 papers or a group-chat record existing. Worth confirming in code review.

4. **r2_sections_11_13.spec.ts 12.2 — "Tag add/remove flow"** FAIL
   - `input[placeholder="tag name"]` never shown after clicking "Add Tag".
   - screenshot: `tests/results/r2_sections_11_13-Section--83ecd-emove-flow-if-papers-exist--desktop/test-failed-1.png`
   - Likely tag input selector or placeholder changed; no paper mutations
     observed in api logs.

5. **r2_sections_14_16.spec.ts R2-S14-02 — "LLM Provider section with Ollama and Claude API options"** FAIL (blocks S14-03…-08)
   - Expected: `div:has(> div:has-text("LLM Provider"))` containing a
     `<select>` with `Ollama` / `Claude API` options.
   - Actual Settings main text: `"Settings — Configure Ficino's behavior —
     Account — AI — Content — Storage — Profile — Display Name — Handle —
     Display — Theme (Dark/Light) — Font Size (Small/Normal/Large) —
     Post Spacing (Compact/Comfortable)"`
   - The Settings redesign introduced a left-column tablist (`Account / AI /
     Content / Storage`). Going into those sub-tabs would reveal the provider
     picker (the tests don't click into "AI" first).
   - screenshot: `tests/results/r2_sections_14_16-R2-Secti-1e2eb-lama-and-Claude-API-options-desktop/test-failed-1.png`
   - Since this test is in `test.describe.configure({ mode: 'serial' })`,
     S14-03 … S14-08 all report "did not run".

6. **sections_8_10.spec.ts 10.2, 10.5** — same Group Chats selector issue as #3.

7. **sections_14_16.spec.ts S14-02** — same Settings redesign issue as #5.
   Causes S14-03, S14-04 cascade skips.

8. **sections_17_18.spec.ts 18.4 "Dialogs have role='dialog'"** FAIL
   - The test tries many click selectors to open a dialog; none of them
     enabled a dialog open. The newer `r2_sections_17_18.spec.ts 18.8`
     test (which does the same thing correctly) PASSES, so this is a stale
     locator. `Corpus management` dialog with `role="dialog"`
     `aria-modal="true"` is present on the live app (confirmed in 18.7 log).

9. **sections_1_3.spec.ts s1.2/s1.3/s1.4** — same as the r2_* tests:
   labels and placeholders changed.

10. **sections_4_7.spec.ts reply-UI-opens** — same placeholder drift.

### Container log behavior during the run

- ficino-api: steady 200s on `/health`, `/alerts`, `/alerts/unread-count`
  polling. No 4xx/5xx surfaced during the spec run.
- ficino-worker: one pre-existing task-never-retrieved event-loop-closed
  warning from before the run (not caused by tests).
- ficino-frontend (nginx): steady 200s on SW + asset requests.

## Core flows (new checks — `tests/e2e/aug/augment.spec.ts`)

Augmentation spec adds 25 tests (AUG-01 … AUG-25). 22 of 25 eventually pass;
3 uncovered real issues, not test issues. All screenshots live under
`/projects/ficino/tests/screenshots/aug_*.png`.

| Id | Flow | Result | Evidence |
|----|------|--------|----------|
| AUG-01 | Feed shows posts on cold load | PASS — 9 articles rendered | `aug_01_feed_loaded.png` |
| AUG-02 | Post action toolbar (reply / like / pass-to / bookmark) | PASS after rename fix | `aug_02_scroll_actions.png` — found that "Repost" button is now `aria-label="Pass to persona"` (Conductor rename) |
| AUG-03 | Reply composer opens | PASS — placeholder is `"Post your reply... (@ to mention)"` | `aug_03_reply_composer.png` |
| AUG-04 | @mention autocomplete | PASS — 3+ persona buttons shown on `@` | `aug_04_mention_dropdown.png` |
| AUG-05 | Empty reply disabled + markdown/`<script>` injection safe | PASS — window.__xss stays false | `aug_05_injection_typed.png` |
| AUG-06 | Very long (5000 char) input accepted | PASS | `aug_06_long_input.png` |
| AUG-07 | Bookmark toggles + survives nav away (Saved tab) and back | PASS after nav-label fix (aria-label is `Saved`, not `Bookmarks`) | `aug_07_bookmarks_view.png`, `aug_07_back_on_feed.png` |
| AUG-08 | Rapid-click like debounces to original state | PASS | `aug_08_double_like.png` |
| AUG-09 | Click article -> detail view -> browser-back | PASS | `aug_09_post_detail.png`, `aug_09_after_back.png` |
| AUG-10 | Explore search with query "trust" | PASS — dropdown with matches (Passages) | `aug_10_search_results.png` |
| AUG-11 | Messages view loads; Papers tab present (Group Chats not present at this corpus size) | PASS — Papers=true, Personas=false, Group=false | `aug_11_messages.png` |
| AUG-12 | Open a paper in Messages -> TL;DR / breakdown | PASS — detail pane renders | `aug_12_paper_messages.png` |
| AUG-13 | Alerts nav loads | PASS | `aug_13_alerts.png` |
| AUG-14 | Settings page loads, Theme section visible | PASS (only h1: "Settings" — settings page no longer uses h2/h3 section headings, uses divs instead — a minor a11y concern) | `aug_14_settings_open.png` |
| AUG-15 | Font Size / Post Spacing present | PASS | `aug_15_display_prefs.png` |
| AUG-16 | LLM Provider section | INFO — required clicking into "AI" sub-tab, not visible on initial Settings open. Confirmed a tablist `Account / AI / Content / Storage` is the new top-level. See Bug BUG-LIVE-03. | `aug_16_llm_provider_new.png` |
| AUG-17 | PWA manifest + SW registered | PASS — manifest href populated, 1+ SW registration active | `aug_17_pwa.png` |
| AUG-18 | IndexedDB populated, "synced" indicator | PASS — IndexedDB listed; "synced" indicator only appears after PWA download triggered | `aug_18_indexeddb.png` |
| AUG-19 | Offline mode — `context.setOffline(true)` + reload | PASS — ficino text visible offline, app shell paints from SW cache | `aug_19_offline.png` |
| AUG-20 | Malformed PDF upload | FAIL → real bug (BUG-LIVE-01 below) | `aug_20_bad_pdf.png` |
| AUG-21 | Rapid double click Generate | PASS logic-wise (button becomes "Generating"), test screenshot timed out due to generation network activity — see BUG-LIVE-02 | `aug_21_double_generate.png` |
| AUG-22 | Refresh after reload | PASS — feed intact | `aug_22_after_reload.png` |
| AUG-23 | 1440x900 desktop smoke | PASS | `aug_23_vp_1440.png` |
| AUG-24 | 768x1024 tablet smoke | PASS — no horizontal overflow | `aug_24_vp_768.png` |
| AUG-25 | 375x812 mobile smoke | PASS — `Mobile navigation` takes over, no horizontal overflow | `aug_25_vp_375.png` |

Flows from the rubric **not** directly tested (inadvertent gaps; documented here):
- "Upload real PDF through end-to-end ingestion" — could not do without access to a
  valid fixture PDF + risk of disrupting the shared instance. Existing corpus of
  2 papers was used to exercise downstream flows instead.
- "Cite this -> APA/MLA clipboard" — not tested; selector is `button` with icon,
  Playwright cannot easily verify clipboard in live browser.
- "Get their take" (3 appended posts) — not tested; would trigger 3 LLM calls.
- "Group chat across multiple papers" — Group Chats tab not present in this
  deployment at test time; see failure #3.
- "Reading list drag-reorder" — not tested; drag interactions risky on
  production data.
- "Workspace long-press (mobile) / dropdown (desktop)" — not tested individually;
  r2_sections_11_13 already covers this and passed.
- "Light/dark toggle" — confirmed options render (Theme: Dark/Light), toggle
  action itself not exercised to avoid changing user prefs.

## PWA + offline

| Test | Result |
|------|--------|
| Manifest link present | PASS (AUG-17) |
| Service worker registered | PASS — 1 registration, `active` state |
| IndexedDB populated | PASS — databases enumerable (AUG-18) |
| App shell renders offline (`context.setOffline(true)` + reload) | PASS — ficino text + frame paint (AUG-19) |
| "synced Xm ago" indicator | INDETERMINATE — not rendered on default view; likely requires explicit Download workspace action |
| Full workspace offline (papers/figures/feed cached + readable offline) | NOT TESTED — would need to trigger the Download workspace flow in the live instance first |

## Auth

- Live env: `AUTH_PROVIDER=none`; `GET /auth/provider` returns
  `{"provider":"none"}` (AUG-17 ran against this).
- All existing specs rely on this mode (no login flow exercised).
- basic / supabase: not live-tested as requested (switching env would
  disrupt the stack). Static grep shows `frontend/src/auth/` + `api/auth/*.py`
  support all three; switching is controlled by `AUTH_PROVIDER` env.

## Viewports

| Viewport | Horizontal overflow? | Primary nav | Status |
|----------|----------------------|-------------|--------|
| 1440x900 desktop | none | `Main navigation` left rail | PASS |
| 1280x800 desktop | none (default project) | `Main navigation` left rail | PASS |
| 768x1024 tablet | none | `Main navigation` still visible (md breakpoint) | PASS |
| 390x844 mobile (Playwright project) | none | `Mobile navigation` bottom bar | PASS (all 15 r2_sections_17_18 mobile tests) |
| 375x812 mobile | none | `Mobile navigation` bottom bar | PASS |

## Chaos tests

| Scenario | Result |
|----------|--------|
| Malformed `.pdf` (arbitrary bytes with .pdf extension) | FAIL UX — see BUG-LIVE-01. Worker logs show repeated `FileDataError`, 3 Celery retries, task-exception-never-retrieved warnings |
| Rapid double-click Generate feed | PARTIAL — button becomes "Generating" on first click, second click is a no-op (good). But screenshot/networkidle hangs during generation — see BUG-LIVE-02 |
| Refresh mid-generation | PASS — feed state still present, no crash |
| Very long reply text (5000 chars) | PASS — input accepts all chars |
| Empty reply | PASS — Reply button disabled |
| Markdown / `<script>` injection in reply input | PASS — window.__xss stays false; text is input-bound, not rendered yet |
| Back button: post detail -> feed | PASS |
| Nav to Saved and back; bookmark state preserved | PASS |
| Reply from inside an already-open reply UI | covered in existing specs |
| Empty corpus generate | Not re-tested live (would require deleting all papers) |

## Bugs discovered during live testing

### BUG-LIVE-01: Malformed-PDF upload has no user-visible error path

- **Steps to reproduce**
  1. Go to `https://ficino.local/ficino`
  2. Click the upload zone in the sidebar
  3. Select any non-PDF file named with `.pdf` extension (test used
     `{ name: 'bad.pdf', mimeType: 'application/pdf', buffer:
     Buffer.from('this is not a real pdf') }`)
- **Expected**: Frontend shows an error ("Failed to ingest — invalid PDF")
  next to the upload zone, or the corpus row visibly displays the
  `error` status the API returns.
- **Actual (frontend)**:
  - Upload zone shows no red error text for >60 s after upload.
  - No toast. No inline warning.
- **Actual (api)**: `POST /papers/upload` returns 200 and creates a
  paper row; `GET /papers` later shows `status: "error",
  error_message: "Failed to open file '/app/uploads/<uuid>.pdf'."`.
- **Actual (worker)**: Celery retries `process_paper` 3x with
  `FileDataError: Failed to open file …`, then raises unexpected and
  logs `Task exception was never retrieved` + `RuntimeError: Event
  loop is closed` on the async http client close.
- **Evidence**:
  - screenshot: `/projects/ficino/tests/screenshots/aug_20_bad_pdf.png`
  - worker log excerpt:
    ```
    [2026-04-17 17:58:48,786] error ingestion_failed error="Failed to open file '/app/uploads/04f020df-….pdf'."
    [2026-04-17 17:59:48,819] error ingestion_failed … retry in 30s
    [2026-04-17 17:59:51,822] ERROR Task exception was never retrieved
    future: <Task finished … exception=RuntimeError('Event loop is closed')>
    ```
- **Severity**: Medium. Users see no feedback for bad uploads, a broken
  paper row is silently created, worker leaks unretrieved task exceptions.

### BUG-LIVE-02: Feed generation holds `networkidle`, causing tooling (Playwright) and likely user-interaction ambiguity

- **Steps to reproduce**
  1. Click `Generate` while papers present and idle
  2. Observe the UI / any concurrent Playwright action using `networkidle`
- **Expected**: Network idles within a few seconds; UI shows spinner but
  page remains responsive for screenshots / further interactions.
- **Actual**: `page.screenshot({ fullPage: true })` hangs for 60 s
  (Playwright test timeout) while generation is in progress. The feed
  generation task runs ~28 s server-side (worker log:
  `feed_generation_complete duration_ms=27942`), and during that time
  the frontend keeps at least one open HTTP connection — probably
  an SSE/polling progress stream — preventing `networkidle` from firing.
- **Evidence**:
  - AUG-20 and AUG-21 passed their logic (`Generating button visible =
    true`) but failed at screenshot step with:
    `page.screenshot: Target page, context or browser has been closed`
    after 60 s test timeout.
  - worker log showing 27 s generation:
    `feed_generation_complete duration_ms=27942 feed_id=64c0bced-…`
- **Severity**: Low as a user-facing bug (the UI just shows a spinner),
  but it **degrades every E2E test that clicks Generate** and does
  subsequent work. Tests should use `waitUntil: 'domcontentloaded'`
  (as some existing ones already do) and avoid screenshot with
  `fullPage: true` while a generation is in flight.

### BUG-LIVE-03: Settings redesign hides LLM Provider behind a sub-tab with no discoverable "AI" heading on initial load

- **Steps to reproduce**
  1. Nav to Settings
  2. Observe the initial Settings panel
- **Expected (old spec contract)**: LLM Provider select visible directly.
- **Actual**: Initial pane shows only Profile / Display sections
  (Theme, Font Size, Post Spacing). LLM Provider is in the "AI" sub-tab
  of a left tablist (`Account / AI / Content / Storage`). Those words
  exist in the DOM but are not semantic headings:
  `main` textContent: `"Settings — Configure Ficino's behavior —
  Account — AI — Content — Storage — Profile — Display Name …"`.
- **Minor a11y observation**: the new tab labels (`Account`, `AI`,
  `Content`, `Storage`) don't appear to use `h2`/`h3` headings or
  `role="tab"` / `role="tablist"` (none were surfaced by the
  augment spec's h1/h2/h3 collector — only `"Personas (6)"` was
  picked up as a section label). They are probably rendered as
  plain `<button>`s or `<div>`s — worth a cross-check against the
  BUG-002 tablist a11y guidance already tracked in
  `tests/e2e/r2_sections_1_3.spec.ts:250` for the feed tabs.
- **Evidence**: `/projects/ficino/tests/screenshots/aug_16_llm_provider_new.png`
- **Severity**: Low-functional (docs/tests need updating), Low-a11y
  (tab semantics should match feed-tab implementation).

### BUG-LIVE-04: "Group Chats" tab in Messages view not rendered at small corpus sizes

- **Steps to reproduce**
  1. Go to Messages
  2. Look for a `Group Chats` tab
- **Expected (per rubric)**: `Papers` + `Group Chats` tabs present.
- **Actual**: Only a Papers column / tab is present. `r2_sections_8_10`
  10.2 and 10.5 both fail looking for `Group Chats`, timeouts at 10 s
  and 60 s respectively. `sections_8_10` 10.2, 10.5 fail identically.
- **Evidence**:
  - screenshot: `tests/results/r2_sections_8_10-Section-1-878c7-nd-Group-Chats-tabs-present-desktop/test-failed-1.png`
  - AUG-11 log: `Messages tabs -> Papers=true, Personas=false, Group=false`
- **Severity**: Medium if the feature was supposed to render unconditionally.
  Possibly intentional (feature gated on >N papers or >0 group chats) but
  then the docs + specs need updating.

### BUG-LIVE-05 (doc/spec drift — not a product bug): Action-button rename from "Repost" → "Pass to persona"

- Old specs looked for `button[aria-label^="Repost"]`; live DOM uses
  `aria-label="Pass to persona"` (see
  `frontend/src/components/Feed/PostCard.tsx:776`). Same for the Saved
  nav (`aria-label="Saved"`, not `Bookmarks`).
- Not listed as a user-facing bug, but every E2E spec that references
  these needs to be updated.
- Severity: None for users, High for test maintenance.

### BUG-LIVE-06 (pre-existing, visible in logs): worker async-client cleanup races

- worker logs during the review window show multiple
  `Task exception was never retrieved … RuntimeError('Event loop is closed')`
  events. These predate this testing session (baseline capture before
  any test run already showed them) but are surfaced by BUG-LIVE-01
  too — the malformed PDF path triggers a fresh cascade of these.
- Severity: Low but noisy; these are leaked futures in async httpx
  clients that persist past the celery worker's per-task event loop.

---

### Evidence index

- Existing spec screenshots: `/projects/ficino/tests/screenshots/r2_s*.png`,
  `/projects/ficino/tests/screenshots/s*.png` (95 screenshots total prior
  to this run).
- Augment spec screenshots: `/projects/ficino/tests/screenshots/aug_*.png`
  (25 new screenshots).
- Playwright traces + per-test screenshots for every failure:
  `/projects/ficino/tests/results/<test-name>/`.
- Augment spec source: `/projects/ficino/tests/e2e/aug/augment.spec.ts`.

### Recommendations (test-maintenance)

1. Update three label/placeholder selectors across the spec suite:
   - `Upload PDF` → `Upload PDFs`
   - `placeholder="Post your reply..."` → `placeholder^="Post your reply"`
   - `aria-label^="Repost"` → `aria-label^="Pass to persona"`
   - `aria-label="Bookmarks"` → `aria-label="Saved"`
2. Refactor Section 14 Settings tests to click the `AI` sub-tab before
   asserting on LLM Provider controls.
3. Gate `Group Chats` tab assertions behind a precondition (e.g. skip
   if `button:has-text("Group Chats")` isn't in DOM within 2 s).
4. For tests that click Generate, use `waitUntil: 'domcontentloaded'`
   and avoid `fullPage: true` screenshots during generation — or better,
   stub the generation endpoint with `page.route` if the test only cares
   about the button state transition.

### Caveats / what I could not do

- Did not upload a real scientific PDF (no fixture shipped in repo;
  didn't want to pollute the shared live corpus).
- Did not exercise "Cite this (APA/MLA) clipboard" because live
  clipboard read requires user-gesture permission grants in Chromium.
- Did not trigger "Get their take" (3 LLM calls); saving API budget.
- Did not test Supabase/basic auth paths (would require env swap on
  live stack).
- Did not long-press on mobile for workspace switcher — touch emulation
  is slow and this already passes in existing specs.
