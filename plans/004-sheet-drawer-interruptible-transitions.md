# 004 — Replace sheet/drawer keyframes with interruptible transitions and real exits

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Interruptibility
- **Estimated scope**: 2 files, ~60 lines changed

## Problem

Two overlay components animate entry with one-shot `@keyframes` and have **no exit animation at all** — on close they teleport away. Both sites verified current, no drift.

`frontend/src/components/Nav/WorkspaceBottomSheet.tsx:131-139`:

```tsx
/* frontend/src/components/Nav/WorkspaceBottomSheet.tsx:131-139 — current */
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

`animate-slide-up` is applied to the sheet div at line 31; the backdrop (lines 25-28) has no transition:

```tsx
/* frontend/src/components/Nav/WorkspaceBottomSheet.tsx:25-31 — current */
<div
  className="fixed inset-0 bg-black/60 z-50"
  onClick={onClose}
/>

{/* Sheet */}
<div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Workspaces" className="fixed bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-2xl max-h-[70vh] overflow-y-auto animate-slide-up">
```

`frontend/src/components/Nav/MobileDrawer.tsx:109-117` — same pattern:

```tsx
/* frontend/src/components/Nav/MobileDrawer.tsx:109-117 — current */
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

`animate-slide-right` is applied to the drawer div at line 65; `MobileDrawer` returns `null` when `!open` (line 52); its backdrop (lines 58-62) has no transition.

Why it matters (audit §4): CSS **transitions** retarget from the current state mid-animation; **keyframes restart from zero**. An open/close spam or a close-tap during entry visibly restarts the slide. Worse, close has no exit animation at all — the overlay unmounts instantly, a jarring teleport (audit §8). Both also use the weak built-in `ease-out`; the audit's drawer curve is `cubic-bezier(0.32, 0.72, 0, 1)` (audit §2, `--ease-drawer`).

## Target

Replace keyframe animations with CSS transitions on `transform` (surfaces) and `opacity` (backdrops). Entry initial state via Tailwind v4's `starting:` variant (`@starting-style` under the hood), **plus** a `mounted` state set in `useEffect` + `requestAnimationFrame` as the documented fallback — include both, because the app's PWA audience includes older iOS Safari without `@starting-style` support. Exit runs on a local `closing` state that flips the transition target, then calls the parent's `onClose` in a `setTimeout` matching the exit duration.

Exact values:

- **Sheet** (`WorkspaceBottomSheet`): entry `transform 250ms cubic-bezier(0.32, 0.72, 0, 1)` from `translateY(100%)`; exit **200ms** same curve to `translateY(100%)`.
- **Drawer** (`MobileDrawer`): entry **200ms** same curve from `translateX(-100%)`; exit **160ms** same curve to `translateX(-100%)`.
- Asymmetric on purpose (exit faster than entry — audit §4); all within the audit §2 modal/drawer budget of 200–500ms.
- **Backdrops** (both): `transition: opacity 200ms ease-out`, entering from `opacity: 0`, exiting back to `opacity: 0`.
- **Reduced motion**: add `motion-reduce:transition-none` to the sheet/drawer surfaces so reduced-motion users get an instant swap; the backdrop opacity fade may keep its transition (the global rule at `frontend/src/index.css:105-112` already collapses it to 0.01ms anyway — this is belt and braces).

If plan 010 has already been executed and the matching token exists in `frontend/src/index.css` (e.g. `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`), reference the token instead of the inline value.

### WorkspaceBottomSheet.tsx — target

```tsx
/* target — state additions near line 17-20 */
const [creating, setCreating] = useState(false)
const [newName, setNewName] = useState('')
const [mounted, setMounted] = useState(false)
const [closing, setClosing] = useState(false)
const dialogRef = useRef<HTMLDivElement>(null)
useFocusTrap(true, dialogRef)

// Entry fallback for browsers without @starting-style (older iOS
// Safari in the PWA): start translated off, flip to the resting state
// on the next frame so the transition runs.
useEffect(() => {
  const raf = requestAnimationFrame(() => setMounted(true))
  return () => cancelAnimationFrame(raf)
}, [])

// Intercept internal close paths so the exit transition plays before
// the parent unmounts us. Parent-initiated closes (e.g. the global
// Esc shortcut in App.tsx) still unmount instantly — documented
// limitation; App.tsx is out of scope.
const requestClose = () => {
  if (closing) return
  setClosing(true)
  setTimeout(onClose, 200) // matches exit duration
}
```

