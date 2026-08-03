# Animation improvement plans

Written against commit `18cc791` by the `improve-animations` audit. Each plan is fully self-contained — an executor with zero context can run it standalone. Execute in any order unless a dependency is noted below.

| # | Title | Severity | Status |
| --- | --- | --- | --- |
| 001 | Drive PostCard action-button hover in CSS, add press feedback | HIGH | DONE |
| 002 | Add velocity-based flick commit to SwipeToAct | HIGH | DONE |
| 003 | Add velocity-based flick to SwipeBackEdge | MEDIUM | DONE |
| 004 | Replace sheet/drawer keyframes with interruptible transitions and real exits | MEDIUM | DONE |
| 005 | Keep opacity/color feedback under prefers-reduced-motion | MEDIUM | DONE |
| 006 | Replace transition-all with explicit transition properties | MEDIUM | DONE |
| 007 | Gate Listen transport hover-grow and add press feedback | MEDIUM | DONE |
| 008 | Move Toggle knob with transform instead of left | MEDIUM | DONE |
| 009 | Fix pull-to-refresh layout thrash and reduced-motion bypass | MEDIUM | DONE |
| 010 | Introduce motion easing tokens and consolidate duplicates | LOW | DONE |
| 011 | Fade loaded content in after loading states | HIGH | DONE |
| 012 | Fade tab panel content on tab switch | MEDIUM | DONE |
| 013 | Animate expand/collapse height with grid-rows | MEDIUM | DONE |
| 014 | Entrance motion for offline success, install banner, and first app paint | LOW | DONE |

## Recommended execution order

1. **001** — highest-traffic UI in the app (feed action buttons); also fixes a live rendering bug (the tinted hover/active background never paints today).
2. **002** — feel-breaking: flicks ignored on the primary feed gesture.
3. **003** — same velocity pattern as 002, smaller surface; do it while the pattern is fresh.
4. **010** — LOW severity but cheap and foundational; landing the tokens early lets every later plan reference them (each plan has a literal fallback, so this is soft).
5. **004** — sheet/drawer transitions; migrates to `--ease-drawer` if 010 already ran.
6. **005** — reduced-motion rescope; foundational for every plan that adds motion after it.
7. **009** — pull-to-refresh (uses the reduced-motion hook it introduces; pairs naturally with 005).
8. **006**, **008**, **007** — small mechanical cleanups; batch them.
9. **011** — highest-leverage additive plan; one FadeIn primitive fixes the loading blink across ~7 views.
10. **012** — depends on 011's FadeIn.
11. **013** — independent; expand/collapse grid-rows.
12. **014** — depends on 011 for the AuthGate step; the DownloadProgress/InstallPrompt sub-fixes are standalone.

## Dependencies

- **012 and 014 depend on 011** (`frontend/src/components/_shared/FadeIn.tsx`). Those plans instruct the executor to stop and report if FadeIn is absent — do not reimplement it.
- **010 is a soft dependency of everything**: plans 004, 009, 011, 013, 014 inline exact cubic-bezier values and note "use the token if plan 010 has landed." Plan 010 greps and migrates whatever exists at execution time (it handles both the pre-004 keyframes form and the post-004 transition form of the sheet/drawer).
- **006 excludes** the `transition-all` sites owned by 001 (`PostCard.tsx` ActionBtn), 008 (`primitives.tsx` Toggle knob), and 014 (`DownloadProgress.tsx:50`) — stated in its Boundaries.
- **005 and 009/013/014**: those plans include their own `motion-reduce:` handling, so they land correctly whether 005 runs before or after them.
- All other plans touch disjoint files and are order-independent.

## Verification

Every plan's Mechanical gate: `cd /projects/ficino/frontend && npm run lint && npm test && npm run build` (build runs `tsc -b && vite build`). Every plan also has a feel check — run `npm run dev` (app may be served under base path `/ficino`) and use DevTools' Animations panel at 10% playback plus the Rendering panel's `prefers-reduced-motion` toggle.
