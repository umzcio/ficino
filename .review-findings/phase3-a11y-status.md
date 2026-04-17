# Phase 3 Accessibility — Status

Applied 2026-04-17. Carryover (2.6) from Phase 2 plus Phase 3 a11y items (3.26–3.31). TypeScript build verified clean via `npx tsc -b --noEmit` in `frontend/`. Playwright aug spec: 24/25 pass; 1 pre-existing flaky failure unrelated to these changes (see "Surprises").

## Items shipped

| # | File:line | Change | Verified |
|---|-----------|--------|----------|
| 2.6 | frontend/src/components/Feed/PostCard.tsx:988–1002 | Reply input: added `role="combobox"`, `aria-expanded` (only true when list is visible), `aria-controls="mention-listbox"`, `aria-autocomplete="list"`, `aria-activedescendant={mentionQuery && filtered.length ? \`mention-option-${mentionIdx}\` : undefined}`. Existing `aria-label={\`Reply to ${p.name}\`}` preserved. | tsc |
| 2.6 | frontend/src/components/Feed/PostCard.tsx:1045–1075 | Mention dropdown: `<div>` → `<ul role="listbox" id="mention-listbox" class="... list-none p-0 m-0">`; each `<button>` option → `<li role="option" id="mention-option-{i}" aria-selected={i === mentionIdx}>`. `list-none p-0 m-0` reset keeps visual identical. All existing mouse handlers (`onMouseEnter`, `onMouseDown`) preserved so click-to-select and hover-highlight still work. Arrow keys / Enter / Escape logic in parent keyDown handler untouched. | tsc, playwright |
| 3.26 | frontend/src/components/Explore/ExploreView.tsx:287 | `<h1>Explore</h1>` → `<h2>` | tsc |
| 3.26 | frontend/src/components/ReadingLists/ReadingListsView.tsx:60 | `<h1>Reading Lists</h1>` → `<h2>` | tsc |
| 3.26 | frontend/src/components/Alerts/AlertsView.tsx:123 | `<h1>Alerts</h1>` → `<h2>` | tsc |
| 3.26 | frontend/src/components/Bookmarks/BookmarksView.tsx:29 | `<h1>Bookmarks</h1>` → `<h2>` | tsc |
| 3.26 | frontend/src/components/Messages/Inbox.tsx:48 | `<h1>Messages</h1>` → `<h2>` | tsc |
| 3.26 | frontend/src/components/Settings/SettingsView.tsx:40 | `<h1>Settings</h1>` → `<h2>` | tsc |
| 3.27 | frontend/src/App.tsx:238–272 (FeedTabs) | Added `tabRefs`; `handleKeyDown` implements ArrowLeft/ArrowRight (with wrap), Home (first), End (last). Active tab has `tabIndex={0}`, inactive `tabIndex={-1}` (roving tabindex). Selection + focus move together. No visual/styling changes. `useRef` was already imported at line 1. | tsc, playwright |
| 3.28 | Avatar alt audit across `components/` | All persona avatars already had `alt={persona.name}` / `alt={p.name}` / `alt={displayName}` (PostCard 82, 855, 796, 919, 1051; PersonaPanel 28; PersonaProfile 86, 209, 232; ExploreView 251; Inbox 139; PostDetail 82; UserPostCard 97 "The Archivist"). No changes needed. | manual |
| 3.28 | frontend/src/components/Nav/MobileDrawer.tsx:50–54 | Logo img in drawer header: `alt="ficino"` → `alt=""` (decorative; adjacent visible "ficino" text label covers it). | tsc |
| 3.29 | frontend/src/index.css:81–88 | Added `.animate-spin { animation: none !important; }` inside existing `@media (prefers-reduced-motion: reduce)` block. Spinner icons freeze for users with reduced-motion preference. | tsc |
| 3.30 | frontend/src/components/Nav/WorkspaceBottomSheet.tsx:40–46 | Close `<X>` button: added `aria-label="Close workspaces"`. | tsc |
| 3.30 | frontend/src/components/ReadingLists/ReadingListDetail.tsx:198 | Back arrow button (overview): added `aria-label="Back to reading lists"`. | tsc |
| 3.30 | frontend/src/components/ReadingLists/ReadingListDetail.tsx:131 | Back arrow button (chapter view): added `aria-label="Back to overview"`. | tsc |
| 3.30 | frontend/src/components/ReadingLists/ReadingListDetail.tsx:243–256 | GripVertical move-up/down buttons: added `aria-label="Move up"` / `"Move down"`. | tsc |
| 3.30 | frontend/src/components/ReadingLists/ReadingListsView.tsx:116 | Trash2 delete list button: added `aria-label={\`Delete ${list.name}\`}`. | tsc |
| 3.30 | frontend/src/components/Sidebar/CorpusPanel.tsx:97 | CheckCircle confirm-tag button: added `aria-label="Add tag"`. | tsc |
| 3.30 | frontend/src/components/Feed/UserPostCard.tsx:54 | Trash2 delete-user-post button: added `aria-label` that mirrors the confirm state (`"Delete post"` / `"Click again to confirm delete"`); kept existing `title` tooltip. | tsc |
| 3.31 | frontend/src/App.tsx:180–190 | Mobile `<img>` logo wrapped in `<button type="button" aria-label="Open menu" onClick={onMobileLogoTap} className="bg-transparent border-none p-0 cursor-pointer md:hidden">`; inner `<img>` `alt="ficino"` → `alt=""` (button aria-label is the accessible name); `md:hidden` moved from img to button so the button (not the image) is hidden on desktop. | tsc |

