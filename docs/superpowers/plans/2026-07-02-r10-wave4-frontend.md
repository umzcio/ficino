# R10 Wave 4 — Frontend: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the wave-4 slice of `FICINO_REVIEW_R10.md` — frontend shared extractions, React bug + a11y fixes, the group-chat picker modal, Settings/Account wiring — plus the wave-1/-3 carried frontend items, ending with eslint clean and added to CI.

**Architecture:** Shared extractions land first (later tasks adopt them); bugs cluster by feature area; the two feature builds (group-chat modal, Account wiring) come last before the lint sweep. All work in `frontend/src` on branch `r10/wave4-frontend`; zero backend changes (the endpoints all exist).

**Tech Stack:** React 19 + TS + Vite + Tailwind v4 + vitest (infra from wave 1). Suites at start: vitest 3, tsc/build clean, api 186 / worker 33 / shared 33 (untouched this wave). eslint currently has ~21 pre-existing problems — this wave ends at ZERO and adds `npm run lint` to CI.

## Global Constraints

- Resolves: FE-2..9, FE-11..21, DUP-8/9/10/11/19, BP-9/11; features FE-4 (group-chat modal) + Settings/Account wiring (moved from wave 3); carried: useAlerts dismiss catch, PersonaProfile clear-DM 404-as-success, ApiKeyInput "set" sentinel (wave-2 final-review Minor 2), wave-1 lint items. Requirement sources: `review/round10/frontend.md`, `review/round10/duplication.md`, `review/round10/best-practices.md` — every brief cites its findings; READ them before implementing.
- Frontend commands run on the host in `/projects/ficino/frontend` (`npm test`, `npx tsc -b`, `npm run build`, `npx eslint <files>`). The compose frontend container serves BUILT assets — for browser smokes rebuild it (`docker compose build frontend && docker compose up -d frontend`) and browse via `https://localhost/ficino` (host nginx proxy; self-signed cert).
- TDD where testable in vitest (pure helpers, hooks via testing-library if cheap — but do NOT add new heavy test deps beyond `@testing-library/react`+`jsdom` IF a hook genuinely needs it; prefer pure-function extraction first). Visual/interaction fixes are verified by a scripted browser check at the gate.
- ONE FINDING (or one coherent cluster) PER COMMIT; def+use co-located; import/tsc-smoke per commit (`npx tsc -b` is the frontend equivalent of wave-3's import check — run it before EVERY commit).
- Backend files are OUT OF BOUNDS (read-only for verifying contracts).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `r10/wave4-frontend` off main.

---

### Task 1: Branch + shared foundations — timeAgo, AsyncState, Md/primitives promotion

**Files:** Create `frontend/src/lib/timeAgo.ts`, `frontend/src/lib/timeAgo.test.ts`, `frontend/src/components/_shared/AsyncState.tsx`; Move `frontend/src/components/Feed/_shared/Md.tsx` → `frontend/src/components/_shared/Md.tsx` (DUP-19) and `frontend/src/components/Settings/primitives.tsx` → `frontend/src/components/_shared/primitives.tsx` (BP-11 move); update ALL importers of both moved files.

- [ ] Step 1: `git checkout -b r10/wave4-frontend`.
- [ ] Step 2: **DUP-8** — read all six `timeAgo` copies (sites in `review/round10/duplication.md` DUP-8; line numbers may have drifted — find by content). Canonical: the Alerts variant (`just now` + `Nm ago`), parameterized:
```ts
// frontend/src/lib/timeAgo.ts
// One relative-time helper for the whole app (R10 DUP-8 — six drifted
// copies produced 'just now' / '0m ago' / '0m' for the same timestamp).
export function timeAgo(iso: string | Date, opts?: { suffix?: boolean }): string {
  const then = typeof iso === 'string' ? new Date(iso) : iso
  const s = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000))
  const suffix = opts?.suffix === false ? '' : ' ago'
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${suffix}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${suffix}`
  const d = Math.floor(h / 24)
  return `${d}d${suffix}`
}
```
BEFORE finalizing, diff this against the Alerts original — if the original has more branches (weeks, dates), extend to match ITS behavior exactly; the six call sites switch (`Inbox`/`UserPostCard` pass `{suffix: false}` to preserve their current compact rendering — visible output per site must be UNCHANGED except the two review-documented drift bugs: Bookmarks regaining `just now`, Inbox showing `0m` → `just now`; cite those two intended changes). vitest tests: boundaries (59s→just now, 60s→1m, 59m/60m, 23h/24h) and both suffix modes.
- [ ] Step 3: **DUP-9** — `AsyncState.tsx` exporting `Spinner({size?, className?})` (the `Loader2 ... text-gold animate-spin` treatment inside `flex items-center justify-center py-20`) and `EmptyState({icon, title, hint?, children?})` (the `size={48} strokeWidth={1} text-gold/30` + `text-lg font-semibold text-text-mid` structure). Read the 7 scaffold sites (DUP-9's list) first and make the components reproduce the MAJORITY treatment; adopt at all 7 sites (AlertsView's hand-rolled CSS spinner dies). Visual parity is the bar — padding variants become props only if a site genuinely needs it.
- [ ] Step 4: **DUP-19 + BP-11 (move half)** — `git mv` the two files; fix every importer (grep `Feed/_shared/Md` and `Settings/primitives`). NO adoption changes yet (Tasks 5/7 adopt); this step is pure relocation + import updates. `npx tsc -b` proves nothing broke.
- [ ] Step 5: vitest + tsc + build green. Three commits (`refactor(frontend): shared timeAgo (R10 DUP-8)` / `refactor(frontend): shared Spinner/EmptyState (R10 DUP-9)` / `refactor(frontend): promote Md + Settings primitives to _shared (R10 DUP-19, BP-11)`).

---

### Task 2: usePollTask (DUP-11) + adoption incl. FE-6

**Files:** Create `frontend/src/hooks/usePollTask.ts` (+ vitest test); adopt in `hooks/useFeed.ts`, `components/Messages/PaperChat.tsx`, `components/Listen/ListenView.tsx` (both loops), `components/ReadingLists/ReadingListDetail.tsx` (both — this IS the FE-6 fix), `components/Feed/UserPostCard.tsx`, `hooks/useUserPosts.ts`.

The hook (model on the ListenView variant per DUP-11 — read it first; this is the shape, adapt to what the sites actually need):
```ts
// frontend/src/hooks/usePollTask.ts
// One poll-until-terminal helper (R10 DUP-11 — seven hand-rolled pollers,
// two of which had shipped race/cleanup bugs by Round 9, plus FE-6's
// wedged-forever chapter poll).
import { useCallback, useEffect, useRef } from 'react'

