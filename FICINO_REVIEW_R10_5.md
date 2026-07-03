# Ficino Review — Round 10.5 (Remediation Re-verification)

**Date:** 2026-07-02 · **HEAD:** `r10/wave5-sweep` (post-residuals) · **Scope:** every finding in `FICINO_REVIEW_R10.md` (93 unique findings, 108 area-level IDs), re-verified against source at HEAD with file:line evidence — same no-speculation discipline as the original review. Per-finding tables: `review/round10_5/*.md`.

## Verdict

**Zero regressions across all 93 findings.** Post-residual-fixes status by area (ID-level):

| Area | FIXED | PARTIAL | DEFERRED (approved) | Notes |
|---|---|---|---|---|
| API (20) | 18 | 1 (API-9) | — | API-4/18/20 residuals closed in this wave (`a8e5481`, `b0ff221`, `a9cb6f1`); API-9 is 2/3 — see deferrals |
| Worker (18) | 18 | — | — | WORK-13/16/18 resolved via `ficino_shared` consolidation rather than in-place |
| Frontend (21) | 21 | — | — | FE-9 carries one residual label nuance — see deferrals |
| Duplication (20) | 15 | 3 (DUP-5/7/19) | 2 (DUP-11/20) | DUP-2/14 residuals closed this wave (`6ed869e`, `ab0c8e3`); DUP-10 closed by W4 T3 |
| Best practices (19) | 17 | 2 (BP-8/11) | — | Partials are scope-noted in their wave plans |
| Dep hygiene (10) | 10 | — | — | |

The 0 CRITICAL / 8 HIGH / 43 MEDIUM / 42 LOW distribution of R10 is fully dispositioned: all 8 HIGHs fixed in wave 1 and still holding at HEAD (re-verified, not assumed).

## Known deferrals (each with rationale)

1. **API-9 (1/3):** `GET /papers/{paper_id}/figures` retained — it gained a genuine consumer after the R10 snapshot (`api/tests/test_hydration_offloop.py` exercises off-loop batched URL hydration unique to this route). Path to closure: relocate that assertion to a storage-batching unit test, then delete the endpoint.
2. **DUP-7:** api/worker LLM retry logic converged behaviorally (4xx-no-retry, pinned SDK retries) but remains two comment-synced implementations, not a shared module.
3. **DUP-19:** promoted `_shared/Md.tsx` imports `Feed/_shared/InlineMd` across the boundary — deliberate scope cut (commit `5a6e6ea`); InlineMd promotion is the follow-up.
4. **DUP-5** partial and **DUP-11/20** deferrals: see `review/round10_5/duplication.md` (ListenView's two pollers stay hand-rolled on documented mutex/per-tick grounds; the DUP-20 grab-bag was opportunistic-only).
5. **BP-8:** cross-service constants consolidated; single-service literals (HTTP timeouts, retry backoff, session TTL, top_k) intentionally out of the wave-2 scope note. **BP-11:** Slider/primitives converged; PostCard/UserPostCard's DangerButton/card-shell reinvention not converged.
6. **FE-9 residual:** `ParentPostCard`'s aria-label is identical for parent-post and quoted-post uses; a 3-line `label` prop differentiates them.
7. **Four more dead api `Settings` fields** (`llm_provider`, `claude_model`, `ollama_llm_model`, `anthropic_api_key`): grep-confirmed zero-read by two independent agents, left because no R10 finding names them (scope discipline); documented in-code.
8. **Group-chat error rows are a one-way dead end:** no regeneration path (create mints a fresh uuid), no `DELETE /messages/groups/{id}`, list preview doesn't surface error status, and no `AsyncResult` staleness check mirroring `get_paper_summary`. The wave-5 pending-state work made failures *visible*; recovery UX is the named follow-up. Error rows also carry no error-detail message.
9. **PRODUCT GAP — user decision needed:** Settings and Reading Lists are unreachable on the mobile viewport (no bottom-nav item, no drawer entry, no shortcut), so the keyboard-shortcuts a11y toggle is desktop-only. Surfaced by the e2e re-baseline; affected specs are explicitly skipped pending a navigation-design decision.
10. Small test-infra items: `withDmIds` re-stamps unchanged DM bubbles per round-trip (state-drop hazard if bubbles gain local state); the `navTo` e2e helper is triplicated; `review.spec.ts` has three pre-existing bare `test.skip()`s; e2e runs accumulate junk data in the shared dev DB.

## New findings during remediation (not in R10 — caught by the campaign's own review loops)

All fixed before their wave merged unless noted:

- **W1:** `PUBLIC_DEPLOYMENT` reassert could launder a user-set provider key via live env — fixed by baseline-driven reassert (`554e091`); a tautological public-deployment test was caught and rewritten with a mutation check.
- **W2:** two non-discriminating tests (truncation, `../..` traversal) caught by review and hardened.
- **W3:** SDK `max_retries` stacking under outer loops; a live API key echoed in pytest failure output (empirically proven, redacted); 4xx errors retried on both Ollama paths; **celery interval beat schedules silently reset per deploy** (verified against celery 5.6.3 — moved to wall-clock crontab); two mid-branch commits broken in isolation (history rewritten with byte-identical-tree check).
- **W4:** the FE-2 conversion initially made auto-play never start (stale ref at poll-complete) — caught by review trace, fixed pre-merge; MessagesView same-paper re-navigation regression; unguarded async `onDone` rejections in three poll adopters (one a regression vs base); the BP-9 conversion *fixed* a pre-existing logout-403 under basic auth; a double-dismiss unhandled rejection found live in the gate smoke; Escape double-fire in dropdown edits; fresh group chats flashed a failure screen 100% of the time (retry-on-404 + Synthesizing hint).
- **W5:** the new generating fast-path could poll a hard-stuck row forever (bounded to the same ~100s window); the dead-thread recovery test needed a fail-fast bound (proven: fails in 5.02s on regression); the mobile-navigation product gap above.

## Campaign metrics

- **5 waves**, merged as `c0aacf7` (W1, 14 commits), `5885793` (W2, 13), `566daa2` (W3, 44), `d24c15f` (W4, 42), plus the wave-5 branch (34 commits incl. residuals) — ~147 commits total.
- **211 files changed, +11,298 / −3,610** (pre-campaign → HEAD).
- **Test infrastructure built by the campaign:** worker pytest (0 → 39), shared-package suite (0 → 31), frontend vitest (0 → 64), eslint 23 problems → 0 (enforced in CI), GitHub Actions CI (0 → 5 jobs, all green), Playwright e2e re-baselined from 77 drift failures → 219 passed / 37 skipped / 0 failed ×3 consecutive runs. API pytest 190.
- **Architecture:** `shared/ficino_shared` package (settings schema, sanitize, signed URLs, storage, constants) consumed by both services via identity-tested shims; `usePollTask`/`timeAgo`/`safeLocal`/`AsyncState`/`SourcesList`/promoted primitives on the frontend; embedded Celery beat live in prod for the first time.
- **Process:** every task implemented by a fresh subagent, reviewed by an independent subagent (spec-compliance + adjudications), fix loops until approved; whole-branch final reviews on the strongest model before each merge; 9 fix loops caught 11 defects pre-merge, including two outright regressions the per-task gates couldn't see.
