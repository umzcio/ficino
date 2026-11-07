# 002 — Add velocity-based flick commit to SwipeToAct

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: HIGH
- **Category**: Interruptibility
- **Estimated scope**: 1 file, ~10 lines changed

## Problem

`frontend/src/components/_shared/SwipeToAct.tsx:83-109` — swipe commit is distance-only. Current code (verified current, no drift):

```tsx
/* frontend/src/components/_shared/SwipeToAct.tsx:83-109 — current */
const bind = useDrag(
  ({ movement: [mx], down, last, canceled }) => {
    if (effectivelyDisabled) return
    // Dead-zone: ignore the first 8 px so a small hand tremor or
    // start-of-scroll doesn't produce a visible translate.
    const effective = Math.abs(mx) < 8 ? 0 : mx - Math.sign(mx) * 8
    if (down) {
      setDx(effective)
      return
    }
    if (last && !canceled) {
      if (mx <= -threshold && onSwipeLeft) {
        setCommitting('left')
        haptic(15)
        onSwipeLeft()
      } else if (mx >= threshold && onSwipeRight) {
        setCommitting('right')
        haptic(15)
        onSwipeRight()
      }
      setDx(0)
      // Clear the commit flash after the spring-back animation.
      setTimeout(() => setCommitting(null), 220)
    }
  },
  { axis: 'lock', filterTaps: true },
)
```

A fast, decisive flick that travels less than the 80px `threshold` snaps the card back and does nothing — flick intent is ignored. Audit §4: drags need velocity-based dismissal, not distance thresholds alone. This is the primary row-level gesture in the feed, so the dead-flick is hit constantly.

## Target

Destructure `velocity: [vx]` from the gesture state (same pattern as `frontend/src/components/_shared/SwipeableTabs.tsx:26`) and commit when the distance threshold is passed (as today) **OR** when the release is a flick. Exact commit rule:

```
flick = Math.abs(vx) >= 0.2 && Math.abs(mx) >= 24 && Math.sign(vx) === Math.sign(mx)
```

- `0.2` px/ms velocity floor — matches the repo's documented SwipeableTabs convention (`SwipeableTabs.tsx:28`, `Math.abs(vx) < 0.2`, tuned deliberately).
- `24` px minimum travel — guards against zero-distance tap-flick artifacts (`filterTaps` passes real taps through, but a touch release can still report velocity with ~0 movement).
- `Math.sign(vx) === Math.sign(mx)` — velocity direction must agree with drag direction, so a drag-left-then-reverse-whip doesn't commit left.

Direction selects the action: flick left (`vx < 0`) → `onSwipeLeft`; flick right (`vx > 0`) → `onSwipeRight`. Keep the existing `haptic(15)` calls and the 220ms commit-flash `setTimeout` unchanged.

If plan 010 has already been executed and the matching token exists in `frontend/src/index.css`, reference the token instead of the inline value. (This plan changes gesture logic only — no easing values; included for completeness.)

```tsx
/* target — frontend/src/components/_shared/SwipeToAct.tsx */
const bind = useDrag(
  ({ movement: [mx], velocity: [vx], down, last, canceled }) => {
    if (effectivelyDisabled) return
    // Dead-zone: ignore the first 8 px so a small hand tremor or
    // start-of-scroll doesn't produce a visible translate.
    const effective = Math.abs(mx) < 8 ? 0 : mx - Math.sign(mx) * 8
    if (down) {
      setDx(effective)
      return
    }
    if (last && !canceled) {
      // Flick commit: fast release in the drag direction commits even
      // below the distance threshold. Velocity floor 0.2 px/ms matches
      // SwipeableTabs; 24 px minimum travel filters tap artifacts.
      const flick =
        Math.abs(vx) >= 0.2 &&
        Math.abs(mx) >= 24 &&
        Math.sign(vx) === Math.sign(mx)
      if ((mx <= -threshold || (flick && vx < 0)) && onSwipeLeft) {
        setCommitting('left')
        haptic(15)
        onSwipeLeft()
      } else if ((mx >= threshold || (flick && vx > 0)) && onSwipeRight) {
        setCommitting('right')
        haptic(15)
        onSwipeRight()
      }
      setDx(0)
      // Clear the commit flash after the spring-back animation.
      setTimeout(() => setCommitting(null), 220)
    }
  },
  { axis: 'lock', filterTaps: true },
)
```

## Repo conventions to follow

- Velocity destructure + threshold convention: `frontend/src/components/_shared/SwipeableTabs.tsx:26-28` — `({ movement: [mx], velocity: [vx], last, canceled })` and `Math.abs(vx) < 0.2`. The 0.2 px/ms floor is documented there as deliberate tuning; do not invent a different number.
- Gesture options `{ axis: 'lock', filterTaps: true }` stay exactly as they are.
- The existing dead-zone (8px), spring-back transition (`transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)` at line 160), and gutter rendering stay untouched.

## Steps

1. `frontend/src/components/_shared/SwipeToAct.tsx:84` — change the destructure to `({ movement: [mx], velocity: [vx], down, last, canceled })`.
2. Inside `if (last && !canceled) {` (line 93), add the `flick` const exactly as in the target code above (with its comment).
3. Change the two commit conditions to `(mx <= -threshold || (flick && vx < 0)) && onSwipeLeft` and `(mx >= threshold || (flick && vx > 0)) && onSwipeRight`.
4. Nothing else changes — `setDx(0)`, the 220ms timeout, the desktop short-circuit, and all rendering code stay as-is.

## Boundaries

- Only `frontend/src/components/_shared/SwipeToAct.tsx`.
- Do NOT change the `threshold` default (80), the 8px dead-zone, the `useTouchDevice` desktop gating, or the gutter/progress visuals.
- Do NOT add new dependencies (`velocity` is part of the `@use-gesture/react` state already imported).
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd <repo>/frontend && npm run lint && npm test && npm run build` — all must pass (build runs `tsc -b && vite build`).
- **Feel check**: `cd <repo>/frontend && npm run dev` (app may be served under base path `/ficino`), on a touch device or DevTools touch emulation, on a feed row:
  - A slow drag past 80px still commits (unchanged behavior).
  - A fast short flick (~30–60px travel) now commits — the gutter flashes and the action (Like/Reply) fires.
  - A slow short drag (<80px, slow release) still snaps back with no action.
  - Drag left past ~40px, reverse direction, and release with a fast rightward whip — nothing commits (direction-agreement guard).
  - Quick taps on the row still open the post — `filterTaps` behavior unchanged.
- **Done when**: `velocity: [vx]` is destructured; the flick rule `Math.abs(vx) >= 0.2 && Math.abs(mx) >= 24 && Math.sign(vx) === Math.sign(mx)` gates both commit branches alongside the existing distance threshold; lint, tests, and build all green.
