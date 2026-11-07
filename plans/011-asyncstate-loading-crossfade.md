# 011 — Fade loaded content in after loading states

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: HIGH
- **Category**: Missed opportunities (additive)
- **Estimated scope**: 7 files (6 edited, 1 new), ~60 lines changed

## Problem

`frontend/src/components/_shared/AsyncState.tsx` exports `Spinner` and
`EmptyState`, and every view swaps them for content with a bare
conditional — `{loading ? <Spinner/> : content}`. On every view the user
watches a spinner vanish and a full list blink into existence in one
frame (audit §8: state changes that teleport, where a brief transition
would prevent a jarring change). All call sites verified at commit
18cc791:

```tsx
// frontend/src/components/Messages/Inbox.tsx:78-82 — current
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size={24} />
        </div>
      ) : tab === 'papers' ? (
```

```tsx
// frontend/src/components/ReadingLists/ReadingListsView.tsx:92-102 — current
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={24} />
        </div>
      ) : lists.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No reading lists yet"
          hint={<p className="text-sm">Create one to get a guided path through your papers</p>}
        />
      ) : (
```

```tsx
// frontend/src/components/Alerts/AlertsView.tsx:143-157 — current
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size={24} />
        </div>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No alerts yet"
          hint={
            <p className="text-sm text-center max-w-[280px]">
              Upload papers and generate feeds — Ficino will surface contradictions, patterns, and insights
            </p>
          }
        />
      ) : (
```

```tsx
// frontend/src/components/ReadingLists/ReadingListDetail.tsx:158-164 — current
  if (loading || !list) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size={24} />
      </div>
    )
  }
```

Two more components hand-roll the same pattern without `AsyncState`:

```tsx
// frontend/src/components/Feed/Feed.tsx:126-144 — current (inline generating state)
  if (feedState === 'generating' && posts.length === 0) {
    const stepLabel = STEP_LABELS[generatingMeta.step || ''] || 'Starting...'
    return (
      <div
        {...panelProps}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex flex-col items-center justify-center py-20"
      >
        <Loader2 size={32} className="text-gold animate-spin mb-4" aria-hidden="true" />
        ...
```

```tsx
// frontend/src/components/Sidebar/CorpusPanel.tsx:265-276 — current (inline loading state)
  if (loading) {
    return (
      <div className="bg-bg-hover border border-border rounded-2xl p-4">
        <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
          What's happening
        </div>
        <div className="flex items-center justify-center py-4">
          <Loader2 size={20} className="text-text-muted animate-spin" />
        </div>
      </div>
    )
  }
```

## Target

1. A new shared wrapper `frontend/src/components/_shared/FadeIn.tsx` that
   mounts children at `opacity: 0` and transitions to `opacity: 1` over
   **150ms** with the strong ease-out
   **`cubic-bezier(0.23, 1, 0.32, 1)`** (audit §2 token value). It uses
   the `data-mounted` fallback pattern from audit §4 — an attribute set
   in `useEffect` plus one `requestAnimationFrame` — chosen over
   `@starting-style` for older iOS Safari in the PWA audience. Full file
   in Steps.
2. **Opacity only.** No transform: opacity is comprehension-aiding
   feedback that survives reduced-motion rules (audit §6: keep feedback
   that aids comprehension, remove position changes), so no
   `motion-reduce` / `matchMedia` handling is needed in the component.
   This works both before and after plan 005 rescopes the global rule at
   `frontend/src/index.css:105-112`: today the global rule compresses the
   fade to 0.01ms (content appears instantly — acceptable, no blink of
   partial motion); after 005 the 150ms fade should survive as a kept
   opacity transition.
3. The loaded-content branch at each call site below is wrapped in
   `<FadeIn>`, with a `key` where content identity changes so the fade
   replays per load (keyed remount — React unmounts and remounts the
   wrapper, restarting the fade). Spinner exit stays instant: a true
   crossfade needs delayed unmount, which is **explicitly out of scope**;
   the content fading in over the vanished spinner already removes the
   blink.
4. Token note: the transition is written as
   `opacity 150ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1))` — it
   consumes plan 010's `--ease-out` token if that plan has landed and
   falls back to the literal (same value) if it hasn't. Either execution
   order is correct.

## Repo conventions to follow

