# 014 — Entrance motion for offline success, install banner, and first app paint

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: LOW
- **Category**: Missed opportunities (additive)
- **Estimated scope**: 3 files, ~40 lines changed

## Problem

Rare, high-emotion moments render flat — audit §8: "Rare, high-emotion moments
(first-run, success, celebration) rendered with none of the delight budget they're
allowed." Four verified sites (commit 18cc791):

Site 1 — `frontend/src/components/Nav/DownloadProgress.tsx:17-18`: the download
modal's backdrop + dialog appear with zero entrance. Also a cohesion outlier:
`WorkspaceBottomSheet` and `MobileDrawer` slide in; this modal blinks in.

```tsx
// frontend/src/components/Nav/DownloadProgress.tsx:17-18 — current
<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
  <div className="bg-bg border border-border rounded-xl w-[340px] shadow-xl">
```

Site 2 — `frontend/src/components/Nav/DownloadProgress.tsx:50`: the progress bar
uses `transition-all duration-300` though only `width` changes:

```tsx
// frontend/src/components/Nav/DownloadProgress.tsx:49-55 — current
<div
  className="h-full rounded-full transition-all duration-300"
  style={{
    width: `${pct}%`,
    background: 'linear-gradient(90deg, var(--color-gold), var(--color-gold-dark))',
  }}
/>
```

`transition: all` is always a finding (audit §5). Note: animating `width` on a
progress bar is an accepted pragmatic exception to the transform-only rule —
transform alternatives (scaleX) distort the gradient and the rounded end. Keep
`width`, make the property list explicit.

Site 3 — `frontend/src/components/Nav/DownloadProgress.tsx:36-40`: the success
state — "Ready for offline use", the single most celebratory moment in the app —
is a static green Check:

```tsx
// frontend/src/components/Nav/DownloadProgress.tsx:36-40 — current
{progress.done ? (
  <div className="flex items-center gap-2 text-sm text-green-400 py-2">
    <Check size={16} />
    <span>Ready for offline use</span>
  </div>
```

Site 4 — `frontend/src/components/Nav/InstallPrompt.tsx:27`:
`MobileInstallBanner` pops into the feed header with no entrance:

```tsx
// frontend/src/components/Nav/InstallPrompt.tsx:27 — current
<div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-gold/5">
```

Site 5 — `frontend/src/App.tsx:347-356`: `AuthGate` swaps the full-screen spinner
for the entire app in one frame on first load:

```tsx
// frontend/src/App.tsx:347-356 — current
if (loading) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <Loader2 size={32} className="text-gold animate-spin" />
    </div>
  )
}
if (passwordRecovery || onResetPath) return <LoginPage />
if (!user && provider !== 'none') return <LoginPage />
return <>{children}</>
```

## Target

If plan 010 has already been executed and the matching token exists in
`frontend/src/index.css`, reference the token instead of the inline value.

### Sub-fix A — DownloadProgress modal entrance (DownloadProgress.tsx)

Backdrop: `opacity` fade, 200ms `ease-out`. Dialog: `opacity` + `transform:
scale(0.97)` → `scale(1)`, 200ms `cubic-bezier(0.23, 1, 0.32, 1)`. Per audit §3:
never `scale(0)` — nothing appears from nothing; the entering range is
`scale(0.9–0.97)` + `opacity: 0`. Modals are center-origin exempt — origin stays
center, do not flag it.

Reuse of plan 011's `FadeIn` is NOT possible here — `FadeIn` is opacity-only and
the dialog needs the scale. Implement locally with the same `data-mounted`
mount-attribute pattern plan 011 uses:

```tsx
/* target — pattern to mirror from plan 011's FadeIn */
const [mounted, setMounted] = useState(false)
useEffect(() => {
  const id = requestAnimationFrame(() => setMounted(true))
  return () => cancelAnimationFrame(id)
}, [])
```

Backdrop becomes (transition runs when `data-mounted` flips):

```tsx
/* target — frontend/src/components/Nav/DownloadProgress.tsx:17 */
<div
  data-mounted={mounted || undefined}
  className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm opacity-0 transition-opacity duration-200 ease-out data-[mounted]:opacity-100"
>
```

Dialog becomes:

