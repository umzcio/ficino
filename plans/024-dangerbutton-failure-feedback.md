# Plan 024: DangerButton surfaces failure instead of wedging

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/src/components/_shared/primitives.tsx frontend/src/components/Settings/StorageTab.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

`DangerButton` guards the most destructive actions in the app (Clear All Feeds, Delete All Papers, Delete Everything — `StorageTab.tsx:104-120`). Its confirm handler awaits `onConfirm()` with no try/catch, and every consumer passes an async function that throws `ApiError` on any non-2xx. A failed destructive action (offline, 5xx) produces an unhandled promise rejection and leaves the button stuck in the Confirm/Cancel state with zero feedback — the user cannot tell whether "Delete Everything" ran. This is the exact "wedged forever" class R10 wave-4 systematically fixed in the poll adopters; this shared primitive was missed.

## Current state

- `frontend/src/components/_shared/primitives.tsx:272-301`:

```tsx
export function DangerButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState(false)

  if (done) { ... <Check /> Done ... }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={async () => { await onConfirm(); setDone(true); setConfirming(false) }}
          ...
        >Confirm</button>
        <button onClick={() => setConfirming(false)} ...>Cancel</button>
      </div>
    )
  }
  ...
```

- Consumers (all pass throwing async functions): `frontend/src/components/Settings/StorageTab.tsx:104,108,112,116,120` — `clearAllFeeds`, `clearAllSummaries`, `clearAllUserPosts`, `clearAllPapers`, `clearEverything`.
- Test-infrastructure reality (do not fight it): this repo has NO @testing-library/react. The convention for testable logic in components is extracting a plain exported function with an `// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing` comment — see `frontend/src/components/Messages/GroupChatView.tsx` (`isGroupChatDone`, `nextGeneratingStreak`) and `frontend/src/hooks/usePollTask.ts` (`startPoll`). Existing vitest files: `ls frontend/src/**/*.test.*` (e.g. `frontend/src/lib/api.test.ts`, `PostCard.compare.test.ts`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `cd frontend && npm run lint` | exit 0 (the 1 pre-existing MobileDrawer warning is acceptable; 0 errors) |
| Unit tests | `cd frontend && npm test` | all pass (64 existing + new) |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- `frontend/src/components/_shared/primitives.tsx`
- `frontend/src/components/_shared/primitives.test.ts` (create, or add to an existing primitives test file if one exists)

**Out of scope**:
- `StorageTab.tsx` and the hooks it calls — the fix belongs in the primitive so all five consumers benefit at once.
- Any styling beyond the minimal error text (match existing `text-persona-skeptic` usage for error-colored text).
- `ApiKeyInput` in the same file — its optimistic-save issue is plan 025; do not touch it here even though it's nearby.

## Git workflow

- Branch: `advisor/024-dangerbutton-failure-feedback` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(frontend): surface DangerButton confirm failures instead of wedging`.

## Steps

### Step 1: Extract the confirm runner as a testable plain function

In `primitives.tsx`, directly above `DangerButton`, add (with the eslint-disable export comment per the repo convention):

```tsx
// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing; not a component
export async function runDangerConfirm(
  onConfirm: () => void | Promise<void>,
): Promise<'done' | 'failed'> {
  try {
    await onConfirm()
    return 'done'
  } catch {
    return 'failed'
  }
}
```

### Step 2: Rewire DangerButton

- Widen the prop type: `onConfirm: () => void | Promise<void>` (all five consumers already pass async functions; today they rely on the unsound `() => void` signature).
- Add `const [failed, setFailed] = useState(false)`.
- Replace the confirm onClick with:

```tsx
          onClick={async () => {
            const outcome = await runDangerConfirm(onConfirm)
            if (outcome === 'done') { setDone(true); setConfirming(false) }
            else setFailed(true)
          }}
```

- In the confirming branch, when `failed` is true, render an inline error next to the buttons: `<span className="text-xs text-persona-skeptic">Failed — try again</span>` (match the file's existing text-size/color idiom). Clicking Confirm retries (it just re-runs); clicking Cancel resets `failed` too — update the Cancel onClick to `() => { setConfirming(false); setFailed(false) }`.
- Add a one-line comment above the component noting the failure path is deliberate (R10 wave-4 fixed this class in the poll adopters; this primitive was missed).

**Verify**: `cd frontend && npm run lint` → 0 errors; `npm run build` → exit 0.

### Step 3: Unit test

Create `frontend/src/components/_shared/primitives.test.ts` (model imports/style on `frontend/src/lib/api.test.ts` — read it first). Cases:

- `runDangerConfirm` returns `'done'` when onConfirm resolves.
- returns `'failed'` when onConfirm rejects (and does NOT throw — the rejection is contained).
- returns `'done'` when onConfirm is a plain sync function (the `void` arm of the widened type).

**Verify**: `cd frontend && npm test` → all pass, including the 3 new cases.

## Test plan

Covered in Step 3. Structural pattern: `frontend/src/lib/api.test.ts`.

## Done criteria

- [ ] `npm run lint` 0 errors, `npm test` all pass, `npm run build` exit 0
- [ ] `grep -n "runDangerConfirm" frontend/src/components/_shared/primitives.tsx` → definition + use
- [ ] No unhandled rejection path remains in DangerButton (read the final component)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The component has drifted from the excerpt (e.g. it already handles errors).
- A consumer passes an `onConfirm` whose failure must NOT be caught (none known — report if you find one).
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- Any NEW destructive action should use `DangerButton` and get this behavior for free; reviewers should reject new hand-rolled confirm flows.
- `done` currently shows a permanent "Done" check — the row it sits in typically disappears on refresh. Leaving that as is (deliberate; out of scope).
