# 005 — Keep opacity/color feedback under prefers-reduced-motion

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 3 files, ~30 lines

## Problem

The global reduced-motion rule nukes **all** animation **and** transition
durations to `0.01ms`. Reduced motion means fewer and gentler animations, NOT
zero — transitions that aid comprehension (opacity fades, color feedback) must
be kept; position/movement changes are what should be dropped. The current
rule kills every color/opacity acknowledgment indiscriminately: the `Toggle`
track color fade, hover color fades on nav buttons, button feedback — all
become instant hard cuts for reduced-motion users, degrading state
comprehension for exactly the users who need clear state signals most.

```css
/* frontend/src/index.css:105-112 — current */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .animate-spin { animation: none !important; }
}
```

Second problem: two JS-driven smooth-scroll sites escape CSS entirely and are
unaffected by any media query — they animate scroll position (movement) for
reduced-motion users:

```ts
// frontend/src/components/Personas/PersonaProfile.tsx:138 — current
requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
```

```ts
// frontend/src/hooks/useKeyboardAwareInput.ts:33 — current
ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })

// frontend/src/hooks/useKeyboardAwareInput.ts:68 — current
focused.scrollIntoView({ block: 'center', behavior: 'smooth' })
```

Do NOT re-litigate the `.animate-spin` kill: `frontend/src/components/Feed/Feed.tsx:122-125`
documents an aria-live text fallback compensating for the disabled spinner
("the whole block is a live region so SR users hear step changes — doubly
important under prefers-reduced-motion where `.animate-spin` is disabled").
The spinner stays disabled under reduced motion; that is intentional.

## Target

Replace the universal block at `frontend/src/index.css:105-112` with exactly
this rule set:

```css
/* frontend/src/index.css — target */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
  .animate-spin { animation: none !important; }
  /* Movement transitions off; opacity/color transitions stay */
  .transition-transform,
  .transition-all {
    transition-duration: 0.01ms !important;
  }
}
```

Effect: keyframes stay nuked; smooth scrolling off; Tailwind's movement-prone
utility classes killed by class name. Opacity/color transitions —
`transition-colors`, `transition-opacity`, `transition-[...]` lists without
transform — now run at their authored durations, restoring feedback.

For the three JS scroll sites, use this exact pattern:

```ts
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
```

then pass `behavior: reduce ? 'auto' : 'smooth'` to `scrollIntoView`.

If plan 010 has already been executed and the matching token exists in
`frontend/src/index.css`, reference the token instead of the inline value.

## Repo conventions to follow

- Reduced-motion handling lives in the global stylesheet
  `frontend/src/index.css` as a plain CSS `@media (prefers-reduced-motion: reduce)`
  block — extend that block in place; do not create a new stylesheet.
- There is no `useReducedMotion()` hook in this codebase; the established
  pattern for one-off JS media checks is a direct
  `window.matchMedia('(prefers-reduced-motion: reduce)').matches` call at the
  site of use (no hook extraction for three call sites).
- Theme tokens live in the `@theme` block at `frontend/src/index.css:3-27`;
  this plan adds no tokens.

## Steps

1. In `frontend/src/index.css`, replace lines 105-112 (the
   `@media (prefers-reduced-motion: reduce)` block quoted above) with the
   target rule set quoted in **Target**. Keep the surrounding comment
   `/* Respect reduced motion preference */` at line 104 unchanged.
2. In `frontend/src/components/Personas/PersonaProfile.tsx`, inside the
   `useEffect` at lines 131-139, change line 138 so the reduced-motion check
   happens inside the `requestAnimationFrame` callback:

   ```ts
   requestAnimationFrame(() => {
     const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
     el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
   })
   ```
3. In `frontend/src/hooks/useKeyboardAwareInput.ts`, at line 33 (inside
   `useKeyboardAwareInput`'s `onResize`), change to:

   ```ts
   if (document.activeElement === ref.current) {
     const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
     ref.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
   }
   ```
4. In `frontend/src/hooks/useKeyboardAwareInput.ts`, at line 68 (inside
   `useKeyboardAwarePage`'s `onResize`), change to:

   ```ts
   const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
   focused.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
   ```

## Boundaries

- Do NOT touch `frontend/src/components/Feed/Feed.tsx` — the aria-live
  fallback for the disabled spinner is intentional and stays.
- Do NOT touch gesture-tracking transforms in
  `frontend/src/components/Feed/SwipeToAct.tsx` or
  `frontend/src/components/Feed/PullToRefresh.tsx` — those are direct
  manipulation and intentionally out of scope here (plan 009 handles
  PullToRefresh's decorative rotation).
- Do NOT remove the `.animate-spin { animation: none !important; }` line.
- Do NOT change markup/structure — motion properties only.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build`
  — all must pass.
- **Feel check**: run the dev server (`cd /projects/ficino/frontend && npm run dev`;
  the app may be under base path `/ficino`), then in DevTools' Rendering panel
  toggle `prefers-reduced-motion: reduce` and confirm:
  - With reduced motion ON: the `Toggle` track color (Settings) still fades
    smoothly between gold and grey; nav-button hover color fades still run;
    the loading spinner is a static glyph; opening a persona's DM tab jumps
    scroll instantly instead of smooth-scrolling; focusing an input that
    opens the software keyboard scrolls instantly.
  - With reduced motion OFF: smooth scrolling returns at both scroll sites;
    all transitions behave exactly as before this change.
  - Toggle the OS/DevTools `prefers-reduced-motion` setting back and forth and
    confirm color/opacity feedback only ever disappears when motion is
    reduced, movement transitions only ever run when it is not.
- **Done when**: the media block matches the Target rule set verbatim;
  `grep -n "behavior: 'smooth'" frontend/src` returns no unguarded smooth
  scroll at the three cited sites; lint, tests, and build pass.