## Items intentionally skipped / out of scope

None. Every item in the requested list was applied. The following were *reviewed and left alone* because they were already correct:

- **Phase 2 already-shipped items** (Feed `<ol role="feed">`, `useFocusTrap`, Settings tablist arrow-key nav) left untouched per instructions.
- **LoginPage.tsx:31** retains its `<h1>ficino</h1>` because it is the login page (a separate page from the app shell) and is the only heading on that page — no hierarchy problem.
- **Icon buttons already labeled**: `FigureLightbox` close (PostCard 53), `Back` in PersonaProfile 68, `Back to feed` in PostDetail 131, `Close drawer` in MobileDrawer 62, `Close` in DownloadProgress 24, `Dismiss` / `Install Ficino` in InstallPrompt, `More options` trigger in PostCard 407, `Go back` in GroupChatView 69 and PaperChat 115, `Search settings` in SettingsSearch 61, all mobile-nav items in App.tsx, `Rename/Delete {ws.name}` in ExploreView 367/378 and WorkspaceDropdown 96/103, `Download {ws.name} for offline` in WorkspaceDropdown 90 — all already have `aria-label`s.
- **Buttons with adjacent visible text** (ExploreView "New Workspace" Plus+span, Sidebar "Search corpus…" button, FeedHistory chevron+text, ReadingListsView Create button, Alerts "Mark all read", Inbox paper/group/thread rows with rich content, Settings saved-state Check, CorpusPanel "View summary" / "Remove" / "#Add tag") — have accessible names from the text content; no redundant aria-label added.
- **PostCard.tsx:1051 mention dropdown avatar** left `alt={mp.name}` (not `""`) because the visible persona name is part of the option row but the option's accessible name will be derived from the full row text by screen readers; keeping `alt` as the name is harmless and mirrors other persona-picker menus (e.g. 796, 919).

## Surprises / side-effects

- **FeedTabs roving tabindex**: prior to this change every tab had `tabIndex=0` (default). Now only the active tab is 0 and the others are -1. This matches the Settings tablist pattern shipped in Phase 2. Behavior: Tab into the tablist puts focus on the active tab; ArrowLeft/Right moves within the list; Tab moves out. Verified visually via Playwright — no layout change.
- **Combobox semantics on an `<input>` with `role="combobox"`**: this is the ARIA 1.2 "pattern C" (combobox as a single input plus listbox popup). The `aria-expanded` must only be `true` when the listbox is actually displayed; I ANDed it with `mentionFiltered.length > 0` to avoid announcing "collapsed" when the list is simply empty.
- **`<ul>` / `<li>` semantic switch for the listbox**: Tailwind's default `<ul>` margins/padding would have changed the dropdown layout. Added `list-none p-0 m-0` to the `<ul>` and `list-none` to each `<li>` to keep pixels identical.
- **`onMouseDown` on `<li>`**: React synthesizes `onMouseDown` on non-button elements fine. Preventing default inside it keeps the input from losing focus before `insertMention` runs — same behavior as the previous `<button>` version.
- **Mobile logo `md:hidden`**: moved from the inner `<img>` to the outer `<button>`. Otherwise the button would still render (invisibly) on desktop and intercept clicks. Tested at desktop via Playwright — 24/25 still pass.
- **`UserPostCard.tsx` delete button**: has both `title` (tooltip) and now `aria-label`; the aria-label is what screen readers will use, the title remains for hover tooltips. They match in meaning.
- **Playwright AUG-21 failure is pre-existing flakiness**, not caused by these changes. The test's logic assertion ("Generating button visible = true") passes in both the full run and an isolated rerun; the test then fails because `page.screenshot({ fullPage: false })` times out while the page is still in the middle of a real generation network call. `playwright.md` explicitly calls this out: *"AUG-21 passed its logic; test screenshot timed out due to generation network activity — see BUG-LIVE-02"*. The phase2-tests-status doc notes AUG-21 is the only spec that triggers live generation and is *"out of scope for this sweep"*. The other 24/25 tests pass, including the ones exercising FeedTabs (AUG-04 tab clicks), the mobile nav (AUG-25), and the reply flow. My changes do not touch the Generate button or feed generation.

## Verification

- `npx tsc -b --noEmit` (from `frontend/`) — clean (no output, exit 0) after all edits.
- `npx playwright test tests/e2e/aug/augment.spec.ts --project=desktop --reporter=line` — 24 passed, 1 pre-existing flaky (AUG-21 screenshot timeout, logic assertion passes). Same-or-better than Phase 2 baseline given the known flakiness.
- No new packages. No Phase 1 contrast tokens touched. No container rebuild. No commits.
