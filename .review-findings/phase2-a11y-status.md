# Phase 2A Accessibility — Status

Applied 2026-04-17. All targeted mechanical a11y fixes from `FICINO_REMEDIATION_PLAN.md` §2A landed on source. TypeScript build verified clean via `npx tsc -b` in `frontend/`.

## Items shipped

| # | File:line | Change | Verified |
|---|-----------|--------|----------|
| 2.1 | frontend/src/components/Feed/ComposeBox.tsx:36 | Replaced avatar `<div onClick>` with `<button type="button" aria-label="View your profile">`; kept original classes; added `border-none` | tsc |
| 2.2 | frontend/src/components/Sidebar/PersonaPanel.tsx:19 | Persona row `<div onClick>` → `<button type="button" role="menuitem" aria-label={p.name}>`; added `bg-transparent border-none w-full text-left` to keep layout | tsc |
| 2.3 | frontend/src/components/Feed/PostCard.tsx:33 (FigureLightbox) | Added `ref` + `useFocusTrap(true, ref)`; preserved existing Escape→close. Focus restored to trigger on unmount via hook | tsc |
| 2.4 | frontend/src/components/Nav/MobileDrawer.tsx:32 | Added `dialogRef` + `useFocusTrap(open, dialogRef)`; no layout changes | tsc |
| 2.4 | frontend/src/components/Nav/WorkspaceBottomSheet.tsx:17 | Added `dialogRef` + `useFocusTrap(true, dialogRef)` (component is conditionally mounted, so `true` aligns with mount/unmount) | tsc |
| 2.5 | frontend/src/hooks/useFocusTrap.ts (new) | Pure React hook; saves `document.activeElement`, focuses first focusable in container, wraps Tab/Shift+Tab, restores focus on deactivation. No 3rd-party deps | tsc |
| 2.7 | frontend/src/components/Feed/PostCard.tsx:~401 | Added `aria-haspopup="menu"`, `aria-expanded={menuOpen}` to trigger; `role="menu"` on container; `role="menuitem"` added to `MenuItem` component so every item inherits it | tsc |
| 2.8 | frontend/src/components/Feed/PostCard.tsx (typing indicator, ~955) | Wrapped typing/zap-loading container in `role="status" aria-live="polite" aria-atomic="true"` | tsc |
| 2.8 | frontend/src/components/Feed/PostCard.tsx (toast, ~1070) | Added `role="status" aria-live="polite" aria-atomic="true"` to toast div | tsc |
| 2.9 | frontend/src/components/Feed/Feed.tsx:110 | Wrapped post list in `<ol role="feed" className="list-none p-0 m-0">`; each `<PostCard>` wrapped in `<li className="list-none">`. Post `key` moved to the `<li>` | tsc |
| 2.10 | frontend/src/App.tsx (root `<div>`) | Added skip link as first child with the prescribed Tailwind focus classes; `id="main"` added to existing `<main>` | tsc |
| 2.11 | frontend/src/components/Feed/ComposeBox.tsx (textarea) | Added `aria-label="Compose new post"` | tsc |
| 2.11 | frontend/src/components/Feed/PostCard.tsx (reply input) | Added `aria-label={`Reply to ${p.name}`}` | tsc |
| 2.11 | Settings inputs | Only real inputs in Settings/ are `ApiKeyInput` (already paired with adjacent visible label via `<SettingRow>` text), the settings search box (toggle button already has `aria-label="Search settings"`; placeholder communicates purpose), and `EditableField` (placeholder `Set {label.toLowerCase()}...` is self-descriptive). Nothing required further changes — see "Surprises" | manual |
| 2.12 | frontend/src/components/Settings/primitives.tsx:47 | `Toggle` now accepts optional `label?: string`; renders `aria-label={label}` on the switch. Call sites in `AITab.tsx` (persona toggles) and `ContentTab.tsx` (Auto-generate on Upload, Show Extraction Badge) updated to pass the matching row label | tsc |
| 2.13 | frontend/src/App.tsx:124 | Mobile bottom-nav button: `py-2.5` → `py-3` and added `min-h-[48px]` to guarantee ≥44px touch target in all text-sizes | tsc |
| 2.14 | frontend/src/index.css:70-78 | Focus outline width `2px` → `3px`; `outline-offset: 2px` already present (kept). Color token unchanged per Phase 1 rule | tsc |
| 2.15 | frontend/src/components/Settings/SettingsTabs.tsx | `aria-label="Settings sections"` on the tablist. Each tab has `id="settings-tab-{key}"`, `aria-controls="settings-panel-{key}"`, `tabIndex={active ? 0 : -1}` (roving tabindex), and an ArrowLeft/ArrowRight handler that wraps, selects, and focuses the new tab | tsc |
| 2.15 | frontend/src/components/Settings/SettingsView.tsx:64 | Wrapped active tab content in `<div role="tabpanel" id="settings-panel-{tab}" aria-labelledby="settings-tab-{tab}" tabIndex={0}>` | tsc |

## Items intentionally skipped

None from the 2A list. 2.6 (`@mention` combobox ARIA) was **not** in the instructions for this batch and was left for a separate PR — it needs design attention and is a 4h item.

## Surprises

- **Settings form inputs** (2.11, Settings half): there are only three `<input>` sites under `components/Settings/` — `ApiKeyInput` (`type="password"` with `placeholder="sk-..."`-style hints), the `SettingsSearch` text input (placeholder `Search settings...`, toggle button already labeled), and the `EditableField` text input used inline. All three live next to a visible `<SettingRow label>` or descriptive placeholder that functions as the accessible name. I did not add redundant `aria-label`s since that can double-announce on screen readers. Flagging in case the reviewer wants stricter labels.
- **SettingsTabs had a partial a11y baseline already**: `role="tablist"`, `role="tab"`, and `aria-selected` were already present. I added the missing pieces (tablist aria-label, ids, aria-controls, roving tabindex, arrow-key nav) and the matching `role="tabpanel"` in SettingsView.
- **MenuItem shared by every row in the three-dots menu**: easier to add `role="menuitem"` inside the component once than on every usage. All usages pick up the role automatically (`Copy text`, `Cite (APA/MLA)`, `Add/Edit note`, `Remove note`, `Regenerate`, `Hide {persona}`, `Delete post`, `Debug view`).
- **WorkspaceBottomSheet is conditionally rendered** (parent passes `showWorkspaceSheet && <... />`), so `useFocusTrap(true, ref)` behaves correctly: activation = mount, deactivation = unmount. Same `open`/mount coupling in MobileDrawer; I wired it through the `open` prop anyway to match the instruction's `useFocusTrap(open, ref)` pattern.
- **FigureLightbox was already using `useEffect` for Escape** and closes itself via backdrop `onClick`. Adding the focus trap preserved both behaviors; the trap's `keydown` handler is container-scoped so it does not intercept Escape.
- **Feed `<ol role="feed">`**: overriding default `<ol>` margin/padding with `list-none p-0 m-0` and adding `list-none` to each `<li>` to keep the visual layout pixel-identical. The key previously on `<PostCard>` moved to the wrapping `<li>`.

## Verification

- `npx tsc -b --noEmit` from `frontend/` — clean (no output, exit 0) after all edits.
- No new packages added. No Phase 1 contrast tokens touched. No container rebuild triggered.
