# 009 — Fix pull-to-refresh layout thrash and reduced-motion bypass

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Performance & accessibility
- **Estimated scope**: 2 files (1 edited, 1 new), ~40 lines changed

## Problem

`frontend/src/components/_shared/PullToRefresh.tsx` animates a layout
property every pointermove frame and drives a decorative spin in JS that
`prefers-reduced-motion` cannot reach.

1. The spinner track's `height` follows the pull distance, so every frame
   of the drag triggers layout + paint + composite instead of composite-only:

```tsx
// frontend/src/components/_shared/PullToRefresh.tsx:71-75 — current
        style={{
          height: pullPx,
          opacity: Math.max(progress, refreshing ? 1 : 0),
          transition: refreshing ? 'none' : 'opacity 120ms ease',
        }}
```

2. The spinner's pull-linked rotation is a JS-driven inline transform
   updated per frame. A CSS `@media (prefers-reduced-motion: reduce)` rule
   cannot reach it, so reduced-motion users still get the decorative
   0–360° spin. There is no `matchMedia('(prefers-reduced-motion: reduce)')`
   anywhere in the codebase today (verified by grep at commit 18cc791):

```tsx
// frontend/src/components/_shared/PullToRefresh.tsx:80-84 — current
          style={{
            color: 'var(--color-gold)',
            transform: refreshing ? undefined : `rotate(${progress * 360}deg)`,
            transition: refreshing ? 'none' : 'transform 40ms linear',
          }}
```

3. The track's reveal uses bare `ease` on an entrance/exit (audit §2:
   entering/exiting → `ease-out`), same line 74 quoted above.

Note for later: line 91's spring-back
`transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)` is one of two
near-duplicate hand-typed copies (the other is
`frontend/src/components/_shared/SwipeToAct.tsx:160` at 220ms). Plan 010
consolidates both into a `--ease-spring-back` token. **This plan does not
touch the curve or duration.**

## Target

1. New hook `frontend/src/hooks/useReducedMotion.ts` (see Steps for the
   full file — it is a copy of the established `useTouchDevice` pattern).
2. Fixed-height spinner track: `height: threshold` (the prop, default `70`)
   instead of `height: pullPx`. The track is absolutely positioned and the
   spinner is centered by the existing `flex items-center justify-center`
   classes, and the reveal already happens through `opacity` — so no visual
   change, and no per-frame layout. Custom thresholds still fit because the
   track height tracks the same value the content is pushed by.
3. Reduced motion: when `useReducedMotion()` returns true, the Loader2
   `rotate(...)` transform is omitted entirely (the icon renders static);
   the opacity progress reveal still shows.
4. Line 74: `'opacity 120ms ease'` → `'opacity 120ms ease-out'`.

Resulting style blocks:

```tsx
// track (was lines 71-75)
        style={{
          height: threshold,
          opacity: Math.max(progress, refreshing ? 1 : 0),
          transition: refreshing ? 'none' : 'opacity 120ms ease-out',
        }}
```

```tsx
// Loader2 (was lines 80-84)
          style={{
            color: 'var(--color-gold)',
            transform: refreshing || reducedMotion ? undefined : `rotate(${progress * 360}deg)`,
            transition: refreshing ? 'none' : 'transform 40ms linear',
          }}
```

Reduced-motion handling that works both before and after plan 005 (which
rescopes the global reduced-motion rule at `frontend/src/index.css:105-112`):
the JS branch above is authoritative — it drops the decorative rotation no
matter what the global CSS rule does. The `animate-spin` class used while
`refreshing` is CSS-driven, so it is already governed by the global rule
today (`index.css:111` kills `.animate-spin`) and by whatever 005 replaces
it with; this plan leaves that path alone. The opacity reveal is kept under
reduced motion deliberately (audit §6: keep feedback that aids
comprehension, drop movement).

## Repo conventions to follow

- Hooks live in `frontend/src/hooks/` (e.g. `useHaptic.ts`, imported as
  `../../hooks/useHaptic`). Name the file `useReducedMotion.ts`, export a
  named function `useReducedMotion`.
- Copy the media-query subscription pattern **exactly** from
  `useTouchDevice()` in `frontend/src/components/_shared/SwipeToAct.tsx:16-35`
  — it was deliberately written to satisfy the set-state-in-effect lint
  rule (lazy `useState` initializer reads the query once; the effect only
  subscribes, and its `setState` lives inside the `change` callback):

