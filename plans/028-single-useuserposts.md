# Plan 028: Mount useUserPosts once and pass it down to UserProfile

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/src/App.tsx frontend/src/components/Personas/UserProfile.tsx frontend/src/hooks/useUserPosts.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

`useUserPosts` is instantiated twice: once at app level (`App.tsx:393`) and again inside `UserProfile` (`UserProfile.tsx:14`). Each instance runs its own `listUserPosts` fetch plus the 3s pending-poll and its own IndexedDB write-through. Whenever the profile view is open while any post is pending, `GET /user-posts` fires twice every 3s and the `userPosts` IDB store is written twice per tick — pure duplicate work, plus two sources of truth that can transiently disagree.

## Current state

- `frontend/src/App.tsx:390-396` — app-level hooks:

```tsx
  const feed = useFeed(ws.activeId)
  const bm = useBookmarks()
  const notes = useAnnotations()
  const userPosts = useUserPosts(ws.activeId)
  const appSettings = useSettings()
  const alertsHook = useAlerts()
```

- `frontend/src/components/Personas/UserProfile.tsx:13-15`:

```tsx
export function UserProfile({ workspaceId, displayName, handle, onBack, onPersonaClick }: UserProfileProps) {
  const { posts, refresh } = useUserPosts(workspaceId)
```

- Find where App renders `<UserProfile` (`grep -n "UserProfile" frontend/src/App.tsx`) — read the surrounding props to see what's already drilled.
- `frontend/src/hooks/useUserPosts.ts` — read it before editing to confirm exactly what it returns (posts, refresh, anything else UserProfile uses) and what the polling/IDB-write lifecycle is (the app-level instance must remain the single writer).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `cd frontend && npm run lint` | 0 errors |
| Unit tests | `cd frontend && npm test` | all pass |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- `frontend/src/App.tsx` — pass the app-level `userPosts` result into UserProfile
- `frontend/src/components/Personas/UserProfile.tsx` — accept posts/refresh via props; delete its hook call

**Out of scope**:
- `frontend/src/hooks/useUserPosts.ts` — the hook itself is correct; the bug is double instantiation.
- Any other view — grep first, but at plan time `UserProfile` is the only second instantiation; if you find another, STOP and report rather than expanding scope.
- The `workspaceId` prop UserProfile already receives (may become unused after the change — remove it from the destructure ONLY if truly unused afterward; keep the interface otherwise stable).

## Git workflow

- Branch: `advisor/028-single-useuserposts` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `perf(frontend): mount useUserPosts once and pass down to UserProfile`.

## Steps

### Step 1: Inventory

`grep -rn "useUserPosts" frontend/src/` → confirm exactly two call sites (App, UserProfile). Read `useUserPosts.ts` and note its full return shape. If there are more than two call sites, STOP.

### Step 2: Prop-drill

- In `UserProfile.tsx`: add `posts` and `refresh` to `UserProfileProps` (types matching the hook's return — import the post type from wherever `useUserPosts` gets it), replace the hook call with the props. Keep the prop names aligned with how App names them on the `userPosts` object.
- In `App.tsx`: pass `posts={userPosts.posts}` and `refresh={userPosts.refresh}` (or the object itself if the shape lines up — prefer explicit props) to `<UserProfile`.
- If `workspaceId` is now unused inside UserProfile, remove it from the destructure and the interface, and drop it at the render site — but ONLY if nothing else in the component uses it.

**Verify**: `npm run lint` → 0 errors; `npm run build` → exit 0 (TS catches any missed usage).

### Step 3: Behavioral check

Read the final `UserProfile` top-to-bottom: every place it previously used `posts`/`refresh` from its own hook must now use the props. Confirm no other hook in UserProfile depended on the removed instantiation (e.g. an effect keyed off the hook's internal state).

**Verify**: `npm test` → all pass.

## Test plan

- No new unit tests (the change is prop-plumbing; TS + lint + build are the gates, and the repo has no component-test layer — plan 035 adds one).
- Manual sanity (if the dev stack is up at http://localhost:3000/ficino): open the profile view with a pending post and confirm in DevTools Network that `/user-posts` fires once per poll tick, not twice. If the stack isn't up, note that in the report.

## Done criteria

- [ ] `grep -rn "useUserPosts(" frontend/src/` → exactly 1 call site (App.tsx)
- [ ] `npm run lint` 0 errors, `npm test` all pass, `npm run build` exit 0
- [ ] UserProfile renders identically (props supply the same data the hook did)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- More than two `useUserPosts` call sites exist.
- UserProfile uses parts of the hook's return that App's instance doesn't expose or that are keyed to a different workspace id than `ws.activeId`.
- The App render site for UserProfile is conditionally mounted in a way that makes prop-drilling awkward (e.g. it's rendered from a deep child, not App) — report the actual render path.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- The single-instantiation rule for data hooks with polls/IDB writes is now explicit: new views needing user posts take them from App's instance via props/context, never a second `useUserPosts`.
- If prop-drilling through App becomes unwieldy for a future deep view, the right move is a small context provider around the existing single instance — not re-instantiation.