- Shared primitives live in `frontend/src/components/_shared/`
  (`AsyncState.tsx`, `PullToRefresh.tsx`, `SwipeToAct.tsx`) and are
  imported by views one directory down as
  `import { Spinner } from '../_shared/AsyncState'` — every call site in
  this plan uses that exact relative shape for `FadeIn` too.
- Named exports, typed inline props (`AsyncState.tsx:12-17` is the house
  style), plain function components, no default export.
- Components that need a few lines of scoped CSS use an inline
  `<style>{`...`}</style>` block — see
  `frontend/src/components/Nav/WorkspaceBottomSheet.tsx:131-139`. `FadeIn`
  follows that pattern for its `data-mounted` rule.
- The `setMounted` call sits inside a `requestAnimationFrame` callback in
  the effect, not synchronously in the effect body — the same constraint
  the set-state-in-effect lint rule enforced on `useTouchDevice` in
  `frontend/src/components/_shared/SwipeToAct.tsx:16-35`. Keep the
  explanatory comment.

## Steps

1. Create `frontend/src/components/_shared/FadeIn.tsx` with this exact
   content:

```tsx
import { useEffect, useState, type ReactNode } from 'react'

/**
 * Fades children in on mount: renders at opacity 0, then flips a
 * `data-mounted` attribute after one animation frame so the CSS
 * transition carries opacity to 1 over 150ms. Opacity ONLY — no
 * transform — so the fade is comprehension-aiding feedback that survives
 * reduced-motion rules (audit §6); no motion-reduce handling needed.
 *
 * Uses the data-mounted fallback (audit §4) instead of @starting-style
 * for older iOS Safari in the PWA audience.
 *
 * Keyed remount: when the content identity changes (new feed, new tab,
 * refresh), the CALL SITE must put a `key` on <FadeIn> so React remounts
 * it and the fade replays per load.
 */
export function FadeIn({ children, className }: {
  children: ReactNode
  className?: string
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // The setState lives inside the rAF callback, not synchronously in
    // the effect body — the set-state-in-effect lint rule flags the
    // synchronous form. One frame at opacity 0 is required or the
    // transition has nothing to interpolate from.
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div data-mounted={mounted || undefined} className={`fade-in${className ? ` ${className}` : ''}`}>
      <style>{`
        .fade-in { opacity: 0; transition: opacity 150ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1)); }
        .fade-in[data-mounted] { opacity: 1; }
      `}</style>
      {children}
    </div>
  )
}
```

   The `fade-in` class on the outer div is what the `<style>` selectors
   target; `data-mounted` flips to `true` one frame after mount so the
   opacity transition runs. Duplicate `<style>` tags across multiple
   mounted FadeIn instances are harmless — the selectors are identical —
   and match the existing convention.

2. `frontend/src/components/Messages/Inbox.tsx`: add
   `import { FadeIn } from '../_shared/FadeIn'` (next to the line-7
   `AsyncState` import). Wrap the entire loaded branch of the ternary at
   lines 78-228 — everything from `tab === 'papers' ? (` through the
   final `)}` on line 228 — in `<FadeIn key={tab}>...</FadeIn>`. Result
   shape:

```tsx
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size={24} />
        </div>
      ) : (
        <FadeIn key={tab}>
          {tab === 'papers' ? (
            <div>
              ...
            </div>
          ) : tab === 'threads' ? (
            <div>
              ...
            </div>
          ) : (
            <div>
              ...
            </div>
          )}
        </FadeIn>
      )}
```

   The `key={tab}` makes the fade replay when the user switches tabs.
   Branch contents are unchanged — only re-indented.

3. `frontend/src/components/ReadingLists/ReadingListsView.tsx`: add the
   same `../_shared/FadeIn` import. In the ternary at lines 92-141, keep
   the loading branch as is and wrap everything after it — both the
   `lists.length === 0` `EmptyState` branch (96-101) and the list `<div>`
   branch (102-140) — in one `<FadeIn>`:

```tsx
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={24} />
        </div>
      ) : (
        <FadeIn>
          {lists.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No reading lists yet"
              hint={<p className="text-sm">Create one to get a guided path through your papers</p>}
            />
          ) : (
            <div>
              ...unchanged list rows...
            </div>
          )}
        </FadeIn>
      )}
```

4. `frontend/src/components/Alerts/AlertsView.tsx`: add the same import.
   Same shape as step 3 for the ternary at lines 143-169: loading branch
   untouched, the `alerts.length === 0 ? <EmptyState ... /> : <div>...`
   remainder wrapped in one `<FadeIn>`.

