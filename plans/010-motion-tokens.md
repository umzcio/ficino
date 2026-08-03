# 010 — Introduce motion easing tokens and consolidate duplicates

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: LOW
- **Category**: Cohesion & tokens
- **Estimated scope**: 3–5 files, ~15 lines changed

## Problem

`frontend/src/index.css` defines no motion tokens in its `@theme` block —
every component hand-picks easing curves from an ad-hoc set, and the same
behaviors already carry near-duplicate hand-typed curves (audit §7:
"five hand-typed cubic-beziers that almost match is a consolidation
finding").

Verified duplicates at commit 18cc791:

1. The identical gesture snap-back behavior uses the same curve at two
   different durations, 220ms vs 200ms, with no rationale for the
   difference:

```tsx
// frontend/src/components/_shared/SwipeToAct.tsx:160 — current
          transition: dx === 0 ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
```

```tsx
// frontend/src/components/_shared/PullToRefresh.tsx:91 — current
          transition: refreshing || pullPx > 0 ? 'none' : 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
```

   SwipeToAct's commit-flash `setTimeout` at line 105 is timed to the
   220ms animation and must stay in sync when the duration unifies:

```tsx
// frontend/src/components/_shared/SwipeToAct.tsx:104-105 — current
        // Clear the commit flash after the spring-back animation.
        setTimeout(() => setCommitting(null), 220)
```

2. Two structurally identical slide keyframes are defined inline in
   sibling Nav components, both with the weak built-in `ease-out`:

```tsx
// frontend/src/components/Nav/WorkspaceBottomSheet.tsx:131-139 — current
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .animate-slide-up {
          animation: slideUp 0.25s ease-out;
        }
      `}</style>
```

```tsx
// frontend/src/components/Nav/MobileDrawer.tsx:109-117 — current
      <style>{`
        @keyframes slideRight {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-right {
          animation: slideRight 0.2s ease-out;
        }
      `}</style>
```

   **Execution-order caveat**: plan 004 may replace these keyframes with
   transitions. Grep for whatever exists at execution time (see Steps) and
   migrate that form.

## Target

1. Motion tokens added to the `@theme` block in
   `frontend/src/index.css`, after the color tokens (after line 26, before
   the closing `}` on line 27), exactly:

```css
  /* Motion tokens */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* strong ease-out for UI entrances/exits */
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out for on-screen movement */
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer/sheet curve */
  --ease-spring-back: cubic-bezier(0.2, 0.8, 0.2, 1); /* gesture snap-back (existing repo curve) */
```

2. Both snap-back sites migrate to the token, unified on 200ms (the 220 vs
   200 difference has no rationale):

```tsx
// frontend/src/components/_shared/SwipeToAct.tsx:160 — target
          transition: dx === 0 ? 'transform 200ms var(--ease-spring-back)' : 'none',
```

```tsx
// frontend/src/components/_shared/PullToRefresh.tsx:91 — target
          transition: refreshing || pullPx > 0 ? 'none' : 'transform 200ms var(--ease-spring-back)',
```

   And SwipeToAct's commit-flash timer follows the new duration:

```tsx
// frontend/src/components/_shared/SwipeToAct.tsx:105 — target
        setTimeout(() => setCommitting(null), 200)
```

3. Drawer/sheet motion migrates to `var(--ease-drawer)`, **durations
   unchanged** (0.25s sheet, 0.2s drawer stay). If the keyframes still
   exist at execution time:

```css
/* WorkspaceBottomSheet.tsx <style> — target line */
          animation: slideUp 0.25s var(--ease-drawer);
```

```css
/* MobileDrawer.tsx <style> — target line */
          animation: slideRight 0.2s var(--ease-drawer);
```

   If plan 004 has already replaced the keyframes with transitions, apply
   `var(--ease-drawer)` to the transition's easing slot instead, keeping
   whatever duration and properties the transition uses.

Reduced-motion note: this plan changes curves and durations only, not
what animates, so it composes with the global reduced-motion rule at
`frontend/src/index.css:105-112` both as it stands today and after plan
005 rescopes it — token references are transparent to that rule. Nothing
extra to do.

## Repo conventions to follow

- Theme tokens live in the `@theme` block of `frontend/src/index.css`,
  one `--name: value;` per line with trailing `/* rationale */` comments —
  follow the existing `--color-*` entries exactly (two-space indent,
  comment alignment like lines 7, 10, 26). Match that style for the four
  new tokens.
- Tokens are consumed via `var(--token-name)` in inline `style={{}}`
  objects and inline `<style>` blocks — the established pattern, e.g.
  `color: 'var(--color-gold)'` in `PullToRefresh.tsx:81`.
- Tailwind v4 note: defining `--ease-*` in `@theme` also generates
  `ease-*` utilities and overrides Tailwind's default `ease-out` class
  value. This is safe here — a repo-wide grep at commit 18cc791 shows no
  `ease-out`/`ease-in-out` class usage, only the two keyframe sites being
  migrated. Do not start using the generated classes in this plan; the
  tokens are consumed via `var()` only.

## Steps

1. `frontend/src/index.css`: insert the four motion tokens into the
   `@theme` block immediately after line 26
   (`--color-toggle-off: #5b6276; ...`), before the closing `}` on line
   27. Use the exact Target block above.
