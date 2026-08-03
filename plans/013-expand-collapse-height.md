# 013 — Animate expand/collapse height with grid-rows

- **Status**: DONE
- **Commit**: 18cc791
- **Severity**: MEDIUM
- **Category**: Missed opportunities (additive)
- **Estimated scope**: 2 files, ~10 lines changed

## Problem

Two expand/collapse toggles insert/remove their content in one frame, shoving
everything below them down (or snapping it back up) with no transition — audit §8:
"State changes that teleport (content swaps, layout jumps) where a brief transition
would prevent a jarring change."

Site 1 — `frontend/src/components/Feed/FeedHistory.tsx:40-42`, the past-feeds list
under the feed header. Toggling inserts/removes the list and shoves `ComposeBox`
and the entire feed:

```tsx
// frontend/src/components/Feed/FeedHistory.tsx:40-42 — current
{expanded && (
  <div className="px-4 pb-3 space-y-1">
    {pastFeeds.map((feed) => (
```

(The conditional block runs through `FeedHistory.tsx:73` — `)}` after the closing
`</div>`. The toggle button that flips `expanded` is at `FeedHistory.tsx:29-38`.)

Site 2 — `frontend/src/components/Sidebar/CorpusPanel.tsx:188-190`, the per-paper
detail in the sidebar:

```tsx
// frontend/src/components/Sidebar/CorpusPanel.tsx:188-190 — current
{/* Expanded detail */}
{expanded && (
  <div className="mt-2 pl-0">
```

(The conditional block runs through `CorpusPanel.tsx:253` — `)}` after the closing
`</div>`. The chevron that reflects `expanded` is at `CorpusPanel.tsx:178-184`.)

## Target

The CSS grid-rows technique: the content moves **out** of the conditional (render
always, animate the rows). A wrapper with `display: grid; grid-template-rows: 0fr;`
transitions to `1fr` when expanded, over `200ms cubic-bezier(0.23, 1, 0.32, 1)`,
with a single inner child carrying `overflow: hidden; min-height: 0;` so the row
can actually collapse to zero.

If plan 010 has already been executed and the matching token exists in
`frontend/src/index.css`, reference the token instead of the inline value.

In Tailwind v4 arbitrary-value classes (this repo has no motion library and no
motion tokens — arbitrary values are the idiom here):

```tsx
/* target — wrapper */
<div
  className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
    expanded ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'
  }`}
>
  <div className="overflow-hidden min-h-0">
    {/* existing expanded content, moved here unchanged, always rendered */}
  </div>
</div>
```

Plain-CSS equivalent, for reference only (do not add a stylesheet — use the classes
above):

```css
/* reference */
.expand-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
.expand-wrapper[data-expanded="true"] { grid-template-rows: 1fr; }
.expand-inner { overflow: hidden; min-height: 0; }
@media (prefers-reduced-motion: reduce) {
  .expand-wrapper { transition: none; }
}
```

Note on the easing class: Tailwind's `ease-out` is `cubic-bezier(0, 0, 0.2, 1)`,
not the audit's strong curve. Use an arbitrary value instead:
`ease-[cubic-bezier(0.23,1,0.32,1)]` — i.e. the wrapper class string becomes:

```
grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none
```

plus `[grid-template-rows:1fr]` / `[grid-template-rows:0fr]` toggled by `expanded`.

Tradeoff, explicitly accepted: the collapsed content now renders in the DOM at all
times. `FeedHistory`'s past-feeds list is a handful of small buttons — acceptable.
`CorpusPanel`'s detail renders per expanded-capable paper but only one paper is
expanded at a time via `expandedId`, and collapsed rows have zero layout height —
acceptable. If the executor finds the content is genuinely expensive (it is not, in
either component), the fallback is keeping the conditional and accepting the jump —
but default to always-mounted.

Reduced motion: `motion-reduce:transition-none` drops the height animation; the
content swap becomes instant. The repo's global rule
(`frontend/src/index.css:105-112`) already forces `transition-duration: 0.01ms`
under `prefers-reduced-motion`, so this is belt-and-braces and intent-documenting.

## Repo conventions to follow

- Tailwind CSS v4 with theme tokens in the `@theme` block of
  `frontend/src/index.css`; arbitrary-value classes (`[grid-template-rows:0fr]`,
  `transition-[grid-template-rows]`) are the way to express one-off utilities in
  this stack.
- Conditional class strings in these components already use template literals with
  ternaries (e.g. `CorpusPanel.tsx:292-297` builds classes inline; tag-filter
  buttons toggle style via `activeTag`). Match that style.
- No motion library exists and none may be added.
- `motion-reduce:` variants are Tailwind's built-in reduced-motion idiom — use them
  rather than hand-written media queries.

## Steps

1. `frontend/src/components/Feed/FeedHistory.tsx` — replace the
   `{expanded && (<div className="px-4 pb-3 space-y-1">...</div>)}` conditional
   (lines 40–73) with the always-mounted structure:

   ```tsx
   <div
     className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
       expanded ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'
     }`}
   >
     <div className="overflow-hidden min-h-0">
       <div className="px-4 pb-3 space-y-1">
         {/* existing pastFeeds.map(...) block, unchanged */}
       </div>
     </div>
   </div>
   ```

   The `px-4 pb-3 space-y-1` div keeps its classes and its entire contents; it is
   now always rendered. Do not change the toggle button, `pastFeeds`, or the early
   return `if (pastFeeds.length <= 1) return null` at `FeedHistory.tsx:25`.

