# Plan 027: Bound the ReadingListDetail AI-ordering poll

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/src/components/ReadingLists/ frontend/src/hooks/usePollTask.ts`
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

The reading-list detail view polls `GET /reading-lists/{id}` every 3s while waiting for AI ordering rationale, with no bound of any kind: `usePollTask`'s `maxAttempts` only counts consecutive REJECTIONS, and a healthy 200-without-rationale resets the counter. If the ordering task faults server-side before writing rationale (worker OOM, LLM failure), the open view polls forever — an unbounded request stream plus a spinner ("The Archivist is analyzing...") that never resolves and never errors. The repo already solved this exact class once: `GroupChatView`'s generating-streak bound (commit `bb66223`) — this plan ports that pattern.

## Current state

- `frontend/src/components/ReadingLists/ReadingListDetail.tsx:67-79`:

```tsx
  useEffect(() => {
    if (orderingReady || !list) return
    const controller = poll<ReadingListDetailType>({
      fn: () => getReadingList(listId),
      isDone: (data) => data.papers.some(p => p.rationale),
      onDone: (data) => {
        setList(data)
        setOrderingReady(true)
      },
      intervalMs: 3000,
    })
    return () => controller.stop()
  }, [orderingReady, listId, list, poll])
```

- The exemplar to mirror — `frontend/src/components/Messages/GroupChatView.tsx:70-92`: exported pure helpers with the eslint-disable export comment, a consecutive-streak counter that resets on any non-matching response, and a MAX constant bounding the window:

```tsx
// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing (R10 wave-5 follow-up); not a component
export function nextGeneratingStreak(prevStreak: number, data: GroupChat): number {
  return data.status === 'generating' ? prevStreak + 1 : 0
}

// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing (R10 wave-5 follow-up); not a component
export function isGeneratingStreakExhausted(streak: number): boolean {
  return streak >= SYNTH_RETRY_MAX_ATTEMPTS
}
```

- Read how GroupChatView wires the streak into its `poll` call (onDone/onError/streak state) before writing Step 2 — mimic that wiring shape.
- `usePollTask` (`frontend/src/hooks/usePollTask.ts`) is correct as-is; the bound belongs at the call site, NOT in the shared hook (other call sites deliberately poll unbounded — do not change the hook).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `cd frontend && npm run lint` | 0 errors |
| Unit tests | `cd frontend && npm test` | all pass |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- `frontend/src/components/ReadingLists/ReadingListDetail.tsx`
- `frontend/src/components/ReadingLists/ReadingListDetail.test.ts` (create, or wherever the GroupChatView helper tests live — find with `grep -rln "nextGeneratingStreak" frontend/src/` and put the new tests alongside that file's convention)

**Out of scope**:
- `frontend/src/hooks/usePollTask.ts` — deliberately unbounded by default; do not add a default maxAttempts.
- The worker ordering task itself (plan 017 covers its persistence/atomicity).
- The chapter-generation poll in the same file (lines 93-126) — it's already bounded by terminal task states (`complete`/`error`).

## Git workflow

- Branch: `advisor/027-bounded-ordering-poll` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(frontend): bound the reading-list ordering poll`.

## Steps

### Step 1: Exported pure helpers

In `ReadingListDetail.tsx`, mirroring the GroupChatView exemplar exactly (comment style, eslint-disable rationale):

```tsx
const ORDERING_POLL_MAX_TICKS = 40  // 40 × 3s = 2 min — mirrors GroupChatView's bounded window

// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing; not a component
export function hasOrderingRationale(data: ReadingListDetailType): boolean {
  return data.papers.some(p => p.rationale)
}

// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing; not a component
export function nextOrderingStreak(prevStreak: number, data: ReadingListDetailType): number {
  return hasOrderingRationale(data) ? 0 : prevStreak + 1
}

// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing; not a component
export function isOrderingStreakExhausted(streak: number): boolean {
  return streak >= ORDERING_POLL_MAX_TICKS
}
```

(If the rationale check semantics make `nextOrderingStreak` redundant with the poll's own isDone, keep the streak counting "no rationale yet" responses as written — the poll stops via isDone on success; the streak bounds the failure mode.)

### Step 2: Wire the bound into the poll

- Add `const [orderingFailed, setOrderingFailed] = useState(false)` and a `streakRef = useRef(0)`.
- In the poll's `fn` wrapper (or a response observer — mirror exactly how GroupChatView threads its streak through its poll), increment `streakRef.current = nextOrderingStreak(streakRef.current, data)` on each response; when `isOrderingStreakExhausted`, stop the controller and `setOrderingFailed(true)`.
- In the "Archivist is analyzing" UI region (find where `orderingReady` gates the spinner), render on `orderingFailed`: a short message ("Ordering is taking longer than expected — the analysis may have failed.") plus a Retry button that resets `streakRef.current = 0`, `setOrderingFailed(false)`, and re-arms the effect (flipping a state the effect depends on, or recalling the same setup — keep it simple and match the file's style).

**Verify**: `npm run lint` → 0 errors; `npm run build` → exit 0.

### Step 3: Unit tests

New test file (location per the Scope note): the three helpers — rationale present/absent, streak increment/reset, exhaustion at exactly 40. Model on the GroupChatView helper tests (find them: `grep -rln "nextGeneratingStreak\|isGroupChatDone" frontend/src/**/*.test.*`).

**Verify**: `npm test` → all pass including new cases.

## Test plan

Covered in Step 3. Structural pattern: the GroupChatView helper tests.

## Done criteria

- [ ] `npm run lint` 0 errors, `npm test` all pass, `npm run build` exit 0
- [ ] The ordering poll can no longer run unbounded (read the final wiring)
- [ ] `ORDERING_POLL_MAX_TICKS` documented with the 2-minute rationale
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The poll block has drifted from the excerpt, or GroupChatView's streak wiring doesn't exist as described.
- The "Archivist is analyzing" UI isn't gated the way Step 2 assumes — report the actual render structure.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- If the ordering task's realistic duration ever exceeds ~2 min (larger reading lists), raise `ORDERING_POLL_MAX_TICKS` with it — the constant is the single knob.
- The Retry path re-enters the same effect; a reviewer should confirm no duplicate poll can be started by rapid Retry clicks (the effect's `orderingReady || !list` guard plus controller cleanup should cover it — verify in the diff).
