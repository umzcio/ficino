# 001 — Drive PostCard action-button hover in CSS, add press feedback

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: HIGH
- **Category**: Physicality & performance
- **Estimated scope**: 1 file, ~30 lines changed

## Problem

`frontend/src/components/Feed/PostCard.tsx:19-53` — the `ActionBtn` component (the feed Reply / Zap / Like / Bookmark buttons, the most-pressed UI in the app; note the finding called it `ActionButton`, the actual name in code is `ActionBtn` — drift in naming only, code is current):

```tsx
/* frontend/src/components/Feed/PostCard.tsx:29-48 — current */
const [hovered, setHovered] = useState(false)
const isLit = active || hovered

return (
  <button
    onClick={(e) => { e.stopPropagation(); onClick?.() }}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    aria-label={count !== undefined ? `${label}: ${count}` : label}
    aria-pressed={active}
    className="flex items-center gap-[5px] px-3 py-2.5 rounded-[20px] text-[13px] flex-1 justify-center max-w-[80px] min-h-[44px] border-none bg-transparent cursor-pointer transition-all duration-100"
    style={{
      color: isLit ? color : 'var(--color-text-muted)',
      backgroundColor: isLit ? color + '15' : 'transparent',
    }}
  >
    <Icon
      size={16}
      strokeWidth={isLit ? 2.5 : 1.75}
      fill={active && color === 'var(--color-like)' ? color : 'none'}
    />
```

Three problems:

1. **React-state hover**: every mouseenter/mouseleave re-renders the button just to swap inline styles. Hover color is predetermined motion — CSS should do it (audit §5: CSS beats JS for predetermined motion).
2. **`transition-all duration-100`** (line 39) animates every property off-GPU when only `color` / `background-color` / `transform` ever change — `transition: all` is always a finding (audit §5).
3. **No `:active` press feedback** — the most-pressed buttons in the app give no tactile response (audit §3: `transform: scale(0.97)` on `:active`, keep within 0.95–0.98).

**Hidden rendering bug this plan also fixes**: every caller passes a CSS-variable string as `color` — verified at `frontend/src/components/Feed/PostCard.tsx:861` (`color="var(--color-persona-practitioner)"`), `:866` (`var(--color-retweet)`), `:894` (`var(--color-like)`), `:902` (`var(--color-gold)`), `:982`, `:987`, `:1015`, `:1022`. So `color + '15'` (line 42) produces e.g. `var(--color-like)15` — invalid CSS — and the tinted hover/active background **never renders today**. The color-mix CSS approach below fixes this.

## Target

Remove the `hovered` state and both mouse handlers. Hover becomes pure CSS driven by a per-button custom property; `active` (the toggled state, e.g. liked) stays JS-driven and sets color inline. Delete the `isLit` alias — use `active` directly everywhere `isLit` was used. Deliberate simplification: the hover-driven `strokeWidth` 1.75→2.5 change is dropped entirely — it was invisible churn tied to the React hover state; `strokeWidth` is now driven by `active` only.

If plan 010 has already been executed and the matching token exists in `frontend/src/index.css`, reference the token instead of the inline value. (No easing token is needed here — `ease-out` is a built-in — this line applies only if a shared token for this curve is later introduced.)

```tsx
/* target — frontend/src/components/Feed/PostCard.tsx, ActionBtn */
function ActionBtn({
  icon: Icon, count, color, active, onClick, label,
}: {
  icon: typeof MessageCircle
  count?: number
  color: string
  active?: boolean
  onClick?: () => void
  label: string
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      aria-label={count !== undefined ? `${label}: ${count}` : label}
      aria-pressed={active}
      className="flex items-center gap-[5px] px-3 py-2.5 rounded-[20px] text-[13px] flex-1 justify-center max-w-[80px] min-h-[44px] border-none bg-transparent cursor-pointer transition-[color,background-color,transform] duration-100 ease-out active:scale-[0.97] hover:text-[var(--action-color)] hover:bg-[color-mix(in_srgb,var(--action-color)_8%,transparent)]"
      style={{
        '--action-color': color,
        color: active ? color : 'var(--color-text-muted)',
        backgroundColor: active ? `color-mix(in srgb, ${color} 8%, transparent)` : 'transparent',
      } as CSSProperties}
    >
      <Icon
        size={16}
        strokeWidth={active ? 2.5 : 1.75}
        fill={active && color === 'var(--color-like)' ? color : 'none'}
      />
      {count !== undefined && <span>{formatNum(count)}</span>}
    </button>
  )
}
```

Exact values, and where they come from:

- Transition properties: `color, background-color, transform` (was `all`).
- Duration `duration-100` = 100ms, kept — inside the audit §2 button-press budget of 100–160ms.
- `ease-out` added explicitly — Tailwind's default transition timing function is `cubic-bezier(0.4, 0, 0.2, 1)`, not ease-out; audit §2 default for entering/hover feedback is ease-out.
- Press feedback `active:scale-[0.97]` — audit §3 value (keep within 0.95–0.98).
- Hover background `color-mix(in srgb, var(--action-color) 8%, transparent)` — 8% matches the repo's existing convention at `frontend/src/App.tsx:116` (`color-mix(in srgb, var(--color-gold) 8%, transparent)`). In the Tailwind arbitrary value, spaces are written as underscores: `hover:bg-[color-mix(in_srgb,var(--action-color)_8%,transparent)]`.
- Active background uses the same `color-mix` at 8% inline (replaces the broken `color + '15'`; 8% ≈ the intended `15` hex alpha of ~8.3%).

## Repo conventions to follow

- Tailwind CSS v4 arbitrary properties/values are already used in this file (e.g. `max-w-[80px]`, `min-h-[44px]`), so arbitrary `hover:text-[...]` / `hover:bg-[...]` / `active:scale-[0.97]` fit the codebase style.
- color-mix exemplar: `frontend/src/App.tsx:116` — `backgroundColor: active === view ? 'color-mix(in srgb, var(--color-gold) 8%, transparent)' : 'transparent'`.
- Color tokens are CSS variables from the `@theme` block in `frontend/src/index.css:3-27` (e.g. `--color-like`, `--color-gold`); callers keep passing `var(--color-…)` strings — do not change any call site.
- Global reduced-motion rule already exists at `frontend/src/index.css:105-112` and collapses all transition durations — nothing extra needed for reduced motion here.

## Steps

1. `frontend/src/components/Feed/PostCard.tsx` — add `CSSProperties` to the React type imports: change line 1 `import { memo, useState, useRef, useEffect } from 'react'` to `import { memo, useState, useRef, useEffect, type CSSProperties } from 'react'`. (Keep `useState` — it is still used elsewhere in this 1271-line file.)
2. In `ActionBtn` (lines 19-53): delete `const [hovered, setHovered] = useState(false)` and `const isLit = active || hovered`; delete the `onMouseEnter` / `onMouseLeave` props on the `<button>`.
3. Replace the button's `className` `transition-all duration-100` with `transition-[color,background-color,transform] duration-100 ease-out active:scale-[0.97] hover:text-[var(--action-color)] hover:bg-[color-mix(in_srgb,var(--action-color)_8%,transparent)]`, keeping all other classes unchanged and in place.
4. Replace the `style` object with `{ '--action-color': color, color: active ? color : 'var(--color-text-muted)', backgroundColor: active ? `color-mix(in srgb, ${color} 8%, transparent)` : 'transparent' } as CSSProperties`.
5. Change the icon's `strokeWidth={isLit ? 2.5 : 1.75}` to `strokeWidth={active ? 2.5 : 1.75}`. Leave `size={16}` and the `fill={...}` line exactly as they are.
6. Do not touch any of the 8 `ActionBtn` call sites — the `color` prop contract (`var(--color-…)` string) is unchanged.

## Boundaries

- Only the `ActionBtn` component in `frontend/src/components/Feed/PostCard.tsx`. Do NOT touch `MenuItem` (lines 55-77) or any other component in the file.
- Do NOT add new dependencies.
- Do NOT change markup structure — same elements, same props; motion/styling properties only.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd <repo>/frontend && npm run lint && npm test && npm run build` — all must pass (build runs `tsc -b && vite build`; the `as CSSProperties` cast is what keeps `tsc` happy on the `--action-color` custom property).
- **Feel check**: `cd <repo>/frontend && npm run dev`, open the app (may be served under base path `/ficino`), and confirm:
  - Hovering Reply/Zap/Like/Bookmark tints the icon+count in the action color and shows an 8% tinted pill background — with zero React re-renders (verify with React DevTools Profiler: hover produces no render; only the like/bookmark toggle does).
  - Pressing a button visibly scales it to 0.97 for ~100ms and snaps back.
  - Toggling Like still turns the button pink with the filled heart (`fill` logic untouched).
  - In DevTools, set playback to 10% (Animations panel) and confirm the press scale and the color/background fade are the only things transitioning — no layout shift of neighboring buttons.
  - Toggle `prefers-reduced-motion` (Rendering panel) and confirm hover color feedback still applies but transitions are effectively instant (global rule handles this).
- **Done when**: no `hovered`/`isLit`/`onMouseEnter`/`onMouseLeave` remain in `ActionBtn`; `transition-all` is gone; `active:scale-[0.97]` present; hover background actually paints (it does not today due to the `color + '15'` bug); lint, tests, and build all green.