2. `frontend/src/components/_shared/SwipeToAct.tsx`:
   - Line 160: replace `'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)'`
     with `'transform 200ms var(--ease-spring-back)'`.
   - Line 105: replace `setTimeout(() => setCommitting(null), 220)` with
     `setTimeout(() => setCommitting(null), 200)` so the commit flash
     still clears exactly when the snap-back lands. Leave the comment on
     line 104 as is — it remains accurate.
3. `frontend/src/components/_shared/PullToRefresh.tsx`:
   - Line 91: replace `'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)'`
     with `'transform 200ms var(--ease-spring-back)'`.
4. Drawer/sheet: first run
   `grep -rn "slideUp\|slideRight\|ease-drawer" frontend/src/components/Nav/`
   to see which form exists at execution time.
   - If the `<style>` keyframes quoted above are still there: in
     `WorkspaceBottomSheet.tsx` change `animation: slideUp 0.25s ease-out;`
     to `animation: slideUp 0.25s var(--ease-drawer);`; in
     `MobileDrawer.tsx` change `animation: slideRight 0.2s ease-out;` to
     `animation: slideRight 0.2s var(--ease-drawer);`. Keep the keyframes
     themselves and both durations untouched.
   - If plan 004 has replaced them with transitions: find the transition
     declarations that drive the drawer/sheet open/close and swap their
     easing for `var(--ease-drawer)`, keeping their durations. If you
     cannot find any drawer/sheet motion at all, STOP and report.
5. Sanity grep: `grep -rn "cubic-bezier(0.2, 0.8, 0.2, 1)" frontend/src/`
   must return zero matches when done.

## Boundaries

- Only `frontend/src/index.css` (the `@theme` addition) and the
  easing/duration literals listed in Steps. Do NOT restyle anything else.
- Do NOT add new keyframes, do NOT delete the existing `slideUp` /
  `slideRight` keyframes (plan 004 owns that refactor), do NOT rename
  classes.
- Do NOT change any duration except the two called out (SwipeToAct 220 →
  200 transition and its paired `setTimeout`). Sheet stays 0.25s, drawer
  stays 0.2s.
- Do NOT convert `var()` token usage into Tailwind utility classes, and do
  NOT start consuming the tokens anywhere beyond the listed sites (plan
  011 and others reference `--ease-out` themselves).
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build` — all three must pass. Plus the step-5 grep returning zero matches.
- **Feel check**: run `cd /projects/ficino/frontend && npm run dev`, open
  the app (it may be served under the base path `/ficino`) on a mobile
  viewport:
  - Swipe a feed row left/right and release short of the threshold: the
    card snaps back with the same spring feel as before (200ms now —
    20ms faster than the old SwipeToAct value, imperceptible).
  - Trigger a full swipe commit: the colored gutter flash still clears
    exactly as the card finishes landing — no lingering tint, no early
    cut.
  - Pull-to-refresh on the feed and release below the threshold: content
    springs back identically to before.
  - Open the workspace bottom sheet and the mobile drawer: both slide in
    with the same durations as before, with a slightly crisper settle
    (the iOS-like curve). In DevTools' Animations panel at 10% playback,
    confirm the motion starts fast and eases into place rather than
    gliding uniformly.
  - Toggle `prefers-reduced-motion` (Rendering panel): sheet/drawer
    movement is dropped per the global rule; nothing in this plan changes
    that behavior.
- **Done when**: the four tokens exist in the `@theme` block; both
  snap-back sites reference `var(--ease-spring-back)` at 200ms; the
  commit-flash timer reads 200; drawer/sheet motion references
  `var(--ease-drawer)` at unchanged durations; the zero-match grep holds;
  lint/test/build all pass.
