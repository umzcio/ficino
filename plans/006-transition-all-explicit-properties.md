# 006 — Replace transition-all with explicit transition properties

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 8 files, ~8 one-line class changes

## Problem

`transition-all` recurs across the app. `transition: all` animates unintended
properties off-GPU — always a finding. Animate `transform` and `opacity`
only; every other property must be listed explicitly so only the properties
that actually change ever transition. The verified sites (current code
verbatim):

```tsx
// frontend/src/components/Personas/PersonaProfile.tsx:627-632 — current (worst offender)
className="flex-1 py-3 border-none bg-transparent cursor-pointer text-[15px] transition-all"
style={{
  color: active === key ? 'var(--color-tab-active)' : 'var(--color-tab-inactive)',
  fontWeight: active === key ? 700 : 400,
  borderBottom: active === key ? `2px solid ${accentColor}` : '2px solid transparent',
}}
```
Here `transition-all` attempts to tween `font-weight` 400↔700 — animating
font weight causes layout-adjacent reflow and cannot tween smoothly — while
the only properties that should transition are `color` and `border-color`.

```tsx
// frontend/src/App.tsx:113 — current (nav buttons; only color/background-color change, lines 114-117)
className="w-[46px] h-[46px] rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-100 hover:bg-gold/10 hover:text-gold relative"

// frontend/src/App.tsx:286 — current (FeedTabs; changes are color, fontWeight, borderBottom, lines 287-291)
className="flex-1 py-3.5 border-none bg-transparent cursor-pointer text-[15px] transition-all duration-150"

// frontend/src/components/Explore/ExploreView.tsx:396 — current (hover-reveal action group; only opacity changes)
<div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-all">

// frontend/src/components/Nav/InstallPrompt.tsx:13 — current (install button; only color/background change)
className="w-[46px] h-[46px] rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-100 hover:bg-gold/10 hover:text-gold"
```

## Target

Apply these exact replacements. Duration values stay as authored. Where a tab
button changes `fontWeight`, the font-weight change becomes instant — that is
correct; font weight should never transition.

| Site | Replacement class |
| --- | --- |
| `frontend/src/components/Personas/PersonaProfile.tsx:627` | `transition-all` → `transition-[color,border-color] duration-150` |
| `frontend/src/App.tsx:113` | `transition-all duration-100` → `transition-colors duration-100` |
| `frontend/src/App.tsx:286` | `transition-all duration-150` → `transition-[color,border-color] duration-150` |
| `frontend/src/components/Explore/ExploreView.tsx:396` | `transition-all` → `transition-opacity` |
| `frontend/src/components/Nav/InstallPrompt.tsx:13` | `transition-all duration-100` → `transition-colors duration-100` |
| `frontend/src/components/Messages/Inbox.tsx:268` | `transition-all` → `transition-[color,border-color] duration-150` (changes are `color`, `fontWeight`, `borderBottom` — same tab pattern as PersonaProfile) |
| `frontend/src/components/Settings/SettingsTabs.tsx:44` | `transition-all duration-150` → `transition-[color,border-color,opacity] duration-150` (changes are `color`, `fontWeight`, `borderBottom`, `opacity`) |
| `frontend/src/components/Upload/PaperUpload.tsx:73` | `transition-all duration-150` → `transition-colors duration-150` (drag-over state changes only `border-color` and `background-color`) |

If plan 010 has already been executed and the matching token exists in
`frontend/src/index.css`, reference the token instead of the inline value.

## Repo conventions to follow

- Transitions are expressed as Tailwind v4 utility classes in the `className`
  string, e.g. `transition-colors` at
  `frontend/src/components/_shared/primitives.tsx:65` (the `Toggle` track) and
  `frontend/src/components/Listen/ListenView.tsx:778`. Follow that — no inline
  `style={{ transition: ... }}`, no new CSS rules.
- Arbitrary property lists use Tailwind's bracket syntax with commas and no
  spaces: `transition-[color,border-color]`.

## Steps

1. Apply the eight replacements from the **Target** table, one edit per site.
2. Run `grep -rn "transition-all" frontend/src` and confirm the only
   remaining hits are the excluded sites owned by other plans:
   `frontend/src/components/Feed/PostCard.tsx:39` (plan 001),
   `frontend/src/components/Nav/DownloadProgress.tsx:50` (plan 014), and
   `frontend/src/components/_shared/primitives.tsx:69` (plan 008).
3. If the grep surfaces any `transition-all` site not listed in the Target
   table or the exclusion list, convert it using the same rule: replace
   `transition-all` with the narrowest utility listing only the properties
   that actually change (`transition-colors` for color/background/border,
   `transition-opacity` for opacity, `transition-[...]` for mixed lists),
   keeping the authored duration. If you cannot determine which properties
   change, STOP and report.

## Boundaries

- Do NOT touch `frontend/src/components/Feed/PostCard.tsx` (ActionButton,
  plan 001), `frontend/src/components/Nav/DownloadProgress.tsx:50` (plan
  014), or `frontend/src/components/_shared/primitives.tsx:69` (Toggle knob,
  plan 008).
- Do NOT change durations — values stay as authored; where no duration was
  authored on a tab button, add `duration-150` per the Target table.
- Do NOT add a transition to `fontWeight` anywhere.
- Do NOT change markup/structure — motion properties only.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: `cd <repo>/frontend && npm run lint && npm test && npm run build`
  — all must pass (the build also proves the arbitrary
  `transition-[color,border-color]` syntax compiles).
- **Feel check**: run the dev server (`cd <repo>/frontend && npm run dev`;
  the app may be under base path `/ficino`) and confirm:
  - Persona tabs, Feed tabs, Inbox tabs, and Settings tabs: active color and
    underline fade in at 150ms exactly as before; the bold weight change is
    now instant (previously a smeared tween — this is the fix, not a
    regression).
  - Nav buttons and the install button: hover color fade at 100ms unchanged.
  - Explore workspace hover-reveal: the action group fades in/out unchanged.
  - Paper upload drop zone: drag-over border/background fade at 150ms
    unchanged.
  - Toggle `prefers-reduced-motion` in DevTools' Rendering panel and confirm
    behavior matches plan 005's expectations (color/opacity fades still run;
    if plan 005 is not yet executed, everything goes instant as today).
- **Done when**: `grep -rn "transition-all" frontend/src` returns only the
  three excluded sites; lint, tests, and build pass; no visual regression in
  any interaction above.