(Add `useEffect` to the React import on line 1: `import { useEffect, useRef, useState } from 'react'`.)

```tsx
/* target — backdrop, replacing lines 25-28 */
<div
  className={`fixed inset-0 bg-black/60 z-50 transition-opacity duration-200 ease-out ${
    closing || !mounted ? 'opacity-0' : 'opacity-100'
  }`}
  onClick={requestClose}
/>
```

```tsx
/* target — sheet div className, replacing line 31 (ref/role/aria unchanged) */
className={`fixed bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-2xl max-h-[70vh] overflow-y-auto motion-reduce:transition-none transition-transform ease-[cubic-bezier(0.32,0.72,0,1)] starting:translate-y-full ${
  closing
    ? 'translate-y-full duration-[200ms]'
    : mounted
      ? 'translate-y-0 duration-[250ms]'
      : 'translate-y-full duration-[250ms]'
}`}
```

Every internal `onClose` call becomes `requestClose`: backdrop onClick (line 27), X button onClick (line 41), workspace-item select `onClick={() => { onSwitch(ws.id); onClose() }}` → `requestClose()` (line 54), and both create-flow `onClose()` calls (lines 95 and 110). The `<style>` block at lines 131-139 is **deleted entirely**.

### MobileDrawer.tsx — target

```tsx
/* target — state additions near lines 32-33 */
const dialogRef = useRef<HTMLDivElement>(null)
useFocusTrap(open, dialogRef)
const [mounted, setMounted] = useState(false)
const [closing, setClosing] = useState(false)

useEffect(() => {
  if (!open) return
  const raf = requestAnimationFrame(() => setMounted(true))
  return () => cancelAnimationFrame(raf)
}, [open])

// Exit plays, then we hand off to the parent. 160ms matches the exit
// duration. Parent-initiated closes (open flips to false from outside)
// still unmount instantly — documented limitation.
const requestClose = () => {
  if (closing) return
  setClosing(true)
  setTimeout(onClose, 160)
}
```

(Add `useState` to the React import on line 1: `import { useEffect, useRef, useState } from 'react'`.)

In the existing Esc effect (lines 40-50), change `onClose()` to `requestClose()` and add `requestClose`-safe deps — since `requestClose` is re-created each render and only calls stable things, simply define it before the effect and use it inside; update the effect's dependency array to `[open, requestClose]` is NOT required — keep `[open, onClose]` and call `requestClose()` in the handler body (it closes over the latest render's `closing`/`onClose`; the effect re-runs when `open`/`onClose` change, which is sufficient here).

```tsx
/* target — backdrop, replacing lines 58-62 */
<div
  aria-hidden="true"
  className={`fixed inset-0 bg-black/60 z-50 transition-opacity duration-200 ease-out ${
    closing || !mounted ? 'opacity-0' : 'opacity-100'
  }`}
  onClick={requestClose}
/>
```

```tsx
/* target — drawer div className, replacing line 65 (ref/role/aria unchanged) */
className={`fixed top-0 left-0 bottom-0 w-[min(320px,88vw)] bg-bg z-50 overflow-y-auto border-r border-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] motion-reduce:transition-none transition-transform ease-[cubic-bezier(0.32,0.72,0,1)] starting:translate-x-[-100%] ${
  closing
    ? 'translate-x-[-100%] duration-[160ms]'
    : mounted
      ? 'translate-x-0 duration-[200ms]'
      : 'translate-x-[-100%] duration-[200ms]'
}`}
```

Every internal `onClose` call becomes `requestClose`: backdrop onClick (line 61), X button onClick (line 82), Esc handler (line 45), `onTagFilter` wrapper `onClose()` (line 100), and `onPaperClick` wrapper `onClose()` (line 102). The `<style>` block at lines 109-117 is **deleted entirely**.

## Repo conventions to follow

