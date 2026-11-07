# 003 — Add velocity-based flick to SwipeBackEdge

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Interruptibility
- **Estimated scope**: 1 file, ~4 lines changed

## Problem

`frontend/src/components/_shared/SwipeBackEdge.tsx:25-31` — the edge-swipe back gesture fires only when `mx > threshold` (default 100px). Current code (verified current, no drift):

```tsx
/* frontend/src/components/_shared/SwipeBackEdge.tsx:25-31 — current */
const bind = useDrag(
  ({ movement: [mx], last, canceled }) => {
    if (!last || canceled) return
    if (mx > threshold) onBack()
  },
  { axis: 'lock', filterTaps: true },
)
```

The component's own docstring (lines 3-7) promises iOS-native "swipe from left edge to pop" muscle memory — but iOS pops on a short **fast** flick from the edge, not only on a long drag. A quick 40px flick does nothing here, so the muscle memory the docstring advertises is broken. Audit §4: drags need velocity-based dismissal, not distance thresholds alone. Same fix pattern as plan 002 (SwipeToAct).

## Target

Destructure `velocity: [vx]` from the gesture state (same pattern as `frontend/src/components/_shared/SwipeableTabs.tsx:26`) and fire `onBack()` when the distance threshold is passed (as today) **OR** the release is a rightward flick:

```
vx >= 0.2 && mx >= 24
```

- `0.2` px/ms velocity floor — the repo's documented SwipeableTabs convention (`SwipeableTabs.tsx:28`), deliberate tuning.
- `24` px minimum travel — guards against tap-flick artifacts on the 20px-wide edge strip.
- No `Math.sign` check needed: the gesture is rightward-only, so the conditions are already signed (`vx >= 0.2` and `mx >= 24` both exclude leftward motion).

If plan 010 has already been executed and the matching token exists in `frontend/src/index.css`, reference the token instead of the inline value. (This plan changes gesture logic only — no easing values; included for completeness.)

```tsx
/* target — frontend/src/components/_shared/SwipeBackEdge.tsx */
const bind = useDrag(
  ({ movement: [mx], velocity: [vx], last, canceled }) => {
    if (!last || canceled) return
    // Distance commit as before, or a fast rightward flick (iOS pops on
    // flick, not just travel). 0.2 px/ms matches SwipeableTabs; 24 px
    // minimum travel filters tap artifacts on the narrow edge strip.
    if (mx > threshold || (vx >= 0.2 && mx >= 24)) onBack()
  },
  { axis: 'lock', filterTaps: true },
)
```

## Repo conventions to follow

- Velocity destructure + 0.2 px/ms floor: `frontend/src/components/_shared/SwipeableTabs.tsx:26-28` — do not invent a different number.
- Gesture options `{ axis: 'lock', filterTaps: true }` stay exactly as they are.
- The edge strip markup (`fixed top-0 left-0 bottom-0 w-5 z-50 touch-none md:hidden`) stays untouched.

## Steps

1. `frontend/src/components/_shared/SwipeBackEdge.tsx:26` — change the destructure to `({ movement: [mx], velocity: [vx], last, canceled })`.
2. Change the commit line to `if (mx > threshold || (vx >= 0.2 && mx >= 24)) onBack()`, adding the comment from the target code above.
3. Nothing else changes — props, `threshold = 100` default, markup, and docstring stay as-is.

## Boundaries

- Only `frontend/src/components/_shared/SwipeBackEdge.tsx`.
- Do NOT change the `threshold` default (100), the 20px strip width, or the `md:hidden` desktop gating.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd <repo>/frontend && npm run lint && npm test && npm run build` — all must pass (build runs `tsc -b && vite build`).
- **Feel check**: `cd <repo>/frontend && npm run dev` (app may be served under base path `/ficino`), on a touch device or DevTools touch emulation, in any detail view with the edge strip:
  - A slow drag right past 100px still pops back (unchanged).
  - A fast short flick right (~30–60px) from the left edge now pops back — matches iOS muscle memory.
  - A slow short drag right (<100px, slow release) does nothing.
  - A fast flick **left** from the edge does nothing (rightward-only guard).
  - Taps near the edge still pass through to content (`filterTaps` unchanged).
- **Done when**: `velocity: [vx]` is destructured and the commit condition reads `mx > threshold || (vx >= 0.2 && mx >= 24)`; lint, tests, and build all green.