2. `frontend/src/components/Sidebar/CorpusPanel.tsx` — same transformation on the
   `{expanded && (<div className="mt-2 pl-0">...</div>)}` block (lines 188–253):

   ```tsx
   <div
     className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
       expanded ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'
     }`}
   >
     <div className="overflow-hidden min-h-0">
       <div className="mt-2 pl-0">
         {/* existing expanded detail: TL;DR, stats, tags, actions — unchanged */}
       </div>
     </div>
   </div>
   ```

   The `mt-2 pl-0` div keeps its classes and its entire contents. Do not change
   the paper button, the chevron, `expandedId`, or `setAddingTag` logic.

3. Verify both files still typecheck — no imports are added or removed.

## Boundaries

- These two components only: `FeedHistory.tsx` and `CorpusPanel.tsx`.
- Do NOT change what renders inside the expanded regions — only the wrapper
  structure and the removal of the `{expanded && ...}` conditional.
- Do NOT touch any other `{expanded && ...}` or disclosure pattern elsewhere in the
  repo.
- Do NOT animate opacity inside the collapsing region — height alone; keep it
  crisp.
- Do NOT add new dependencies or new CSS files.
- If a step doesn't match the code you find (drift since the commit stamp), STOP
  and report instead of improvising.

## Verification

- **Mechanical**: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build` — all must pass.
- **Feel check**: run `cd /projects/ficino/frontend && npm run dev` (app may be
  under base path `/ficino`), then:
  - Feed: click "N past feeds" — the list unfolds over 200ms and the ComposeBox /
    feed below glide down with it instead of jumping. Click again — it folds back
    up smoothly. Spam-click the toggle: the transition retargets mid-flight (CSS
    transition), never snaps to zero and restarts.
  - Sidebar: expand a paper in "What's happening" — its TL;DR/stats/tags/actions
    unfold over 200ms; papers below slide down smoothly. Collapse it — same in
    reverse.
  - In DevTools, set animation playback to 10% (Animations panel) and confirm the
    only animated property is `grid-template-rows`.
  - Toggle `prefers-reduced-motion` (Rendering panel) and confirm the fold/unfold
    movement is dropped (swap becomes instant) while all content still appears
    correctly in both states.
  - Collapsed state check: with the region collapsed, inspect the DOM — the content
    is present but contributes zero height (inner `overflow-hidden min-h-0`).
- **Done when**: both toggles animate height over 200ms with the strong ease-out
  curve; nothing below the regions jumps in a single frame; no content or behavior
  inside the regions changed; lint/test/build green.
