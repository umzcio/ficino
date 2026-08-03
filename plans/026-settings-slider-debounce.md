# Plan 026: Debounce settings slider writes and apply responses in order

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/src/hooks/useSettings.ts frontend/src/components/Settings/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/025-settings-save-failure-signal.md (rewrites `update`'s contract to return boolean — this plan preserves that contract; land 025 first)
- **Category**: perf
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

The Settings sliders (chunk size: step 100 over 200–1600; persona temperature: step 0.1) call `onUpdate` on every input event, and `useSettings().update` issues one `PUT /settings` per call with no debounce and no sequencing — one drag fires ~14 PUTs. Concurrent responses can arrive out of order; applying an EARLIER write's response last snaps the slider back to a stale value while the server holds a different one — visible jitter plus a settings state that disagrees with the server until the next refresh.

## Current state

- `frontend/src/components/_shared/primitives.tsx:162` — Slider fires per input event: `onChange={(e) => onChange(parseFloat(e.target.value))}`.
- `frontend/src/components/Settings/ContentTab.tsx:31,49` and `AITab.tsx:223` — Slider `onChange` → `onUpdate({...})` directly (verified).
- `frontend/src/hooks/useSettings.ts` — post-025 shape: `update` awaits `putSettings(partial)`, applies `setSettings(data)` on success, returns boolean. Every response is applied unconditionally — that unconditional application is what this plan sequences.
- The testable-extraction convention: `usePollTask.ts` exports `startPoll` (framework-free core) so logic is unit-testable with vitest fake timers without React. Follow it.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `cd frontend && npm run lint` | 0 errors |
| Unit tests | `cd frontend && npm test` | all pass |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- `frontend/src/hooks/useSettings.ts`
- `frontend/src/hooks/useSettings.test.ts` (extend the file plan 025 created)

**Out of scope**:
- The Slider primitive and Settings tabs — the fix belongs in the hook so all callers benefit; do not debounce at call sites.
- `refresh` (read path) — fine as is.
- Backend — the API handles concurrent PUTs fine; the bug is client-side write amplification + response ordering.

## Git workflow

- Branch: `advisor/026-settings-slider-debounce` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `perf(frontend): debounce settings writes and apply responses in order`.

## Steps

### Step 1: Extract a framework-free updater

In `useSettings.ts`, export a plain factory (same philosophy as `startPoll`) that owns the debounce + sequencing logic:

```ts
export interface SettingsUpdater {
  update: (partial: Record<string, unknown>) => Promise<boolean>
  flush: () => Promise<boolean>   // immediately send any pending merged partial
  cancel: () => void              // drop pending writes (unmount)
}
```

Behavior contract (implement exactly):

1. `update(partial)` merges `partial` into a pending object and schedules a trailing-edge flush after **400 ms**. Rapid calls coalesce into ONE PUT of the merged partial.
2. Only one PUT is in flight at a time. If `update` is called while a PUT is in flight, the new partial waits; when the in-flight PUT resolves, a follow-up PUT with the accumulated partial fires immediately (no extra 400 ms wait).
3. Response application: `setSettings` is called ONLY with the response of the most recently SENT PUT (a response from PUT_n must never be applied after PUT_{n+1} was sent — track a send counter).
4. Return value: the returned promise resolves with the outcome of the PUT that actually carried that call's partial (for a coalesced call, the merged flush's outcome). Preserve plan 025's boolean contract.
5. `flush()` sends the pending partial immediately (used on blur-critical controls if needed, and by tests). `cancel()` clears the timer and drops pending state.

The hook's `update` delegates to a ref-held `SettingsUpdater`; `useEffect` cleanup calls `cancel()` on unmount.

### Step 2: Unit tests with fake timers

Extend `frontend/src/hooks/useSettings.test.ts` (vitest `vi.useFakeTimers()`; mock `updateSettings` from `../lib/api` as in the existing test):

- 5 rapid `update` calls within 400 ms → exactly 1 PUT, body is the merged partial.
- A call arriving while a PUT is in flight → second PUT fires on resolution of the first (no timer wait).
- Out-of-order responses: force PUT_1 to resolve AFTER PUT_2 (deferred promises) → `setSettings`-equivalent (inject an `apply` callback into the factory for testability) receives ONLY PUT_2's response.
- `flush()` sends immediately; `cancel()` after updates → no PUT.
- Boolean contract: failed flush resolves `false` for all coalesced callers.

**Verify**: `npm test` → all pass including these.

### Step 3: Gates

**Verify**: `npm run lint` 0 errors; `npm run build` exit 0.

## Test plan

Covered in Step 2. Structural pattern: `usePollTask`'s `startPoll` test (`frontend/src/hooks/usePollTask.test.ts` or wherever it lives — find with `ls frontend/src/hooks/*.test.*`).

## Done criteria

- [ ] `npm run lint` 0 errors, `npm test` all pass, `npm run build` exit 0
- [ ] Fake-timer tests prove: coalescing, in-flight queuing, latest-only application, flush, cancel, boolean contract
- [ ] Slider components and Settings tabs are unmodified (`git diff --stat frontend/src/components/`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 025 hasn't landed (no boolean contract / no `putSettings`) — land 025 first or report.
- Some caller depends on synchronous write-through (e.g. reads `settings` immediately after `update` expecting the server echo) — report the caller; do not special-case silently.
- The 400 ms trailing debounce breaks a control whose write must be immediate (none known — report if found).
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- 400 ms matches common settings-debounce practice; if users report laggy feel on toggles/selects (which also flow through `update`), the knob is in one place.
- Watch for: controls that navigate away immediately after change (unmount `cancel()` drops the pending write by design — if that bites a real flow, the fix is an explicit `flush()` call before navigation, not removing the cancel).
- A reviewer should scrutinize the send-counter logic and the promise-resolution fan-out for coalesced calls — those are the two places subtle bugs live.
