# 012 — Fade tab panel content on tab switch

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Missed opportunities (additive)
- **Estimated scope**: 3 files, ~15 lines changed

## Problem

Tab strips give feedback (`frontend/src/App.tsx:286`, the FeedTabs buttons carry
`transition-all duration-150` — retargeting that is a separate plan, 006) but the
tab **content** teleports. Worst in Feed: the tab body is wrapped in `SwipeableTabs`
(`frontend/src/App.tsx:720`), so the user performs a horizontal spatial gesture and
the content answers with an instant cut — the spatial relationship the gesture
implies is denied (audit §8: state changes that teleport; §3 spirit). Tabs are used
tens of times/day, so per audit §1 ("Tens of times/day → remove or drastically
reduce") the fix must be drastically subtle: **opacity only, no sliding**.

Current code at the three tabpanel sites (verified against commit 18cc791):

Feed — `frontend/src/App.tsx:720-739` renders the active tab's content inside the
swipe wrapper with no entrance:

```tsx
// frontend/src/App.tsx:720 — current
<SwipeableTabs activeIndex={activeTab} tabCount={4} onChange={setActiveTab}>
  <FeedContent
    posts={feed.posts}
    feedId={feed.feedId}
    feedState={feed.feedState}
    ...
  />
</SwipeableTabs>
```

Inside `frontend/src/components/Feed/Feed.tsx`, the active-tab conditional renders
through `panelProps` (defined at `frontend/src/components/Feed/Feed.tsx:66-71`):

```tsx
// frontend/src/components/Feed/Feed.tsx:66-71 — current
const panelProps = {
  role: 'tabpanel' as const,
  id: `feed-panel-${activeTab}`,
  'aria-labelledby': `feed-tab-${activeTab}`,
  tabIndex: 0,
}
```

and the main render spreads it at `frontend/src/components/Feed/Feed.tsx:193-194`:

```tsx
// frontend/src/components/Feed/Feed.tsx:193-195 — current
return (
  <div {...panelProps}>
    <Virtuoso
```

(Drift note vs. the original finding citation: there is no single active-tab
conditional in Feed — `panelProps` is spread onto **five** return branches in
`FeedContent`: generating-spinner at `Feed.tsx:129`, error at `Feed.tsx:152`,
empty at `Feed.tsx:166`, filtered-empty at `Feed.tsx:186`, and the main list at
`Feed.tsx:194`. That is why the Target below wraps at the `App.tsx` call site
instead of editing five branches.)

Inbox — `frontend/src/components/Messages/Inbox.tsx:71-82`:

```tsx
// frontend/src/components/Messages/Inbox.tsx:71-82 — current
<div
  role="tabpanel"
  id={`inbox-panel-${tab}`}
  aria-labelledby={`inbox-tab-${tab}`}
  tabIndex={0}
>

{loading ? (
  <div className="flex items-center justify-center py-20">
    <Spinner size={24} />
  </div>
) : tab === 'papers' ? (
```

The tab state variable here is `tab` (`'papers' | 'groups' | 'threads'`, declared
at `Inbox.tsx:26`).

Settings — `frontend/src/components/Settings/SettingsView.tsx:65-76`:

```tsx
// frontend/src/components/Settings/SettingsView.tsx:65-76 — current
<div
  role="tabpanel"
  id={`settings-panel-${activeTab}`}
  aria-labelledby={`settings-tab-${activeTab}`}
  tabIndex={0}
>
  {activeTab === 'account' && <AccountTab settings={settings} onUpdate={onUpdate} />}
  {activeTab === 'ai' && <AITab settings={settings} onUpdate={onUpdate} />}
  {activeTab === 'content' && <ContentTab settings={settings} onUpdate={onUpdate} />}
  {activeTab === 'storage' && <StorageTab workspaces={workspaces} onDownloadWorkspace={onDownloadWorkspace} />}
</div>
```

## Target

Every tab switch replays a 120–150ms opacity-only fade on the panel content, using
the shared `FadeIn` component from plan 011 (`frontend/src/components/_shared/FadeIn.tsx`),
keyed by the tab state so each switch remounts and replays. No transform, no slide,
no stagger. `FadeIn` is opacity-only with `transition: opacity 150ms cubic-bezier(0.23, 1, 0.32, 1)`.

If plan 010 has already been executed and the matching token exists in
`frontend/src/index.css`, reference the token instead of the inline value.

End states:

Feed (`frontend/src/App.tsx`, inside `SwipeableTabs`):

```tsx
/* target — frontend/src/App.tsx:720 */
<SwipeableTabs activeIndex={activeTab} tabCount={4} onChange={setActiveTab}>
  <FadeIn key={activeTab}>
    <FeedContent
      posts={feed.posts}
      ...all existing props unchanged...
    />
  </FadeIn>
</SwipeableTabs>
```

Keying here remounts `FeedContent` on every tab switch. That is safe: its local
sets (`repliedIndices`, `deletedIndices`) are keyed to `feedId` via render-time
sync and repopulated by effects; `useLikes(feedId)` re-subscribes identically.

Inbox (`frontend/src/components/Messages/Inbox.tsx`):

```tsx
/* target — frontend/src/components/Messages/Inbox.tsx:71 */
<div
  role="tabpanel"
  id={`inbox-panel-${tab}`}
  aria-labelledby={`inbox-tab-${tab}`}
  tabIndex={0}
>
  <FadeIn key={tab}>
    {loading ? (
      <div className="flex items-center justify-center py-20">
        <Spinner size={24} />
      </div>
    ) : tab === 'papers' ? (
      ...unchanged ternary chain...
    )}
  </FadeIn>
</div>
```

Compose, don't double-wrap: if plan 011 already wrapped the Inbox loading-branch
`Spinner` in its own `FadeIn`, **remove that inner wrap** — the outer keyed fade on
the tabpanel supersedes it. The same node must never sit inside two `FadeIn`s.

Settings (`frontend/src/components/Settings/SettingsView.tsx`):

```tsx
/* target — frontend/src/components/Settings/SettingsView.tsx:65 */
<div
  role="tabpanel"
  id={`settings-panel-${activeTab}`}
  aria-labelledby={`settings-tab-${activeTab}`}
  tabIndex={0}
>
  <FadeIn key={activeTab}>
    {activeTab === 'account' && <AccountTab settings={settings} onUpdate={onUpdate} />}
    {activeTab === 'ai' && <AITab settings={settings} onUpdate={onUpdate} />}
    {activeTab === 'content' && <ContentTab settings={settings} onUpdate={onUpdate} />}
    {activeTab === 'storage' && <StorageTab workspaces={workspaces} onDownloadWorkspace={onDownloadWorkspace} />}
  </FadeIn>
</div>
```

Considered and rejected: a directional slide tied to swipe direction (translateX in
the swipe direction). Rejected per audit §1 — tabs are hit tens of times/day, and a
spatial slide on that frequency reads as decoration, not explanation. Opacity-only
is the entire budget this interaction earns.

## Repo conventions to follow

- Shared primitives live in `frontend/src/components/_shared/` (`AsyncState.tsx`,
  `SwipeableTabs.tsx`, `PullToRefresh.tsx`). `FadeIn` from plan 011 follows the same
  pattern: named export, optional `className` prop, replay via React `key`.
- No motion library exists in this repo and none may be added — the fade is a CSS
  transition driven by a `data-mounted` attribute, as plan 011's `FadeIn` does.
- Theme tokens are Tailwind v4 `@theme` tokens in `frontend/src/index.css`; colors
  in the touched JSX stay as-is (`text-text-muted`, `border-border`, etc.).
- Global reduced-motion rule already exists at `frontend/src/index.css:105-112`;
  opacity fades are comprehension-aiding and may keep running under it (audit §6).

## Steps

0. **Prerequisite check.** Confirm `frontend/src/components/_shared/FadeIn.tsx`
   exists (plan 011 must run first). If it does not exist, STOP and report this
   plan as blocked on plan 011 — do NOT reimplement FadeIn inline.
1. `frontend/src/App.tsx` — add `import { FadeIn } from './components/_shared/FadeIn'`
   (match the existing import style at the top of the file). At `App.tsx:720-739`,
   wrap `<FeedContent ... />` in `<FadeIn key={activeTab}>...</FadeIn>`, keeping
   every existing prop and the `SwipeableTabs` wrapper untouched.
2. `frontend/src/components/Messages/Inbox.tsx` — add the `FadeIn` import
   (`../_shared/FadeIn`). Inside the `role="tabpanel"` div (`Inbox.tsx:71-76`),
   wrap the entire `{loading ? ... : ...}` ternary (`Inbox.tsx:78-228`) in
   `<FadeIn key={tab}>...</FadeIn>`. If the loading-branch `Spinner` div is already
   wrapped in a `FadeIn` from plan 011, remove that inner wrap so the node is not
   double-wrapped.
3. `frontend/src/components/Settings/SettingsView.tsx` — add the `FadeIn` import.
   Inside the `role="tabpanel"` div (`SettingsView.tsx:65-75`), wrap the four
   `{activeTab === ... && ...}` lines in `<FadeIn key={activeTab}>...</FadeIn>`.
4. Verify no other props, aria attributes, or conditional logic changed.

## Boundaries

- Do NOT touch the tab strip buttons, `FeedTabs`, `InboxTabs`, `SettingsTabs`, or
  `SwipeableTabs` — plan 006 owns the tab-strip transition; swipe gesture logic is
  out of scope.
- Do NOT edit `Feed.tsx`'s five `panelProps` branches — the Feed wrap happens at
  the `App.tsx` call site only.
- Do NOT add a slide, translate, or any transform — opacity only.
- Do NOT add new dependencies.
- Do NOT reimplement or modify `FadeIn` — it comes from plan 011 verbatim.
- If a step doesn't match the code you find (drift since the commit stamp), STOP
  and report instead of improvising.

## Verification

- **Mechanical**: `cd <repo>/frontend && npm run lint && npm test && npm run build` — all must pass.
- **Feel check**: run `cd <repo>/frontend && npm run dev` (app may be
  under base path `/ficino`), then:
  - Click through the four Feed tabs: content fades in over ~120–150ms on every
    switch; there is no horizontal movement of the content.
  - Swipe horizontally on the feed (touch or pointer drag past 80px): the tab
    changes and the new content fades in — the cut is gone.
  - In Messages, switch Papers / Groups / Threads: same subtle fade; while
    `loading` is true the spinner is inside the same fade, not a separate one.
  - In Settings, switch Account / AI / Content / Storage: same fade; the search
    results view (`isSearching` branch) is untouched.
  - In DevTools, set animation playback to 10% (Animations panel) and confirm the
    only animated property is `opacity`.
  - Toggle `prefers-reduced-motion` (Rendering panel) and confirm the fade either
    still runs (allowed — opacity aids comprehension) or collapses to instant via
    the global rule; in no case should any movement appear.
- **Done when**: all three tabpanels fade on tab switch; `grep -n "FadeIn key" frontend/src/App.tsx frontend/src/components/Messages/Inbox.tsx frontend/src/components/Settings/SettingsView.tsx` shows one keyed FadeIn per file; no node is nested inside two `FadeIn`s; lint/test/build green.