export interface PollController { stop: () => void }

export function usePollTask() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = useRef(true)
  useEffect(() => () => { active.current = false; if (timer.current) clearTimeout(timer.current) }, [])

  const poll = useCallback(<T,>(opts: {
    fn: () => Promise<T>
    isDone: (r: T) => boolean
    onDone: (r: T) => void
    onError?: (e: unknown) => void   // default: retry (transient blips shouldn't kill the chain)
    intervalMs?: number              // default 2000
    backoff?: (attempt: number, base: number) => number
    maxAttempts?: number             // optional; onError-style give-up
  }): PollController => { /* chained setTimeout; every setState-ish callback gated on active.current; errors re-schedule unless maxAttempts exceeded */ },
  [])
  return poll
}
```
Fill the body per the contract in the comments — chained `setTimeout` (never `setInterval`), cancellation on unmount AND on `stop()`, error → re-schedule (with optional backoff/maxAttempts). vitest with fake timers proves: terminal stops the chain; unmount stops it; an error re-schedules; `stop()` works.

Adoption rules: each site's OBSERVABLE cadence/backoff must be preserved (read each before converting; note per-site any intentional behavior kept, e.g. ListenView's backoff). FE-6's ReadingListDetail conversion additionally FIXES its two review-documented bugs (no cleanup, no error handling) — that's the intended behavior change, TDD'd at the hook level. If a site's poller is too entangled to convert cleanly (judgment), leave it and report why — partial adoption with reasons beats forced churn; the review's own wording was "migrate opportunistically". One commit per adopted cluster is overkill — one commit for the hook+tests, one for all adoptions.

---

### Task 3: SourcesList + Avatar (DUP-10)

**Files:** Create `frontend/src/components/Feed/_shared/SourcesList.tsx`; modify `Feed/_shared/Avatar.tsx` (size prop), `Feed/PostCard.tsx` (~726-752 sources block), `Feed/UserPostCard.tsx` (~352-376 sources block + two inline avatars ~190-204/324-338).

Read DUP-10's evidence first. `SourcesList` extracts the line-for-line identical sources-reveal block (toggle button + `FileText size={10}` + `'Hide sources' : \`${n} sources\`` + per-source card with `(score*100).toFixed(0)%`); the only call-site difference was `e.stopPropagation()` — make it a prop (`stopPropagation?: boolean`). `Avatar` gains `size?: number` (default its current 42) + border-width tied to size; UserPostCard's two inline avatars switch to it at their current 40px (the 40-vs-42 / 1.5-vs-2px drift becomes a deliberate choice: match the shared 42/2 UNLESS the archivist thread visually requires 40 — decide by looking at both in the browser and note the choice). Visual parity check in the browser at the gate. tsc + vitest + build green; one commit.

