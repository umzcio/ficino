# Plan 025: Surface settings save failures (and stop the optimistic ApiKeyInput check)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/src/hooks/useSettings.ts frontend/src/components/_shared/primitives.tsx frontend/src/components/Settings/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/024-dangerbutton-failure-feedback.md (same file: primitives.tsx — land 024 first to avoid conflicts)
- **Category**: bug
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

Every settings control in the app flows through `useSettings().update`, which swallows PUT failures (`catch { // ignore }`). Worse, `ApiKeyInput.doSave` shows a green "saved" check for ~2s regardless of whether the save succeeded. A failed save (offline, 401 after token expiry, 5xx) leaves the user believing a setting — including an API key — persisted; on reload the value silently reverts. False confidence about whether your API key was saved is the worst version of this bug.

## Current state

- `frontend/src/hooks/useSettings.ts:28-35`:

```ts
  const update = useCallback(async (partial: Record<string, unknown>) => {
    try {
      const data = await updateSettings(partial)
      setSettings(data)
    } catch {
      // ignore
    }
  }, [])
```

- `frontend/src/components/_shared/primitives.tsx:213-219` — the optimistic check:

```tsx
  const doSave = () => {
    if (local !== effectiveValue) {
      onSave(local)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }
```

`ApiKeyInput`'s `onSave` prop is currently typed `(v: string) => void`; consumers wire it to `useSettings().update` (find them: `grep -rn "ApiKeyInput" frontend/src/components/Settings/`).
- `onUpdate` consumers of `update` are spread across `frontend/src/components/Settings/*.tsx` (ContentTab, AITab, AccountTab, etc.) — they pass `(partial) => update(partial)`-style callbacks and currently get no signal back.
- Test conventions: no @testing-library/react in this repo — extract plain exported functions for logic and unit test those (exemplars: `frontend/src/hooks/usePollTask.ts`'s `startPoll` with its `.test.ts`, `GroupChatView.tsx`'s exported pure helpers).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `cd frontend && npm run lint` | 0 errors (1 pre-existing warning ok) |
| Unit tests | `cd frontend && npm test` | all pass |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- `frontend/src/hooks/useSettings.ts`
- `frontend/src/components/_shared/primitives.tsx` (ApiKeyInput only — plan 024 owns DangerButton)
- `frontend/src/components/Settings/*.tsx` — only the call-site signature adaptations (passing/returning promises)
- `frontend/src/hooks/useSettings.test.ts` (create)

**Out of scope**:
- `api/routers/settings.py` — the API already returns errors correctly; the bug is client-side swallowing.
- The slider write amplification (one PUT per drag tick) — that's plan 026, which builds on this plan's `update`. Do not debounce here.
- Toast/notification infrastructure — inline error text only, matching existing patterns.

## Git workflow

- Branch: `advisor/025-settings-save-failure-signal` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(frontend): surface settings save failures`.

## Steps

### Step 1: Make `update` report success

In `useSettings.ts`, extract the PUT into an exported plain function (testable per repo convention) and have `update` return `Promise<boolean>`:

```ts
// Extracted for unit testing (no @testing-library/react in this repo —
// same pattern as usePollTask's startPoll).
export async function putSettings(
  partial: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    return await updateSettings(partial)
  } catch {
    return null
  }
}
```

`update` becomes: `const data = await putSettings(partial); if (data) { setSettings(data); return true } return false`. Keep the `// ignore`-era comment replaced by a real one: failure returns false; callers that care (ApiKeyInput, destructive settings) surface it; fire-and-forget callers may ignore the return.

**Verify**: `cd frontend && npm run lint` → 0 errors (TS: callers ignoring a returned promise/boolean are fine — update returns boolean, not Promise<boolean>-only usage... note: it still returns `Promise<boolean>`; existing `onUpdate(partial)` fire-and-forget call sites remain valid because they never awaited anyway).

### Step 2: ApiKeyInput gates the check on real success

- Retype `onSave` to `(v: string) => void | Promise<boolean | void>`.
- Make `doSave` async: `const ok = await onSave(local)`; show the saved check only when `ok !== false` (a void return = legacy fire-and-forget caller = treat as success to stay backward compatible); when `ok === false`, set a `saveFailed` state instead and render `<span className="text-xs text-persona-skeptic">Save failed</span>` next to the input (clear it on the next keystroke — `onChange` already calls `setLocal`; add `setSaveFailed(false)` there).
- `doClear` (line 221-224) calls `onSave('')` — apply the same handling.

### Step 3: Update the Settings tab call sites

`grep -rn "ApiKeyInput\|onSave=" frontend/src/components/Settings/` — for each ApiKeyInput consumer, make the passed `onSave` return the `update(...)` promise (typically changing `(v) => onUpdate({ anthropic_api_key: v })` to `(v) => onUpdate({ anthropic_api_key: v })` where `onUpdate` now returns `Promise<boolean>` — most sites need no change beyond ensuring the promise is RETURNED, not fired). Read each site; the rule is: the promise returned by `update` must reach ApiKeyInput's `await`.

**Verify**: `npm run lint` → 0 errors; `npm run build` → exit 0.

### Step 4: Unit tests

Create `frontend/src/hooks/useSettings.test.ts` (model on `frontend/src/lib/api.test.ts`; mock `../lib/api`'s `updateSettings` the same way that file mocks api functions):

- `putSettings` returns the server data on success.
- returns `null` on rejection (contained — does not throw).

**Verify**: `npm test` → all pass including new cases.

## Test plan

Covered in Step 4. Structural pattern: `frontend/src/lib/api.test.ts`.

## Done criteria

- [ ] `npm run lint` 0 errors, `npm test` all pass, `npm run build` exit 0
- [ ] `grep -n "catch {" frontend/src/hooks/useSettings.ts` — the old `// ignore` block is gone from `update`
- [ ] ApiKeyInput shows its saved check only after a confirmed successful save
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- `useSettings` or `ApiKeyInput` has drifted from the excerpts.
- Some `onSave`/`onUpdate` consumer relies on `update` being fire-and-forget in a way returning a promise breaks (report the site).
- Plan 024 hasn't landed and primitives.tsx doesn't match expectations — land 024 first or report.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- The `update → boolean` contract is now the settings-write convention; new settings controls that need confirmation should await it.
- Plan 026 (slider debounce) will change `update`'s internals — its sequencing logic must preserve the boolean contract this plan adds (a debounced write reports the LAST flush's outcome).
- Surfacing failures for the OTHER settings controls (toggles, selects) beyond ApiKeyInput: deliberately out of scope — the silent-failure cost is highest for API keys; the rest revert visibly on reload.
