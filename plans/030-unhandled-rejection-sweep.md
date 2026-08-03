# Plan 030: Sweep unhandled rejections on user-triggered async actions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/src/components/ReadingLists/ frontend/src/components/Feed/FeedHistory.tsx frontend/src/components/Sidebar/CorpusPanel.tsx frontend/src/App.tsx frontend/src/components/Explore/ExploreView.tsx frontend/src/hooks/useWorkspaces.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/027-bounded-ordering-poll.md, plans/028-single-useuserposts.md, plans/029-exploreview-search-race.md (same files — land those first)
- **Category**: bug
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

A class of user-triggered async actions reject with no catch and no UI feedback: click "delete reading list" while offline and the row just stays, indistinguishable from a UI bug, with an `unhandledrejection` in the console. The repo has a documented convention for exactly this — `App.tsx:577-585` carries a comment mandating `.catch(() => {})` or error surfacing on fire-and-forget actions (read it first and follow its guidance on which treatment each site gets). Individually small; as a class it's the same wedge-forever family R10 wave-4 eliminated in the poll adopters.

## Current state

Verified sites (read each before editing; line numbers are at commit `31fef3a` and may shift ±a few after plans 027–029 land):

1. `frontend/src/components/ReadingLists/ReadingListsView.tsx:44-48` — `handleDelete` awaits `deleteReadingList` with no try/catch. Destructive → surface minimal error.
2. `frontend/src/components/ReadingLists/ReadingListDetail.tsx:132-141` — `handleViewChapter` awaits `getFeed` bare. Navigational → surface minimal error.
3. `frontend/src/components/ReadingLists/ReadingListDetail.tsx:143-157` — `handleMoveUp`/`handleMoveDown` await `reorderReadingList` bare, then `refresh()`. Best-effort → `.catch(() => {})` with comment, OR surface; follow the App.tsx convention comment.
4. `frontend/src/components/Feed/FeedHistory.tsx:50-59` — the load-past-feed onClick has `try/finally` without `catch`:

```tsx
                try {
                  const full = await getFeed(feed.id)
                  onLoadFeed(full)
                } finally {
                  setExpanded(false)
                }
```

A rejected `getFeed` propagates out of the handler. Add `catch` that surfaces a minimal inline error (the history panel has room for a one-line `text-persona-skeptic` message) — do NOT leave it silent: the user clicked to load a feed and nothing happening is the bug.
5. `frontend/src/components/Sidebar/CorpusPanel.tsx:126-129` — `handleRemoveTag` awaits `unassignTag` bare, then `onRefresh()`. Best-effort → `.catch(() => {})` with a one-line comment.
6. `frontend/src/App.tsx:460-464` — `handlePullToRefresh` awaits `getFeed` with no catch:

```tsx
  const handlePullToRefresh = useCallback(async () => {
    if (!feed.feedId) return
    const fresh = await getFeed(feed.feedId)
    feed.loadFeed(fresh as unknown as { id: string; posts: unknown[] })
  }, [feed])
```

PullToRefresh's own `finally` resets the spinner, but the rejection is still unhandled. Best-effort (a failed refresh is obvious: content doesn't change) → `.catch(() => {})` with comment, matching the nearby convention.
7. `frontend/src/components/Explore/ExploreView.tsx:409` region — the delete-workspace path calls `useWorkspaces.remove`, which itself has no catch at `frontend/src/hooks/useWorkspaces.ts:62-65`. Destructive → surface: make `remove` return/throw so the caller can show an error, following however the hook's siblings report failures (read the whole hook first).

Also run `grep -rn "await " frontend/src/components --include="*.tsx" | grep -v "catch\|try\|// "` as a sanity sweep — if it surfaces other user-triggered bare awaits of the same class (event handlers, not effects/polls), list them in your report; fix ONLY if they're the identical pattern in the same files, otherwise leave for a follow-up.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `cd frontend && npm run lint` | 0 errors |
| Unit tests | `cd frontend && npm test` | all pass |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- The seven files listed in the drift check (only the handlers named above)

**Out of scope**:
- Poll/effect async code (usePollTask already handles rejections by design).
- `DangerButton` (plan 024), settings saves (plan 025), ExploreView search (plan 029) — already fixed elsewhere; if a site overlaps, skip it and note.
- Toast infrastructure — inline error text only, using existing patterns in each component (e.g. the `text-persona-skeptic` error-text idiom; PostCard's `showToast` if the component already has an equivalent).

## Git workflow

- Branch: `advisor/030-unhandled-rejection-sweep` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(frontend): catch unhandled rejections on user-triggered actions`.

## Steps

### Step 1: Read the convention

Read `App.tsx:577-585` and the DangerButton/post-024 pattern. Decide per site: surface (destructive/navigational: sites 1, 2, 4, 7) vs `.catch(() => {})` with a one-line comment (best-effort: sites 3, 5, 6). Where you deviate from this mapping, note why in the report.

### Step 2: Apply the fixes site by site

Keep each diff minimal — a catch clause or a small error-state + inline message in the component's existing style. For the surfacing sites, a tiny bit of local state (`const [actionError, setActionError] = useState<string | null>(null)`) rendered as one line of error text is the pattern; clear it on retry.

**Verify** after each file: `npm run lint` → 0 errors.

### Step 3: Gates

**Verify**: `npm test` → all pass; `npm run build` → exit 0.

## Test plan

- No new unit tests (handler wiring; repo has no component-test layer — plan 035). Gates are lint/build plus reading the final handlers.
- The sanity grep from "Current state" must come back clean for the named sites.

## Done criteria

- [ ] All 7 named sites handle rejection (catch or surfaced error)
- [ ] `npm run lint` 0 errors, `npm test` all pass, `npm run build` exit 0
- [ ] The sanity grep shows no remaining bare awaits in the named handlers
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- A named site has drifted or was already fixed by plans 024–029 (skip it, note it).
- `useWorkspaces.remove` has consumers beyond ExploreView that would be affected by a signature change — report the consumer list before changing the hook.
- The App.tsx convention comment (577-585) doesn't exist — report what the current convention documentation is.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- The convention ("fire-and-forget gets `.catch(() => {})` + comment; destructive/navigational gets surfaced error") should be enforced in review on any new event handler. Plan 031's AGENTS.md records it — keep the two consistent.
- The sanity grep is worth re-running periodically; consider it the cheap lint for this class until an eslint rule exists.