```tsx
/* target — frontend/src/components/Nav/DownloadProgress.tsx:18 */
<div
  data-mounted={mounted || undefined}
  className="bg-bg border border-border rounded-xl w-[340px] shadow-xl opacity-0 scale-[0.97] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none data-[mounted]:opacity-100 data-[mounted]:scale-100"
>
```

(The modal mounts with `progress` already set — `if (!progress) return null` at
line 12 — so a single mount-time entrance is the whole job; no exit animation in
scope.)

### Sub-fix B — Success state (DownloadProgress.tsx:36-40)

Wrap the `progress.done` branch so Check + text fade in with `opacity` 150ms and
the Check scales from `0.9` → `1` over 200ms `cubic-bezier(0.23, 1, 0.32, 1)` —
subtle, no overshoot/bounce. Audit §4: visible bounce is reserved for
drag-to-dismiss and playful moments; keep this crisp.

```tsx
/* target — frontend/src/components/Nav/DownloadProgress.tsx:36-40 */
{progress.done ? (
  <div
    data-mounted={mounted || undefined}
    className="flex items-center gap-2 text-sm text-green-400 py-2 opacity-0 transition-opacity duration-150 ease-out data-[mounted]:opacity-100"
  >
    <span className="inline-flex scale-90 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none data-[mounted]:scale-100" data-mounted={mounted || undefined}>
      <Check size={16} />
    </span>
    <span>Ready for offline use</span>
  </div>
```

Note: `progress.done` flips long after mount, so this branch needs its own mounted
flag — a second `useState`/`useEffect` pair (`doneMounted`) that sets via
`requestAnimationFrame` when `progress.done` first becomes true, used in place of
`mounted` in the snippet above. Two small `useState`/`useEffect` pieces total in
this file.

### Sub-fix C — Progress bar property list (DownloadProgress.tsx:50)

Retarget `transition-all` to the one property that actually changes:

```tsx
/* target — frontend/src/components/Nav/DownloadProgress.tsx:50 */
className="h-full rounded-full transition-[width] duration-300 ease-out"
```

### Sub-fix D — MobileInstallBanner entrance (InstallPrompt.tsx:27)

Entrance `translateY(-100%)` → `0` (its own height — audit §8's sanctioned
percentage-translate tool, no hardcoded pixels) + opacity, 200ms
`cubic-bezier(0.23, 1, 0.32, 1)`, `motion-reduce:transition-none`. Same
`data-mounted` pattern (add `useState`/`useEffect` to `MobileInstallBanner`):

```tsx
/* target — frontend/src/components/Nav/InstallPrompt.tsx:27 */
<div
  data-mounted={mounted || undefined}
  className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-gold/5 opacity-0 -translate-y-full transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none data-[mounted]:opacity-100 data-[mounted]:translate-y-0"
>
```

### Sub-fix E — AuthGate first paint (App.tsx:356)

Wrap the `{children}` return in plan 011's `FadeIn` (opacity-only, one 150ms fade
on first mount, `cubic-bezier(0.23, 1, 0.32, 1)`). Mount-only — NO `key`: it must
not replay on re-renders.

```tsx
/* target — frontend/src/App.tsx:356 */
return <FadeIn>{children}</FadeIn>
```

### Reduced motion

Opacity fades keep running under `prefers-reduced-motion` — they aid comprehension
(audit §6: reduced motion means fewer and gentler animations, not zero). Transforms
get `motion-reduce:transition-none` as written above. The repo's global rule
(`frontend/src/index.css:105-112`) already collapses all transition durations;
the `motion-reduce:` variants document intent and survive any future refinement of
that global rule.

## Repo conventions to follow

- Shared primitives live in `frontend/src/components/_shared/`; plan 011's
  `FadeIn` is the mount-fade exemplar — sub-fixes A/B/D copy its `data-mounted`
  pattern exactly rather than inventing a new one.
- Tailwind CSS v4, theme tokens in `frontend/src/index.css` `@theme`; one-off
  utilities use arbitrary values (`scale-[0.97]`,
  `ease-[cubic-bezier(0.23,1,0.32,1)]`, `transition-[width]`).
- `data-[mounted]:` is Tailwind's arbitrary data-attribute variant — pair it with
  `data-mounted={mounted || undefined}` so the attribute is absent (not `"false"`)
  before mount.
- No motion library exists and none may be added — everything here is CSS
  transitions + two-line mount effects.
