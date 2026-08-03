# 008 — Move Toggle knob with transform instead of left

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 1 file, ~3 lines

## Problem

The `Toggle` knob animates the layout property `left` and does so via
`transition-all` — two violations in one element. `transition: all` animates
unintended properties off-GPU (always a finding), and `top`/`left` animations
trigger layout + paint + composite on every frame, where a `transform`
composes on the GPU. The toggle is hit in every settings session, so the
jank is user-visible on low-end devices.

```tsx
// frontend/src/components/_shared/primitives.tsx:68-71 — current
<div
  className="rounded-full bg-white absolute top-[3px] transition-all"
  style={{ left: checked ? '22px' : '3px', width: 20, height: 20 }}
/>
```

The parent track at line 65 is correct and must stay untouched:

```tsx
// frontend/src/components/_shared/primitives.tsx:65 — current (untouched)
className="w-11 h-7 rounded-full border-none cursor-pointer transition-colors relative"
```

## Target

The knob keeps a constant `left: 3px`; movement goes through `transform` with
the travel distance preserved exactly (19px = 22 − 3), so the on/off knob
positions are pixel-identical to today:

```tsx
// frontend/src/components/_shared/primitives.tsx:68-71 — target
<div
  className="rounded-full bg-white absolute top-[3px] left-[3px] transition-transform duration-150 ease-out motion-reduce:transition-none"
  style={{ transform: checked ? 'translateX(19px)' : 'translateX(0)', width: 20, height: 20 }}
/>
```

Value provenance: `duration-150` (150ms) with `ease-out` (Tailwind's built-in
`cubic-bezier(0, 0, 0.2, 1)`) sits in the 100–160ms button-press/UI-feedback
budget; `motion-reduce:transition-none` drops the movement for reduced-motion
users (the knob still snaps to the correct position; the track's color fade
on the parent is unaffected and continues to run).

If plan 010 has already been executed and the matching token exists in
`frontend/src/index.css`, reference the token instead of the inline value.

## Repo conventions to follow

- Transitions are expressed as Tailwind v4 utilities in `className`; dynamic
  values that Tailwind can't see (here the state-driven transform) go in the
  inline `style={{}}` object — the same split this component already uses
  (track `backgroundColor` is inline at line 66 while classes carry the
  transition).
- Reduced-motion gating via Tailwind's `motion-reduce:` variant, consistent
  with the utility-first approach; no new CSS rules needed.

## Steps

1. In `frontend/src/components/_shared/primitives.tsx`, replace lines 68-71
   (the knob `<div>` quoted above) with the target markup quoted in
   **Target**: add `left-[3px]` to the class list, swap `transition-all` for
   `transition-transform duration-150 ease-out motion-reduce:transition-none`,
   and change the inline style from `left: checked ? '22px' : '3px'` to
   `transform: checked ? 'translateX(19px)' : 'translateX(0)'`, keeping
   `width: 20, height: 20` unchanged.
2. Do not touch the parent `<button>` (lines 60-67) — its
   `transition-colors` track fade stays exactly as is.

## Boundaries

- Do NOT change the knob's visual positions — checked lands at effective
  left 22px, unchecked at 3px, exactly as today (19px travel, not a
  rounded value).
- Do NOT touch the track, any other primitive in `primitives.tsx`, or any
  `Toggle` call site.
- Do NOT change markup/structure — motion properties only.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build`
  — all must pass.
- **Feel check**: run the dev server (`cd /projects/ficino/frontend && npm run dev`;
  the app may be under base path `/ficino`), find any `Toggle` (Settings
  uses them), and confirm:
  - The knob lands in pixel-identical positions on and off — screenshot both
    states before and after the change and diff them; no shift allowed.
  - The knob glides over 150ms with an ease-out feel instead of the old
    linear-ish layout tween; flipping the toggle rapidly mid-travel retargets
    smoothly (transition, not keyframes).
  - In DevTools' Performance panel, toggling repeatedly shows no recurring
    Layout/Paint bars from the knob (transform composes only).
  - Toggle `prefers-reduced-motion` in DevTools' Rendering panel and confirm
    the knob snaps instantly while the track color still fades.
- **Done when**: the knob's rendered on/off positions are unchanged, the
  transition runs on `transform` only, `grep -n "transition-all" frontend/src/components/_shared/primitives.tsx`
  returns nothing, and lint/tests/build pass.