- Tailwind CSS v4 arbitrary values are used throughout these files already (`max-h-[70vh]`, `w-[min(320px,88vw)]`, `pt-[env(safe-area-inset-top)]`), so `duration-[250ms]`, `ease-[cubic-bezier(0.32,0.72,0,1)]`, and `starting:translate-y-full` fit the codebase style. Tailwind v4's `starting:` variant emits `@starting-style` — audit §4's sanctioned "entry without JS" mechanism; the `mounted`/rAF state is its documented fallback.
- `motion-reduce:` is Tailwind's standard variant for the global rule's spirit at `frontend/src/index.css:105-112`.
- Conditional class composition via template literals is already the local idiom (see `className={`shrink-0 ${iconClassName || ''}`}` in `frontend/src/components/Feed/PostCard.tsx:73`).
- Inline `<style>` blocks with `@keyframes` are exactly what this plan removes — do not introduce new ones.

## Steps

1. `frontend/src/components/Nav/WorkspaceBottomSheet.tsx` — update the React import to include `useEffect`; add `mounted`/`closing` state, the rAF mount effect, and `requestClose` exactly as in Target.
2. Same file — replace the backdrop div and the sheet div `className` with the target versions (backdrop gains the opacity transition; sheet drops `animate-slide-up`, gains the transition classes and conditional transform/duration).
3. Same file — replace all five internal `onClose` calls (lines 27, 41, 54, 95, 110) with `requestClose`.
4. Same file — delete the entire `<style>{`...`}</style>` block (lines 131-139).
5. `frontend/src/components/Nav/MobileDrawer.tsx` — update the React import to include `useState`; add `mounted`/`closing` state, the rAF mount effect (gated on `open`), and `requestClose` exactly as in Target.
6. Same file — in the Esc effect (lines 40-50) change `onClose()` to `requestClose()`; keep the dependency array `[open, onClose]`.
7. Same file — replace the backdrop div and the drawer div `className` with the target versions; replace the remaining internal `onClose` calls (lines 61, 82, 100, 102) with `requestClose`.
8. Same file — delete the entire `<style>{`...`}</style>` block (lines 109-117).
9. Grep both files to confirm no `animate-slide-up`, `animate-slide-right`, `@keyframes`, or `<style>` remains.

## Boundaries

- Only `frontend/src/components/Nav/WorkspaceBottomSheet.tsx` and `frontend/src/components/Nav/MobileDrawer.tsx`.
- Do NOT restructure `App.tsx` or any parent — parent-initiated closes (e.g. the global Esc shortcut) unmounting instantly without exit animation is an accepted, documented limitation of this plan.
- Do NOT change layout/markup beyond motion classes, the `closing`/`mounted` state, and the rAF effect — all `ref`/`role`/`aria-*` attributes stay.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build` — all must pass (build runs `tsc -b && vite build`). Note: Tailwind only emits classes it sees literally in source — every class above is a complete literal string, so `duration-[250ms]`, `duration-[200ms]`, `duration-[160ms]`, `ease-[cubic-bezier(0.32,0.72,0,1)]`, `starting:translate-y-full`, `starting:translate-x-[-100%]`, `translate-y-full`, `translate-x-[-100%]`, `translate-y-0`, `translate-x-0` must appear verbatim as written.
- **Feel check**: `cd /projects/ficino/frontend && npm run dev` (app may be served under base path `/ficino`), mobile viewport or touch emulation:
  - Open the workspace sheet (long-press Home) — it slides up over 250ms with the drawer curve; the backdrop fades in over 200ms.
  - Close it via backdrop tap, X button, and selecting a workspace — each time the sheet slides back down over 200ms and the backdrop fades out **before** the overlay disappears; no teleport.
  - Open the sheet and immediately tap the backdrop mid-entry — the surface reverses direction from its current position instead of restarting from zero (transitions retarget; the old keyframes could not).
  - Open/close the mobile drawer (hamburger) — slides in 200ms / out 160ms from the left, backdrop fades; Esc inside a drawer input closes with the exit animation.
  - In DevTools, set playback to 10% (Animations panel) and confirm the motion is a single `transform` transition on the surface plus an `opacity` transition on the backdrop — nothing else animates (no layout properties).
  - Toggle `prefers-reduced-motion` (Rendering panel) and confirm the sheet/drawer swap instantly (no slide) while the backdrop fade is effectively instant via the global rule.
- **Done when**: no `@keyframes`/`<style>` blocks remain in either file; entry and exit both animate with the exact durations/curve above; all internal close paths route through `requestClose`; lint, tests, and build all green.
