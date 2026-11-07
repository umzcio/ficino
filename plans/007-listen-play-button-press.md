# 007 — Gate Listen transport hover-grow and add press feedback

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Purpose & accessibility
- **Estimated scope**: 1 file, 2 one-line class changes (+ optional CSS fallback)

## Problem

The Play/Pause transport buttons in Listen carry a decorative `scale-105`
hover-grow on the most-tapped control in the view — an element hit tens of
times per day, where decorative hover motion should be removed or drastically
reduced. Two further defects: the hover is ungated by
`@media (hover: hover)`, so touch taps fire a sticky false hover that leaves
the button stuck at scale(1.05) after the tap; and the button has no `:active`
press feedback at all — pressable elements need `transform: scale(0.97)` on
`:active` (subtle, 0.95–0.98) with a 100–160ms ease-out transition.

```tsx
// frontend/src/components/Listen/ListenView.tsx:758 — current (Pause)
className="w-14 h-14 rounded-full flex items-center justify-center bg-gold text-bg shadow-lg hover:scale-105 transition-transform"

// frontend/src/components/Listen/ListenView.tsx:766 — current (Play / Resume)
className="w-14 h-14 rounded-full flex items-center justify-center bg-gold text-bg shadow-lg hover:scale-105 transition-transform"
```

## Target

On both buttons, replace `hover:scale-105 transition-transform` with exactly:

```
transition-transform duration-100 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:scale-105
```

Resulting class strings:

```tsx
// frontend/src/components/Listen/ListenView.tsx:758 — target
className="w-14 h-14 rounded-full flex items-center justify-center bg-gold text-bg shadow-lg transition-transform duration-100 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:scale-105"

// frontend/src/components/Listen/ListenView.tsx:766 — target
className="w-14 h-14 rounded-full flex items-center justify-center bg-gold text-bg shadow-lg transition-transform duration-100 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:scale-105"
```

Value provenance: press feedback `scale(0.97)` sits in the 0.95–0.98 range;
`duration-100` (100ms) with `ease-out` (Tailwind's built-in
`cubic-bezier(0, 0, 0.2, 1)`) matches the 100–160ms button-press budget; the
hover-grow is kept (reduced, not deleted) but only fires on devices with a
real hover pointer — `@media (hover: hover) and (pointer: fine)` — so touch
can no longer trigger the sticky false hover.

If the arbitrary variant `[@media(hover:hover)_and_(pointer:fine)]:hover:scale-105`
fails to compile (verify with `npm run build`), the fallback is: remove that
one utility, add the class `listen-transport` to both buttons, and add this
named rule to `frontend/src/index.css`:

```css
@media (hover: hover) and (pointer: fine) {
  .listen-transport:hover { transform: scale(1.05); }
}
```

If plan 010 has already been executed and the matching token exists in
`frontend/src/index.css`, reference the token instead of the inline value.

## Repo conventions to follow

- Motion is expressed with Tailwind v4 utilities in `className`; arbitrary
  variants/values in brackets are already used in this codebase, e.g.
  `active:scale-[0.97]`-style arbitrary values and `md:group-hover:` compound
  variants at `frontend/src/components/Explore/ExploreView.tsx:396`.
- Named one-off CSS rules, when needed, go in the global stylesheet
  `frontend/src/index.css` (where the focus-indicator and reduced-motion
  rules already live, lines 93-112).

## Steps

1. In `frontend/src/components/Listen/ListenView.tsx`, replace the class
   string at line 758 with the target string above.
2. Replace the identical class string at line 766 with the target string.
3. Run `cd <repo>/frontend && npm run build`. If the arbitrary
   variant fails to compile, apply the documented fallback (class
   `listen-transport` on both buttons + the named rule in
   `frontend/src/index.css`) and note the substitution in your report.

## Boundaries

- Do NOT touch any other button in `ListenView.tsx` — the skip buttons
  (`transition-colors`, e.g. line 778) and the disabled generating spinner
  (lines 747-753) are out of scope.
- Do NOT change the hover-grow magnitude (`scale-105`) or remove it entirely —
  the fix is gating it to real hover pointers and adding press feedback.
- Do NOT change markup/structure — motion properties only.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd <repo>/frontend && npm run lint && npm test && npm run build`
  — all must pass; the build verifies the arbitrary-variant syntax compiles.
- **Feel check**: run the dev server (`cd <repo>/frontend && npm run dev`;
  the app may be under base path `/ficino`), open Listen, and confirm:
  - On a desktop pointer: hovering Play/Pause still grows the button to
    scale(1.05); pressing it dips to scale(0.97) in 100ms and springs back on
    release.
  - On a touch device (or DevTools device emulation with touch): tapping
    Play/Pause shows the press dip only — the button is NOT left stuck
    enlarged after the tap.
  - In the Animations panel at 10% playback, confirm the press transition is
    a transform scale on the button itself, easing out.
  - Toggle `prefers-reduced-motion` in DevTools' Rendering panel and confirm
    the press/hover scaling is dropped (movement removed) while the rest of
    the transport UI keeps its color feedback.
- **Done when**: both transport buttons carry the target class string (or the
  documented fallback), taps on touch leave no sticky scale, press feedback is
  visible on every pointer type, and lint/tests/build pass.