- Existing spinner conventions (`animate-spin`, `Loader2`) stay untouched.

## Steps

0. **Prerequisite check (sub-fix E only).** Check whether
   `frontend/src/components/_shared/FadeIn.tsx` exists (plan 011). If absent,
   implement sub-fixes A–D and report sub-fix E as blocked on plan 011 — do NOT
   reimplement FadeIn inline. Sub-fixes A–D have no dependency.
1. `frontend/src/components/Nav/DownloadProgress.tsx` — add
   `import { useState, useEffect } from 'react'`. Add the `mounted` mount-effect
   (pattern above). Apply the backdrop and dialog class changes from sub-fix A.
   Change the progress bar class to `transition-[width] duration-300 ease-out`
   (sub-fix C). Add the `doneMounted` state/effect (sets true via
   `requestAnimationFrame` in a `useEffect` keyed on `progress.done`) and wrap the
   success branch per sub-fix B, using `doneMounted`.
2. `frontend/src/components/Nav/InstallPrompt.tsx` — add
   `import { useState, useEffect } from 'react'` to `MobileInstallBanner`, add the
   `mounted` mount-effect, and apply the sub-fix D class string. Do NOT touch
   `InstallButton` (its `transition-all duration-100` on hover is out of scope).
3. `frontend/src/App.tsx` — if `FadeIn` exists: import it
   (`import { FadeIn } from './components/_shared/FadeIn'`) and change
   `AuthGate`'s final return to `return <FadeIn>{children}</FadeIn>`. No `key`.
   Leave the `loading`, `passwordRecovery`, and `LoginPage` branches untouched.
4. Verify no layout classes, aria attributes, or conditional logic changed
   anywhere — motion properties and the two mount effects only.

## Boundaries

- Only `frontend/src/components/Nav/DownloadProgress.tsx`,
  `frontend/src/components/Nav/InstallPrompt.tsx`, and `AuthGate` in
  `frontend/src/App.tsx`.
- Do NOT touch `WorkspaceBottomSheet`, `MobileDrawer`, or any other entrance —
  they are cited as cohesion context only.
- Do NOT add an exit animation for the modal or banner — entrances only.
- Do NOT add bounce/overshoot to the success Check — `scale(0.9)` → `1`, crisp.
- Do NOT scale the modal from `scale(0)` — the floor is `scale(0.97)`; do not add
  `transform-origin` (center is correct for modals, audit §3).
- Do NOT change the progress bar's animated property away from `width` (gradient
  distortion) — only make the transition property list explicit.
- Do NOT reimplement or modify `FadeIn`; sub-fix E uses plan 011's component
  verbatim or is reported blocked.
- If a step doesn't match the code you find (drift since the commit stamp), STOP
  and report instead of improvising.

## Verification

- **Mechanical**: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build` — all must pass.
- **Feel check**: run `cd /projects/ficino/frontend && npm run dev` (app may be
  under base path `/ficino`), then:
  - Trigger a workspace download (Storage settings → download a workspace): the
    backdrop fades in over 200ms while the dialog scales 0.97 → 1 from center —
    no blink-in, no scale-from-zero pop.
  - Watch the progress bar: it still advances smoothly; in DevTools' Animations
    panel the only transitioned property is `width`.
  - On completion, "Ready for offline use" fades in (150ms) and the Check scales
    0.9 → 1 over 200ms — crisp, no bounce, no overshoot past 1.
  - On mobile viewport (DevTools device toolbar), with the install prompt
    eligible, the banner slides down its own height + fades over 200ms.
  - Reload the app: after the auth spinner clears, the whole app fades in once
    (~150ms) and never re-fades on subsequent re-renders or view switches.
  - In DevTools, set animation playback to 10% (Animations panel): the dialog
    entrance shows only `opacity` + `transform`; the banner only
    `opacity` + `transform`.
  - Toggle `prefers-reduced-motion` (Rendering panel): scale/translate movement is
    dropped (instant), opacity fades remain or collapse to instant via the global
    rule — no movement may remain.
- **Done when**: all four entrances + the progress-bar retarget are in place (or
  sub-fix E is explicitly reported blocked on plan 011); `transition-all` no longer
  appears in `DownloadProgress.tsx`; no `scale(0)` anywhere; lint/test/build green.