5. `frontend/src/components/ReadingLists/ReadingListDetail.tsx`: add the
   same import. Loading is an early return (lines 158-164) — leave it.
   Wrap the two loaded returns that follow it:
   - The chapter-feed view (`return (` at line 170, ending line 234):
     wrap its root `<div>` in
     `<FadeIn key={`chapter-${activeChapterIndex}`}>...</FadeIn>`.
   - The overview (`return (` at line 238, ending line 357): wrap its
     root `<div>` in `<FadeIn key={list.id}>...</FadeIn>`.
   The `SwipeBackEdge` and sticky headers stay inside the wrappers;
   structure is otherwise unchanged.

6. `frontend/src/components/Feed/Feed.tsx`: add the same import. Leave
   the `generating` (126-145), `error` (147-162), `posts.length === 0`
   (164-172), and `filtered.length === 0` (183-191) early returns alone.
   Wrap the final content return (lines 193-249, the
   `<div {...panelProps}>` containing the `Virtuoso` list and the
   generate-more footer) in `<FadeIn key={feedId ?? 'none'}>:</FadeIn>`:

```tsx
  return (
    <FadeIn key={feedId ?? 'none'}>
      <div {...panelProps}>
        <Virtuoso ... />
        <div className="py-5 text-center">...</div>
      </div>
    </FadeIn>
  )
```

   The `key` replays the fade when the user switches feeds. Virtuoso
   uses window scroll (`useWindowScroll`), so the extra wrapper div does
   not disturb its measurement.

7. `frontend/src/components/Sidebar/CorpusPanel.tsx`: add the same
   import. Leave the `if (loading)` early return (265-276) alone. Wrap
   the loaded return (lines 280-345, the outer
   `<div className="bg-bg-hover border border-border rounded-2xl p-4">`)
   in `<FadeIn>...</FadeIn>` — no key needed here; the panel content
   updates in place and should not re-fade on every paper mutation.

8. Sanity check: `grep -rn "FadeIn" frontend/src/` should show exactly
   the new file plus one import and the JSX usages in the six call-site
   files.

## Boundaries

- Only the new `FadeIn.tsx` and the six listed call-site files. No other
  components — do NOT go wrapping other spinners you find (Bookmarks,
  Explore, Settings, NewGroupChatModal are out of scope for this plan).
- No changes to data loading, fetching, caching, or the `loading` flags —
  wrap JSX branches only.
- No delayed-unmount machinery for the spinner exit, no crossfade
  overlap, no `AnimatePresence`-style state. Spinner exit stays instant
  by design.
- No transform, stagger, blur, or scale in `FadeIn` — opacity only,
  exactly 150ms.
- Do NOT change `AsyncState.tsx` itself.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd <repo>/frontend && npm run lint && npm test && npm run build` — all three must pass.
- **Feel check**: run `cd <repo>/frontend && npm run dev`, open
  the app (it may be served under the base path `/ficino`), and for each
  touched view (Messages inbox, Reading Lists, Alerts, a reading-list
  detail, the main feed, the corpus panel in the sidebar/drawer):
  - Navigate to the view with cold data: the spinner appears and
    disappears instantly as before, and the content settles in over
    ~150ms instead of blinking into existence. It should read as
    "content arrives," not as a flashy animation.
  - In the inbox, switch tabs: each tab's content replays the fade
    (keyed remount). In the feed, switch feeds: the list replays the
    fade.
  - In DevTools' Animations panel at 10% playback, confirm the
    transition is opacity-only — no element moves, scales, or shifts;
    layout is stable throughout.
  - Toggle `prefers-reduced-motion` (Rendering panel): content appears
    essentially instantly (today's global rule compresses the fade);
    crucially nothing slides or pops. No behavior regresses versus the
    pre-change build.
  - Throttle the network (DevTools → Network → Slow 3G) once to confirm
    fast loads don't produce a visible flash-of-fade: sub-frame loads
    still render content without flicker.
- **Done when**: `FadeIn.tsx` exists with the exact transition
  `opacity 150ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1))`; all
  six call sites wrap their loaded-content branch (with the specified
  `key` props at Inbox, ReadingListDetail, and Feed); loading branches
  and `AsyncState.tsx` are untouched; lint/test/build all pass.