---

### Task 4: AuthContext via request() (BP-9) + LoginPage catch (FE-19)

**Files:** `frontend/src/lib/api.ts` (export the low-level `request` or a thin `authFetch`), `frontend/src/auth/AuthContext.tsx` (7 raw fetches + duplicate API_BASE die), `frontend/src/auth/LoginPage.tsx` (catch in handleSubmit).

BP-9's evidence lists the 7 raw fetch sites. Read AuthContext's error handling per call first — `request()` throws `Error("API error {status}: {text}")` while AuthContext currently branches on `res.ok` and parses error bodies for `setError` messages; the conversion must PRESERVE user-visible error messages (adapt: catch the thrown error, parse the embedded body text, or extend `request` with an option returning structured errors — smallest correct change wins; document the choice). The CSRF note in BP-9 (auth routes exempt) means behavior won't change there — verify by reading `api/csrf.py`'s exemption list (read-only). FE-19: wrap `handleSubmit`'s awaits with a catch routing network-level failures to the existing error banner ("Network error — check your connection."). Tests: vitest for any pure error-parsing helper added; the rest is covered by the gate's browser login smoke. tsc/build green; two commits.

---

### Task 5: Listen fixes — FE-2, FE-3, FE-7(av), BP-11 sliders

**Files:** `frontend/src/components/Listen/ListenView.tsx`, `frontend/src/hooks/useKeyboardShortcuts.ts`, `frontend/src/App.tsx` (pass activeView).

- FE-2: the poll-complete auto-play path calls the existing `playAtIndex(firstPlayable)` instead of inline `audio.src=` assignment (the review notes the inline duplication is WHY the ref update was missed — removing it is the fix).
- FE-3: `useKeyboardShortcuts` gains an `activeView` param; the single-letter nav switch returns early when `activeView === 'listen'` (Escape stays). App.tsx passes it. (This also pre-shapes FE-20's toggle in Task 8.)
- FE-7 (partial): ListenView's two host-avatar paths get `import.meta.env.BASE_URL` prefixes (LoginPage's logo is Task 4's file — do it THERE if not already; coordinate: put it in whichever task lands second, note the handoff — simplest: do the logo here too if Task 4 didn't).
- BP-11 (sliders): ListenView's two hand-rolled `<input type="range">` sliders adopt the promoted shared `Slider` primitive IF visually compatible (read both; if the Listen thumbs are genuinely custom, extend the primitive with a variant rather than forking — or leave with a comment if extension is disproportionate; report the choice).
vitest for any extracted logic; tsc/build; browser smoke at gate covers pause/resume + M-key. One commit per finding (3-4).