```tsx
// frontend/src/components/_shared/SwipeToAct.tsx:16-35 — exemplar
function useTouchDevice(): boolean {
  // Lazy initializer reads the media query once, at mount — the same
  // sanctioned pattern React docs use for useState(() => window.innerWidth)
  // — instead of always starting `false` and flipping it synchronously
  // inside the effect below (which the set-state-in-effect lint rule
  // flags). The effect then only *subscribes*; its setState call lives
  // inside the 'change' event callback, not the effect body itself.
  const [isTouch, setIsTouch] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)')
    const onChange = (e: MediaQueryListEvent) => setIsTouch(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isTouch
}
```

- Inline `style={{}}` objects with `var(--color-*)` tokens are the norm in
  this component — keep that shape; do not introduce Tailwind classes for
  these values.

## Steps

1. Create `frontend/src/hooks/useReducedMotion.ts` with this exact content
   (same structure and comment rationale as the exemplar, query swapped):

```tsx
import { useEffect, useState } from 'react'

/**
 * Subscribes to `prefers-reduced-motion: reduce`. Use to branch JS-driven
 * motion (inline transforms, rAF loops) that the CSS media query cannot
 * reach — CSS-driven motion is already handled by the global rule in
 * index.css.
 */
export function useReducedMotion(): boolean {
  // Lazy initializer reads the media query once, at mount — the same
  // sanctioned pattern React docs use for useState(() => window.innerWidth)
  // — instead of always starting `false` and flipping it synchronously
  // inside the effect below (which the set-state-in-effect lint rule
  // flags). The effect then only *subscribes*; its setState call lives
  // inside the 'change' event callback, not the effect body itself.
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}
```

2. In `frontend/src/components/_shared/PullToRefresh.tsx`, add the import
   after line 3 (`import { useState, type ReactNode } from 'react'`):

```tsx
import { useReducedMotion } from '../../hooks/useReducedMotion'
```

   and inside the component (after line 24, `const [refreshing, setRefreshing] = useState(false)`):

```tsx
  const reducedMotion = useReducedMotion()
```

3. Same file, lines 71-75 (spinner track style): change `height: pullPx`
   to `height: threshold` and `'opacity 120ms ease'` to
   `'opacity 120ms ease-out'` — the result must match the first Target
   block above exactly.
4. Same file, line 82: change
   `transform: refreshing ? undefined : ` + backtick rotate expression
   to `transform: refreshing || reducedMotion ? undefined : ` + the same
   rotate expression — must match the second Target block above exactly.
   Leave line 83 (`transition: ... 'transform 40ms linear'`) unchanged:
   constant motion → `linear` is correct per audit §2, and with the
   transform omitted under reduced motion there is nothing left to
   transition.

## Boundaries

- Do NOT touch `frontend/src/components/_shared/SwipeToAct.tsx` (plan 010
  migrates its snap-back easing; its `useTouchDevice` stays where it is —
  do not extract or dedupe it).
- Do NOT change the rubber-band easing at `PullToRefresh.tsx:45`
  (`threshold + (my - threshold) * 0.3`) — documented deliberate.
- Do NOT change the `threshold` default (`70`), the gesture config
  (line 60), the content-push `translateY` (line 90), or the spring-back
  curve/duration at line 91 (plan 010's job).
- Do NOT touch `frontend/src/index.css` or the global reduced-motion rule
  (plan 005's job).
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build` — all three must pass.
- **Feel check**: run `cd /projects/ficino/frontend && npm run dev`, open
  the app (it may be served under the base path `/ficino`) on a mobile
  viewport (DevTools device toolbar), go to the feed at scrollY 0, and
  pull down:
  - The spinner fades in and rotates with pull progress; on release past
    the threshold the content springs back. Visually identical to before.
  - In DevTools Performance, record a slow pull: no recurring
    "Layout"/"Recalculate Style" bars per frame from the track height
    (only paint/composite from opacity and transform).
  - Toggle `prefers-reduced-motion` (Rendering panel): the spinner still
    fades in with pull progress, but it no longer rotates 0–360° as you
    pull; it sits static. During refresh, the `animate-spin` glyph is also
    static (global rule). Untoggle and the pull-rotation returns without a
    reload.
- **Done when**: `height: pullPx` no longer appears in
  `PullToRefresh.tsx`; `useReducedMotion` is imported and gates the
  `rotate(...)` transform; the track transition reads
  `'opacity 120ms ease-out'`; lint/test/build all pass.
