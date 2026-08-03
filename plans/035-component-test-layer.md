# Plan 035: Add a component-test layer for the highest-churn frontend files

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/package.json frontend/vitest.config.ts frontend/src/components/Feed/PostCard.tsx frontend/src/components/_shared/primitives.tsx`
> If any in-scope file changed since this plan was written, compare against
> the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: LOW
- **Depends on**: plans/024-dangerbutton-failure-feedback.md (its DangerButton behavior becomes a render-test target), plans/028-single-useuserposts.md (PostCard test fixtures must match the post-028 prop shapes)
- **Category**: tests
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

The highest-churn frontend files — `App.tsx` (46 commits), `PostCard.tsx` (34), `api.ts` (33), `PersonaProfile.tsx` (22), `ListenView.tsx` (19) — have zero unit coverage. The 9 existing vitest files cover lib utilities and extracted pure helpers only; a PostCard regression is caught (if at all) by the manual, data-dependent e2e suite or in production. The repo deliberately avoided a component-test library (multiple code comments cite its absence), which forced the "extract pure functions" pattern — good discipline, but it leaves render logic (five post-type variants, action menus, error states) untestable. This plan adds the missing layer, narrowly scoped: PostCard's five post types + DangerButton's failure flow as the proving pair.

## Current state

- `frontend/vitest.config.ts:7` — `environment: 'node'` (no DOM). Existing tests are all node-environment pure-function tests (`frontend/src/lib/*.test.ts`, `usePollTask.test.ts`, `PostCard.compare.test.ts`, etc. — read 1-2 for style).
- `frontend/package.json` — no @testing-library/* and no jsdom. React 19.2, vitest 4.1.9. Dev-deps install via `npm install -D` (npm, package-lock present).
- `frontend/src/components/Feed/PostCard.tsx` — read its props and the five post-type render branches (standalone, thread, quote, reply, figure) before writing fixtures. `PostCard.compare.test.ts` already constructs post fixtures for the memo comparator — reuse its fixture shapes.
- `frontend/src/components/_shared/primitives.tsx` — post-024 `DangerButton` with its failed-confirm state.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `cd frontend && npm install -D @testing-library/react@^16 @testing-library/dom jsdom` | exit 0 (use `npm install -D` exactly; do not add jest-dom unless assertions need it) |
| Unit tests | `cd frontend && npm test` | all pass (existing node-env tests must be unaffected) |
| Lint | `cd frontend && npm run lint` | 0 errors |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- `frontend/package.json` + `frontend/package-lock.json` (new dev deps)
- `frontend/vitest.config.ts` (environment routing only)
- `frontend/src/components/Feed/PostCard.render.test.tsx` (create)
- `frontend/src/components/_shared/primitives.test.tsx` (create — DangerButton render tests; note the `.tsx`)

**Out of scope**:
- App.tsx / PersonaProfile / ListenView tests — proving the layer on PostCard + DangerButton is the scope; broader coverage is follow-up once the pattern exists.
- Rewriting existing pure-helper tests into render tests — they stay as they are.
- `frontend/src/components/_shared/primitives.test.ts` (plan 024's node-env test for `runDangerConfirm`) — keep it; the new `.tsx` file is separate.
- Mocking IndexedDB/offline-cache beyond what PostCard's imports require — if PostCard transitively imports `idb`, mock the module boundary (see Step 2) rather than standing up fake-indexeddb.

## Git workflow

- Branch: `advisor/035-component-test-layer` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): `test(frontend): add component-test layer (PostCard, DangerButton)`.

## Steps

### Step 1: Install and configure

- `npm install -D @testing-library/react@^16 @testing-library/dom jsdom` (v16 supports React 19).
- In `frontend/vitest.config.ts`, keep `environment: 'node'` as the default and route only component tests to jsdom — either `environmentMatchGlobs: [['src/**/*.render.test.tsx', 'jsdom'], ['src/components/_shared/primitives.test.tsx', 'jsdom']]` or simply `[['**/*.test.tsx', 'jsdom']]`. Prefer the `*.test.tsx` glob: node stays default for all `.test.ts`, jsdom for `.test.tsx`, no per-file pragma needed.

**Verify**: `npm test` → the 64 existing tests still pass unchanged (node env untouched).

### Step 2: PostCard render tests

Create `frontend/src/components/Feed/PostCard.render.test.tsx`. First read PostCard's imports; `vi.mock` the boundaries that touch network/storage (e.g. `../../lib/api`, `../../lib/offline-cache` — whatever it actually imports; mock at the same module-specifier the component uses). Reuse fixture shapes from `PostCard.compare.test.ts`. Cases (one per post type, asserting what's DISTINCT about that type):

1. Standalone post — renders persona name/handle and content.
2. Thread post — renders the thread expand affordance.
3. Quote post — renders the nested quoted card (avatar/name/handle + quoted content).
4. Reply post — renders the replying-to context.
5. Figure post — renders the figure image/caption region.
6. Error/edge: a post with the minimal required fields renders without throwing.

Assert via accessible queries (`getByRole`/`getByText`) on stable text, not CSS classes. Keep it to what each type uniquely renders — this is characterization, not a pixel spec.

**Verify**: `npm test` → all pass including the 6 new cases.

### Step 3: DangerButton render tests

Create `frontend/src/components/_shared/primitives.test.tsx`:

1. Click label → Confirm/Cancel appear.
2. Click Confirm with resolving `onConfirm` → "Done" appears.
3. Click Confirm with REJECTING `onConfirm` (async fn that throws) → the failure text ("Failed — try again", or whatever plan 024 rendered) appears, no "Done", and no unhandled rejection (the test completes cleanly — vitest fails on unhandled rejections by default; keep that behavior on).

**Verify**: `npm test` → all pass.

### Step 4: Gates

`npm run lint` → 0 errors (test files included); `npm run build` → exit 0 (tests aren't in the build, but confirm).

## Test plan

This plan IS the test plan. Structural patterns: fixtures from `PostCard.compare.test.ts`; mocking style from `frontend/src/lib/api.test.ts`.

## Done criteria

- [ ] `npm test` exits 0: 64 pre-existing node tests + ~9 new render tests
- [ ] `npm run lint` 0 errors; `npm run build` exit 0
- [ ] vitest config routes only `.test.tsx` to jsdom; `.test.ts` stays node
- [ ] Tests assert through accessible queries and real behavior (no `toBeTruthy()`-only smoke)
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- @testing-library/react@16 + React 19 + vitest 4 integration fights (persistent `act` environment errors that config can't resolve) — report the exact errors; do not pin React or downgrade vitest to force it.
- PostCard's import graph pulls in something unmappable in jsdom (e.g. a hard IndexedDB dependency at module scope) — report the import chain; mock only module boundaries, never patch globals.
- Plans 024/028 haven't landed and the target shapes differ — land them first or report.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- New convention after this lands: `.test.ts` = node/pure, `.test.tsx` = jsdom/render. AGENTS.md (plan 031) must be updated to mention the component layer now exists (one line — add it if 031 is already merged; otherwise note the follow-up).
- The `.test.tsx` render layer is additive; the extract-pure-functions pattern remains the first choice for LOGIC. Render tests are for render branches.
- Watch for act() warnings creeping in — treat them as test bugs, not noise to suppress.
