# Implementation plans

Two campaigns live here, numbered monotonically: 001–014 from the `improve-animations` audit (all DONE), 015–037 from the `improve` full-codebase audit. Each plan is fully self-contained — an executor with zero context can run it standalone.

---

# Campaign 2: codebase improvement plans (015–037)

Written against commit `31fef3a` by the `improve` audit on 2026-08-03. Status values: TODO | IN PROGRESS | DONE | BLOCKED (reason) | REJECTED (reason).

| # | Title | Category | Priority | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 015 | Rate-limit the audio and podcast dispatch endpoints | security | P1 | S | — | DONE |
| 016 | Disable interactive API docs outside development | security | P1 | S | — | DONE |
| 017 | Make propose_ordering's persist atomic and retryable | bug | P1 | S | — | DONE |
| 018 | Make fresh generate_feed idempotent under hard-kill redelivery | bug | P1 | S | — | DONE |
| 019 | Re-sign figure URLs on read instead of persisting 30-day bearer tokens | security | P2 | M | — | DONE |
| 020 | Serve security headers from nginx on the SPA surface | security | P2 | S | — | DONE |
| 021 | Run api and worker containers as a non-root user | security | P2 | S–M | — | DONE |
| 022 | Make init.sql the actual full schema for fresh self-host installs | bug | P2 | M | — | DONE |
| 023 | Lock Python dependencies and pin CI tooling | tech-debt | P2 | S–M | 021 | DONE |
| 024 | DangerButton surfaces failure instead of wedging | bug | P1 | S | — | DONE |
| 025 | Surface settings save failures (stop the optimistic ApiKeyInput check) | bug | P1 | S | 024 | DONE |
| 026 | Debounce settings slider writes and apply responses in order | perf | P1 | S | 025 | DONE |
| 027 | Bound the ReadingListDetail AI-ordering poll | bug | P1 | S | — | DONE |
| 028 | Mount useUserPosts once and pass it down to UserProfile | perf | P1 | S | — | DONE |
| 029 | Fix the ExploreView search stale-response race | bug | P1 | S | — | DONE |
| 030 | Sweep unhandled rejections on user-triggered async actions | bug | P1 | S | 027, 028, 029 | DONE |
| 031 | Add a root AGENTS.md for agent-driven development | dx | P2 | S | 022, 023 | DONE |
| 032 | Document the figure-detection model env vars in .env.example | docs | P3 | S | — | DONE |
| 033 | Correct the Marker extraction docs drift | docs | P3 | S | — | DONE |
| 034 | Fix the stale docs cluster | docs | P2 | S | 031, 032 | DONE |
| 035 | Add a component-test layer for the highest-churn frontend files | tests | P3 | L | 024, 028 | DONE |
| 036 | Replace data-dependent e2e skips with explicit fixtures | tests | P3 | M | — | DONE |
| 037 | Add a CI gate for the Playwright e2e suite | tests | P3 | M–L | 036, 022 | TODO |

## Execution order & dependencies (campaign 2)

- **Frontend quick wins (disjoint files, any order):** 024, 027, 028, 029. Then the chain: **025 → 026** (same file, useSettings.ts), then **030** (touches the 027/028/029 files).
- **Backend (disjoint files, any order):** 015, 016, 017, 018, 019. All need the docker stack up for pytest.
- **Structural:** 020 (nginx), 021 (Dockerfiles), 022 (schema) — any order; then **023** (Dockerfiles again, after 021), then **031** (documents post-022/023 truth).
- **Docs:** 032, 033 any order; **034** after 031 + 032.
- **Test infra:** 035 after 024 + 028; **036** standalone; **037** after 036 + 022.

## Verification gates (campaign 2)

- Frontend: `cd frontend && npm run lint && npm test && npm run build`.
- Backend: `docker compose up -d`, then `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` (same for `ficino-worker`); lint `ruff check api/ worker/ shared/`.
- e2e: `npx playwright test --project=desktop` (needs the dev stack at `http://localhost:3000/ficino`; hits a shared dev DB).

## Findings considered and rejected (campaign 2 audit)

- `ws@8.20.0` npm high via `@supabase/realtime-js` — not reachable runtime code (auth-only supabase usage, browser native WebSocket, no Node `ws` shipped).
- Task-status endpoints without task-ownership checks — documented in-code decision (unguessable ids, auth-gated).
- CSRF skipped for the supabase provider — documented, structurally sound (Bearer token never auto-attached).
- Default Postgres/Redis credentials in docker-compose.yml — no published ports, private bridge network, documented in-line.
- Basic-auth cookie attributes, JWT algorithm handling (JWKS/HS256 split), SQL f-strings (constants only), logout IndexedDB wipe — all verified correct at HEAD; not findings.
- Feed list payload (`list_feeds` streaming full posts) — already fixed pre-audit (`summary=true` at `api/routers/feed.py:447-485`); verified, no finding.
- LLM prompt-injection — explicit, settled scope exclusion of prior review rounds.

## Direction findings (campaign 2 — options for the maintainer, not yet planned)

- **Custom personas** — FEATURES.md "Next Up", designed and ready: one INSERT to `personas` + a Settings form.
- **Markdown feed export** — FEATURES.md spec's the 80/20; data all lives in `feeds.posts` JSONB; near-pure-frontend.
- **Mobile navigation decision** (R10.5 deferral #9) — Settings/Reading Lists unreachable on mobile viewports; blocks the keyboard-shortcuts a11y toggle and currently skips e2e specs. Product decision needed.
- **Group-chat error recovery** (R10.5 deferral #8) — failed group chats are a one-way dead end: no regeneration, no delete, no error detail.

---

# Campaign 1: animation improvement plans (001–014)

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