---

### Task 6: Messages fixes — FE-5, FE-21, carried clear-DM 404

**Files:** `frontend/src/components/Messages/PaperChat.tsx`, `GroupChatView.tsx`, `frontend/src/components/Personas/PersonaProfile.tsx`.

- FE-5: both initial loads get try/catch/finally + the components' existing error branches; add the IDB fallback read (`paperSummaries`/`groupChats` stores exist in `lib/offline-db.ts` — read its API) on fetch failure.
- FE-21: DM bubbles keyed on stable identity — read what the messages carry (role/content/timestamps?); if no server id exists, assign client-side stable ids at load/append (the review's recommendation); index keys die.
- Carried (wave-3 review Minor 5): `handleClearDm`'s catch treats a 404 as success (thread already gone server-side) — parse the `request()` error for status 404 (Task 4 may have added structured errors — use whatever it built).
tsc/build; vitest where pure; one commit per finding (3).

---

### Task 7: Misc bug sweep — FE-8, FE-15, FE-16, FE-17, FE-18, FE-12, carried useAlerts + ApiKeyInput

**Files:** Create `frontend/src/lib/safeLocal.ts`; modify `hooks/useWorkspaces.ts`, `hooks/useInstallPrompt.ts`, `components/Listen/ListenView.tsx` (its existing try/catch switches to the helper), `App.tsx` (long-press timer → ref), `hooks/useLikes.ts` (reset on feedId change), `components/Explore/ExploreView.tsx` (active sentinel), `components/Nav/DownloadProgress.tsx` + `InstallPrompt.tsx` (`text-text-primary` → `text-text`), `components/Settings/StorageTab.tsx` + `SettingsView.tsx` (dead props), `hooks/useAlerts.ts` (dismiss catch per wave-3 review: `try { await dismissAlert(id) } finally { await refresh() }`), `components/_shared/primitives.tsx` (ApiKeyInput treats the literal value `"set"` as a configured-sentinel: show a masked "configured" placeholder, never prefill the field with the string `set`).

safeLocal:
```ts
// frontend/src/lib/safeLocal.ts
// Shared-origin storage guard (deployment CLAUDE.md: all apps on this origin
// share one ~5MB bucket; a full bucket makes even tiny setItem throw).
export const safeLocal = {
  get(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } },
  set(key: string, value: string): boolean { try { localStorage.setItem(key, value); return true } catch { return false } },
  remove(key: string): void { try { localStorage.removeItem(key) } catch { /* best-effort */ } },
}
```
Each fix per its finding's evidence; vitest for safeLocal + the useLikes reset (pure logic if extractable); tsc/build. One commit per finding (8 small commits — fine).

---

### Task 8: A11y — FE-9, FE-13, FE-14, FE-20

**Files:** `components/Feed/PostDetail.tsx` (ParentPostCard role/tabIndex/aria-label/key handler — mirror PostCard's quote-block treatment), `components/Explore/ExploreView.tsx` (un-nest buttons using the ReadingListsView `role="button"` div pattern its own comments cite), `components/Nav/WorkspaceDropdown.tsx` (`role="menuitem"` on items + Escape-to-close + arrow keys optional; PostCard's MenuItem is the in-repo precedent), `hooks/useKeyboardShortcuts.ts` + Settings (FE-20: a `keyboard_shortcuts_enabled` toggle in the Settings Content/Account tab gating the single-letter set — the SETTINGS KEY needs the api allow-list: it must be added to `shared/ficino_shared/settings_schema.py` DEFAULTS as a UI-only key… that's a BACKEND file; the constraint says backend out of bounds. RESOLUTION: use safeLocal for this preference instead (client-only, no server round-trip needed for an accessibility toggle) — document the choice; delete the dead `g`/`?` switch arms).

Verify each against the exact WCAG-cited behavior in the finding; keyboard-walk in the browser at the gate. One commit per finding (4).

---

### Task 9: Features — group-chat modal (FE-4) + Account wiring

**Files:** Create `frontend/src/components/Messages/NewGroupChatModal.tsx`; modify `MessagesView.tsx` (CTA opens modal), `Inbox.tsx` (both CTAs), `lib/api.ts` (FE-11: `createGroupChat` becomes live; DELETE the genuinely dead: `getPaper`, `applyReadingListOrdering`, `listTags`, `createTag`, `deleteTag`, `offline-cache.ts`'s `networkFirst` UNLESS Task 2/6 adopted it, `types/index.ts` PersonaData re-export — re-grep each first), `components/Settings/AccountTab.tsx` + `lib/api.ts` (add `getMe()`, `listAuditLog(limit?)` wrappers for `/users/me` + `/users/me/audit-log`).

- Modal (minimal per spec: name field + paper multi-picker + create): uses promoted primitives; paper list via the existing `listPapers`-equivalent wrapper (find it in api.ts); on success navigate to the new group view (`onOpenGroup(synthesis_id)`); pending/error states via Task 1's Spinner/EmptyState. `createGroupChat(name, paperIds)` already returns `{synthesis_id, task_id}`.
- Account wiring: AccountTab gains a read-only "Recent account activity" section (last ~20 audit rows: action + resource_type + created_at via timeAgo) and surfaces profile display-name from `/users/me` IF that differs from the existing settings-based field (read AccountTab first — do NOT duplicate an existing display-name editor; the audit view is the substantive addition).
- New Playwright spec `tests/e2e/wave4_group_chat.spec.ts`: create a group chat from the UI (name + select 1+ papers) → assert navigation to the group view and (with Ollama patience) synthesis completion or at least the pending state. Model the spec's setup on `round9_core_flows.spec.ts` (read it).
tsc/build/vitest; the spec runs at the gate. Three commits (modal+CTA / dead-export deletions / account wiring).

---

### Task 10: Lint zero + CI + gate verification

**Files:** the ~21 eslint problems' files (wave-1 ledger: `as any` in `PostCard.compare.test.ts` → type the fixture properly; pre-existing TAB_FOCUS TDZ error in App.tsx → move the declaration above first use; intentional narrowed-deps warnings → targeted `// eslint-disable-next-line react-hooks/exhaustive-deps` WITH a reason comment each, and fix the inaccurate "stable ref" comment at the App.tsx sibling site; whatever else `npx eslint .` reports — fix or justify each, NO blanket rule disabling), `.github/workflows/ci.yml` (frontend job gains `- run: cd frontend && npm run lint` after tsc).

Then the gate: (a) vitest + tsc + build + lint all clean; (b) rebuild frontend container, browser smoke via the Playwright MCP tools against `https://localhost/ficino` — login page renders with logo (FE-7), feed loads, Listen M-key doesn't navigate away, reply-like still repaints, dismiss an alert twice (no unhandled rejection), Settings shows the shortcuts toggle and Account activity; (c) run the new group-chat spec + the branch-relevant e2e (`npx playwright test wave4_group_chat round9_core_flows --reporter=line` with `E2E_BASE_URL=https://localhost/ficino`; the full drifted suite is wave 5's problem); (d) push branch, PR, CI green (now 6 checks incl. lint).

---

### Task 11: Final review + merge + deploy verify (controller)

Whole-branch review (strongest model; carried-minors triage; cross-task: shared-component visual parity, the shortcuts-toggle client-only deviation, dead-export deletions vs adoption); fix loop; merge; watch CI + the FRONTEND Railway deploy (api/worker should NOT rebuild — their watchPatterns exclude frontend/); browser smoke against https://ficino.app (marketing site is ficino.ai; the APP is ficino.app) — login page + feed render; close out ledger/memory. ALSO at merge time: patch the frontend service's missing watchPatterns (`["frontend/**"]`) via the established `railway environment edit --json` by service ID — the wave-2 backlog item; report it.
