# Plan 029: Fix the ExploreView search stale-response race

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/src/components/Explore/ExploreView.tsx`
> If the in-scope file changed since this plan was written, compare the
> "Current state" excerpt against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

ExploreView's search debounces 300ms then fires `searchCorpus`, but applies every response unconditionally: a slow response for query A resolving after query B's response overwrites `results` while the input shows B — the dropdown shows matches for a query the user has already typed past, which reads as a search bug. Separately, the debounce timer is never cleared on unmount, so a pending fire can setState after the view is gone (benign in React 18+, but the stale-overwrite is user-visible and real).

## Current state

- `frontend/src/components/Explore/ExploreView.tsx:139-166` — the `SearchBar` component:

```tsx
function SearchBar() {
  const personas = usePersonas()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [searching, setSearching] = useState(false)
  const [focused, setFocused] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!value.trim()) {
      setResults(null)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await searchCorpus(value.trim())
        setResults(data)
      } catch {
        // ignore
      } finally {
        setSearching(false)
      }
    }, 300)
  }
```

- The sequencing exemplar already in the repo: `PostCard.tsx:131` uses a `loadRequestRef` monotonically-increasing request id checked before applying async results — match that pattern (read it first).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `cd frontend && npm run lint` | 0 errors |
| Unit tests | `cd frontend && npm test` | all pass |
| Build | `cd frontend && npm run build` | exit 0 |

## Scope

**In scope**:
- `frontend/src/components/Explore/ExploreView.tsx`

**Out of scope**:
- `searchCorpus` in `frontend/src/lib/api.ts` — the API is fine; the race is client-side application order.
- The `catch { // ignore }` on the search call — a failed search showing nothing is acceptable UX here (transient, user keeps typing); changing it is plan 030's sweep territory, not this one's.
- The workspace-delete flow elsewhere in ExploreView.tsx (plan 030).

## Git workflow

- Branch: `advisor/029-exploreview-search-race` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(frontend): guard ExploreView search against stale responses`.

## Steps

### Step 1: Sequence guard

Add `const searchSeqRef = useRef(0)` to `SearchBar`. In `handleChange`:

- Increment `searchSeqRef.current += 1` and capture `const seq = searchSeqRef.current` BEFORE scheduling the debounce (so clearing the query also invalidates in-flight requests).
- In the debounced callback, after `await searchCorpus(...)`, apply results only when `seq === searchSeqRef.current`; otherwise drop them (a newer query is pending/answered). Apply the same guard to `setSearching(false)` in `finally` (a stale completion must not clear the spinner of the newer in-flight request — only the latest request owns `searching`).

### Step 2: Unmount cleanup

Add:

```tsx
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])
```

(Check whether SearchBar already imports useEffect / has an existing unmount effect to fold this into — read the full component first.)

**Verify**: `npm run lint` → 0 errors; `npm run build` → exit 0; `npm test` → all pass.

## Test plan

- No new unit test (component-internal wiring; the repo has no component-test layer — plan 035 adds one). The gates are lint/build.
- Manual sanity if the dev stack is up: type "transformer" slowly then quickly append "xl" — results must always match the final query. Note in the report whether you could do this.

## Done criteria

- [ ] `npm run lint` 0 errors, `npm test` all pass, `npm run build` exit 0
- [ ] A stale response can no longer overwrite newer results (read the final handler)
- [ ] Debounce timer cleared on unmount
- [ ] Only `ExploreView.tsx` modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- `SearchBar` has drifted from the excerpt (e.g. it already has a sequence guard, or search moved to a hook).
- `PostCard.tsx:131`'s `loadRequestRef` pattern doesn't exist as described — report what the current exemplar is.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- The `searchSeqRef` pattern is now the third instance of request-sequencing in the codebase (PostCard's loadRequestRef, plan 026's settings send counter). If a fourth appears, consider a shared `latestOnly` helper — not worth extracting at three.
- `searching` ownership (only the latest request clears it) is the subtle part of the diff — reviewers should trace a slow-A/fast-B sequence by hand.
