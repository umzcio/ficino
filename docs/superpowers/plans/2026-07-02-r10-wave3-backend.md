# R10 Wave 3 — Backend Cleanup: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the wave-3 slice of `FICINO_REVIEW_R10.md` — worker idempotency/search/retry MEDIUMs, the Celery beat schedule, api concurrency/correctness bugs, error-contract standardization, the models decision, users.py + audit coverage — plus wave-2 carried items.

**Architecture:** No structural changes; the shared package exists. Worker fixes cluster in `worker/tasks/*` + two `worker/lib` extractions; api fixes cluster per router. Beat runs EMBEDDED in the worker (`-B`) — single-replica deploys only, documented. One additive SQL migration (media claim timestamps).

**Tech Stack:** as wave 2. Suites at start: api 148, worker 9, shared 33 — all green; CI green on main.

## Global Constraints

- Resolves: WORK-5..9, WORK-17, DUP-5/6/7/12/16/17, API-2..6, API-10..16, API-19, BP-1..6, BP-10, BP-12..14, BP-17, BP-18 (see `FICINO_REVIEW_R10.md` + `review/round10/*.md` for full finding text — every brief cites its findings; the area reports are requirement sources).
- Carried from wave 2: `api/constants.py` imports sentinels from `ficino_shared.constants`; autouse env-cleanup fixture for the api reassert test.
- Explicitly deferred to wave 4 (frontend wave): the Settings/Account UI for `/users/me` and the audit-log view (spec listed them in wave 3; the backend halves happen here, UI halves move — approved re-allocation). Deferred to wave 5: all dead-code deletion.
- TDD for every behavior change: failing test first, observed RED. Mechanical extractions are guarded by existing suites + identity/behavior tests.
- Do NOT fix wave-4/5 items even when adjacent. Frontend files are OUT OF BOUNDS except reading to verify callers.
- Container test commands as wave 2 (`docker exec ficino-api ...`/`ficino-worker ...`; reinstall requirements-dev after rebuilds). Any task changing worker/lib or worker/tasks files must docker-cp them in before running the suite (images are from the wave-2 build) — or rebuild once per task if simpler.
- **Frontend-caller gate:** any task changing an endpoint's response shape/status MUST grep `frontend/src/` for callers and list them in its report; a caller that would break = STOP, report BLOCKED (the fix may need re-scoping to wave 4).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `r10/wave3-backend` off main. No Railway config changes this wave (worker CMD changes ride the normal image build).

---

### Task 1: Branch + carried trivia

**Files:** Modify `api/constants.py`, `api/tests/test_settings_contract.py`.

- [ ] Step 1: `git checkout -b r10/wave3-backend`
- [ ] Step 2: `api/constants.py` — replace the two hardcoded sentinel lines with `from ficino_shared.constants import DEFAULT_WORKSPACE_ID, STUB_USER_ID  # noqa: F401` (keep the module docstring and the rest of the file untouched — `ENGAGEMENT_RANGES` is wave-5's problem).
- [ ] Step 3: Add to `api/tests/test_settings_contract.py` an autouse fixture that snapshots/restores `ficino_shared.settings_schema` baseline state around each test in the file (wave-2 final-review Minor 4):
```python
import pytest
from ficino_shared import settings_schema


@pytest.fixture(autouse=True)
def _isolate_baseline_env():
    """The reassert test resets the module-level baseline; restore module
    state after every test in this file so later tests (or files) don't
    inherit a poisoned snapshot (wave-2 final-review Minor)."""
    saved = dict(settings_schema.baseline_env())
    yield
    settings_schema.reset_baseline_for_tests()
    settings_schema.baseline_env().clear()
    settings_schema.baseline_env().update(saved)
```
If `baseline_env()` returns a copy rather than the live dict (read the function first), use whatever reset/mutation surface the module actually exposes to achieve save/restore — and say which in the report.
- [ ] Step 4: api suite green in container (docker-cp the two files); sentinel identity check: `docker exec ficino-api python -c "import constants, ficino_shared.constants as c; assert constants.STUB_USER_ID is c.STUB_USER_ID; print('ok')"`.
- [ ] Step 5: Commit `refactor(api): source sentinel constants from ficino_shared; isolate baseline env in settings tests (R10 wave-3 carried)`.

---

### Task 2: Celery beat (embedded) + WORK-6 stale-papers fix

**Files:** Modify `worker/celery_app.py`, `worker/Dockerfile` (CMD), `docker-compose.yml` (worker command if overridden — check), `worker/tasks/alert_tasks.py:297-305` (stale query). Test: `worker/tests/test_stale_papers.py`.

**Interfaces:** Produces a `beat_schedule` entry `check-stale-papers-daily` dispatching `tasks.alert_tasks.check_stale_papers` on the `persona` queue every 24h.

- [ ] Step 1: Failing test first — the NULL-corpus bug (WORK-6's latent query defect):
```python
"""R10 WORK-6: the stale-paper query treated papers as 'never in a feed'
even when they were debated in all-papers feeds (feeds.corpus_id IS NULL),
because the NOT EXISTS only matched corpus-scoped feeds."""


def test_stale_query_counts_null_corpus_feeds():
    import tasks.alert_tasks as at
    import inspect
    src = inspect.getsource(at.check_stale_papers)
    assert "corpus_id IS NULL" in src, (
        "the NOT EXISTS must also match all-papers feeds (feeds.corpus_id "
        "IS NULL) owned by the same user (R10 WORK-6)"
    )
    assert "f.user_id = p.user_id" in src, (
        "feed ownership must scope the existence check — another user's "
        "all-papers feed must not mark this user's paper as used"
    )
```
(Source-level assertion because the task is a Celery-wrapped DB query; the query's behavior is exercised end-to-end in the gate's smoke. Run RED first.)
- [ ] Step 2: Fix the query in `check_stale_papers` — replace the NOT EXISTS subquery with:
```sql
               AND NOT EXISTS (
                   SELECT 1 FROM feeds f
                   WHERE f.user_id = p.user_id
                     AND (f.corpus_id = p.corpus_id OR f.corpus_id IS NULL)
               )
```
- [ ] Step 3: Beat schedule in `worker/celery_app.py` — add to the first `app.conf.update(...)`:
```python
    # Periodic tasks. Beat runs EMBEDDED in the worker process (-B in the
    # Dockerfile CMD) — correct only while the worker runs a single replica
    # (Railway numReplicas=1, compose single container). If the worker ever
    # scales out, beat must move to its own process or schedules double-fire.
    beat_schedule={
        "check-stale-papers-daily": {
            "task": "tasks.alert_tasks.check_stale_papers",
            "schedule": 86400.0,
            "options": {"queue": "persona"},
        },
    },
    beat_schedule_filename="/tmp/celerybeat-schedule",
```
- [ ] Step 4: `worker/Dockerfile` CMD gains `-B`: `celery -A celery_app worker -B --loglevel=info --queues=...` (rest unchanged). Check `docker-compose.yml` for a worker `command:` override (there is none today — verify) so the Dockerfile CMD is authoritative in both deploys.
- [ ] Step 5: Rebuild worker (`docker compose build worker && docker compose up -d worker`), reinstall requirements-dev, suite green (10), and verify beat is live: `docker logs ficino-worker 2>&1 | grep -iE "beat.*starting|Scheduler"` shows the embedded beat banner. Do NOT wait 24h — beat registration is the check; also fire the task once manually (`docker exec ficino-worker celery -A celery_app call tasks.alert_tasks.check_stale_papers`) and confirm `stale_check_complete` in logs.
- [ ] Step 6: Commit `feat(worker): daily stale-paper alerts via embedded beat; fix NULL-corpus feed check (R10 WORK-6)`.

---

### Task 3: WORK-5 — audio/podcast claims reclaim stale rows

**Files:** Create `infra/postgres/add_feed_media_claimed_at.sql`; modify `worker/tasks/audio_tasks.py` (both claim UPDATEs, ~L185-195 and ~L347-357). Test: `worker/tests/test_media_claim_reclaim.py`.

Migration (additive, apply to local DB in this task; CI's schema loop picks it up automatically by the explicit-list update — ALSO add it to the workflow's Load schema list):
```sql
-- Feed media generation claims (R10 WORK-5). A worker SIGKILLed mid-render
-- leaves audio_status/podcast_status stuck at 'generating' forever — the
-- claim predicate refuses to re-claim and acks_late redelivery self-defeats.
-- Stamp the claim time so a sufficiently old 'generating' row is treated as
-- abandoned and reclaimable.
ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS audio_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS podcast_claimed_at TIMESTAMPTZ;
```
Claim predicate change (same shape for both tasks; audio shown):
```sql
UPDATE feeds
SET audio_status = 'generating', audio_claimed_at = NOW()
WHERE id = $1
  AND (audio_status IS NULL OR audio_status = 'failed'
       OR (audio_status = 'generating'
           AND audio_claimed_at < NOW() - INTERVAL '15 minutes'))
RETURNING ...
```
(The 15-minute threshold > task_time_limit 600s + redelivery slack. A NULL `audio_claimed_at` on a legacy stuck row does NOT match `< NOW() - ...` — handle it: `AND (audio_claimed_at IS NULL OR audio_claimed_at < NOW() - INTERVAL '15 minutes')` so pre-migration stuck rows are reclaimable too.)

- [ ] Step 1: Failing test — behavioral, against the live DB via the worker's sync db helpers:
```python
"""R10 WORK-5: a 'generating' row older than the claim threshold must be
reclaimable; a fresh 'generating' claim must NOT be."""
import uuid

from lib.db import execute, fetchrow


def _mk_feed(status, claimed_at_sql):
    feed_id = str(uuid.uuid4())
    execute(
        f"""INSERT INTO feeds (id, user_id, posts, post_count, audio_status, audio_claimed_at)
            VALUES ($1, '00000000-0000-0000-0000-000000000000', '[]', 0, $2, {claimed_at_sql})""",
        feed_id, status,
    )
    return feed_id


def _claim(feed_id):
    return fetchrow(
        """UPDATE feeds SET audio_status = 'generating', audio_claimed_at = NOW()
           WHERE id = $1
             AND (audio_status IS NULL OR audio_status = 'failed'
                  OR (audio_status = 'generating'
                      AND (audio_claimed_at IS NULL
                           OR audio_claimed_at < NOW() - INTERVAL '15 minutes')))
           RETURNING id""",
        feed_id,
    )


def test_stale_generating_claim_is_reclaimable():
    feed_id = _mk_feed("generating", "NOW() - INTERVAL '20 minutes'")
    try:
        assert _claim(feed_id) is not None, "20-min-old claim must be reclaimable (R10 WORK-5)"
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id)


def test_fresh_generating_claim_is_not_stolen():
    feed_id = _mk_feed("generating", "NOW()")
    try:
        assert _claim(feed_id) is None, "an active render must not be double-claimed"
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id)


def test_legacy_null_claimed_at_generating_row_is_reclaimable():
    feed_id = _mk_feed("generating", "NULL")
    try:
        assert _claim(feed_id) is not None, "pre-migration stuck rows must be recoverable"
    finally:
        execute("DELETE FROM feeds WHERE id = $1", feed_id)
```
The INSERT needs the feeds table's NOT NULL columns — read `infra/postgres/init.sql`'s feeds definition first and add any required columns (e.g. `corpus_id` may be nullable; `generated_at` may default). Adjust the INSERT accordingly; keep the three-case structure. RED = the UPDATE in the test matches production's predicate — write the test to import nothing from the task; it pins the SQL SEMANTICS. To make RED meaningful: FIRST run the migration, THEN write the test against the OLD predicate…
Simpler honest sequencing: apply the migration; copy the production claim SQL into the test's `_claim` (the OLD predicate, no reclaim clause); run: `test_stale_generating_claim_is_reclaimable` FAILS (old predicate refuses). Then change BOTH production claim sites to the new predicate, update `_claim` to mirror production exactly (add a comment: "mirror of audio_tasks claim — update together"), and all three tests PASS.
- [ ] Step 2: Apply the migration locally (`docker exec -i ficino-postgres psql -U ficino -d ficino < infra/postgres/add_feed_media_claimed_at.sql`) and append the file to the CI workflow's Load schema explicit list.
- [ ] Step 3: Implement both claim-site changes (audio + podcast, with podcast_* columns) in `worker/tasks/audio_tasks.py`.
- [ ] Step 4: Full worker suite green (13). Commit `fix(worker): stale media-generation claims become reclaimable after 15min (R10 WORK-5)`.

---

### Task 4: Worker task fixes — WORK-7, WORK-8, WORK-9, WORK-17

**Files:** `worker/tasks/reading_list_tasks.py` (~L430, after the feeds upsert), `worker/tasks/summary_tasks.py` (~L175-193, ~L318-336), `worker/lib/vision_extractor.py` (both extract paths), `worker/lib/persona.py:612-614`. Tests: `worker/tests/test_wave3_task_fixes.py`.

Four independent fixes; each gets a failing test first, then the fix. Requirement sources: `review/round10/worker.md` WORK-7/8/9/17 (read them — they contain the exact evidence and recommended fixes).

- [ ] Step 1: **WORK-7** — after `generate_chapter`'s feeds upsert, call `_write_feed_posts_index(feed_id, posts, 0, effective_user_id)` (import from `tasks.persona_tasks`, which is already imported at ~L410 for `_apply_engagement_defaults`) in the same try/except-non-fatal pattern `generate_feed` uses (find it at persona_tasks ~L880 and mirror the exception handling exactly). Test (source-level + behavioral if cheap): assert `_write_feed_posts_index` is referenced in `generate_chapter`'s source via `inspect.getsource`.
- [ ] Step 2: **WORK-8** — in BOTH summary parse sites, after `json.loads`, filter: `messages = [m for m in messages if isinstance(m, dict) and isinstance(m.get("content"), str) and m.get("content")]` BEFORE the existing `if not messages:` fallback (so a list of strings falls through to the single-bubble fallback instead of persisting). Test: unit-test the filter by extracting it as a module-level helper `_coerce_messages(parsed) -> list[dict]` in summary_tasks.py used by both sites:
```python
def test_coerce_messages_drops_non_dict_elements():
    from tasks.summary_tasks import _coerce_messages
    assert _coerce_messages(["a", "b"]) == []
    assert _coerce_messages([{"role": "x", "content": "hi"}, "junk", {"content": ""}]) == [{"role": "x", "content": "hi"}]
```
- [ ] Step 3: **WORK-9** — wrap the HTTP/SDK call in `_extract_page_ollama` AND `_extract_page_claude` in the same 3-attempt exponential backoff used by `_generate_ollama` (`worker/lib/claude_client.py:60-89` — read it and replicate the loop shape/waits; do NOT extract a shared helper here, that's a wave-5-adjacent nicety and claude_client's loop is the pattern precedent). Test: monkeypatch-based —
```python
def test_ollama_page_extract_retries_transient_failures(monkeypatch):
    import httpx
    from lib import vision_extractor as vx
    calls = []
    class _FakeResp:
        status_code = 200
        def json(self): return {"message": {"content": "page text"}}
        def raise_for_status(self): pass
    class _FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, *a, **k):
            calls.append(1)
            if len(calls) < 3:
                raise httpx.ConnectError("blip")
            return _FakeResp()
    monkeypatch.setattr(vx.httpx, "Client", _FakeClient)
    monkeypatch.setattr(vx.time, "sleep", lambda s: None, raising=False)
    out = vx._extract_page_ollama(b"fake-png-bytes", 1)
    assert out == "page text" and len(calls) == 3
```
Adapt the fake to `_extract_page_ollama`'s ACTUAL signature and client usage (read it first — it may use a module-level client or different arg shape; keep the assertion: two failures then success, result returned). If the function's structure makes this fake impractical, test the extracted retry via a `_post_with_retry`-style inner helper you factor out — say which in the report.
- [ ] Step 4: **WORK-17** — `worker/lib/persona.py:612-614`: restrict the empty-set fallback to feed-eligible personas. The callers filter by `feed_eligible`; the fallback bypasses it. Factor the selection into a testable module-level helper `def eligible_persona_keys(enabled_personas: set[str] | None) -> list[str]` implementing: enabled set non-empty → keys in it; empty/None → ONLY feed-eligible persona keys (read how PERSONAS entries mark feed-eligibility — the callers at persona_tasks ~L315-323 show the attribute — and use that exact attribute). The old inline expression's call site switches to the helper. Test (write RED first against the extracted-but-old logic, or assert the bug on the current expression before extracting — either order, show it):
```python
def test_fallback_excludes_reply_only_personas():
    from lib.persona import eligible_persona_keys
    keys = eligible_persona_keys(set())
    assert keys, "empty enabled set must still fall back to a non-empty plan"
    assert "archivist" not in keys, (
        "the Archivist is reply-only (feed_eligible=false) — the fallback "
        "must not let it author feed posts (R10 WORK-17)"
    )
```
- [ ] Step 5: Full worker suite green. One commit per fix (4 commits), messages: `fix(worker): index chapter posts for search (R10 WORK-7)` / `fix(worker): drop malformed summary message elements (R10 WORK-8)` / `fix(worker): retry transient vision page-extraction failures (R10 WORK-9)` / `fix(worker): persona fallback excludes reply-only personas (R10 WORK-17)`.

---

### Task 5: DUP-5 — event-loop helper + provider-config consolidation

**Files:** Create `worker/lib/event_loop.py`; modify the 7 live modules with copies (`db, claude_client, embedder, contextualizer, figure_detector, vision_extractor, metadata_extractor` — figure_describer is dead, DO NOT touch it, wave 5 deletes it). Test: `worker/tests/test_event_loop.py`.

- [ ] Step 1: Extract the daemon-thread pattern from `worker/lib/db.py:29-45` (the canonical fixed version) into:
```python
"""Shared background event-loop helper (R10 DUP-5).

Each subsystem gets a named daemon thread running an asyncio loop forever;
sync wrappers submit via run_coroutine_threadsafe so concurrent Celery
threads don't serialize behind a single run_until_complete (the round-4
bug this pattern fixed — worker/lib/db.py documented it first)."""
import asyncio
import threading


class LoopRunner:
    def __init__(self, name: str) -> None:
        self._name = name
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._loop is None or self._loop.is_closed():
                self._loop = asyncio.new_event_loop()
                t = threading.Thread(target=self._loop.run_forever, name=self._name, daemon=True)
                t.start()
            return self._loop

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._ensure_loop()).result()
```
FIRST read all 7 copies and reconcile: if any copy has behavior this class lacks (e.g. db's rebuild-on-closed handling, timeouts), fold it in so the class is the superset — list per-module deltas in the report. `metadata_extractor`'s copy is the REGRESSED one (run_until_complete under a lock) — it gets the fix by adoption.
- [ ] Step 2: Each of the 7 modules replaces its private loop scaffolding with a module-level `_runner = LoopRunner("<name>-loop")` and `_runner.run(coro)` at its call sites — preserving each module's public sync-wrapper signatures exactly. Thread names preserved (they appear in debug output).
- [ ] Step 3: Test:
```python
def test_loop_runner_concurrent_submissions_dont_serialize():
    import asyncio, time, threading
    from lib.event_loop import LoopRunner
    r = LoopRunner("test-loop")
    async def sleeper():
        await asyncio.sleep(0.2)
        return threading.current_thread().name
    start = time.monotonic()
    results = []
    threads = [threading.Thread(target=lambda: results.append(r.run(sleeper()))) for _ in range(4)]
    [t.start() for t in threads]; [t.join() for t in threads]
    elapsed = time.monotonic() - start
    assert elapsed < 0.6, f"4 concurrent 0.2s coroutines took {elapsed:.2f}s — serialized?"
    assert all(name == "test-loop" for name in results)
```
- [ ] Step 4: `_get_config` consolidation — the review (DUP-5) found 6 near-identical provider readers. figure_describer's is dead; the remaining 5 each hardcode `OLLAMA_BASE_URL` default + model defaults. Consolidate ONLY the base-URL read: add to `worker/lib/settings.py` a helper `def ollama_base_url() -> str: return os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")` and switch the 5 readers' base-URL lines to it. Do NOT merge the full `_get_config` functions (they read different key sets; forcing one shape is churn without payoff — deviation from the plan's original "fold into settings" idea, justified: the model-default drift is already fixed by Task 8-wave-2's `default_for`).
- [ ] Step 5: Full worker suite green + an ingestion smoke (upload → complete) since this touches every provider module's plumbing. Commit `refactor(worker): shared LoopRunner for background event loops; single ollama_base_url reader (R10 DUP-5)`.

---

### Task 6: Persona-lib helpers — DUP-6, DUP-12, DUP-7

**Files:** `worker/lib/persona.py` (new helpers), `worker/tasks/persona_tasks.py` (2 sites), `worker/tasks/reading_list_tasks.py`, `worker/tasks/archivist_tasks.py` (2+2 sites), `api/services/llm.py` + `worker/lib/claude_client.py` (DUP-7 hardening ports). Tests: `worker/tests/test_persona_helpers.py`.

- [ ] Step 1: **DUP-6** — add `build_post_sources(chunks: list[dict], top_n: int = 5) -> list[dict]` to `worker/lib/persona.py` containing the byte-identical dict comprehension from the 4 sites (verify all 4 are still identical first — cite line numbers in the report; if any drifted since the review, STOP and report). Switch all 4 sites. Test: feed it a fake chunk list, assert key set `{chunk_id, paper_id, paper_title, section, content, score}`, content truncated to 300, top_n respected.
- [ ] Step 2: **DUP-12** — add `resolve_enabled_personas(user_settings: dict) -> set[str]` (the opt-out derivation block, verbatim from persona_tasks ~L315-326 — the reading_list copy self-identifies as its mirror) and, in `archivist_tasks.py`, a module-local `_get_paper_ids(post_user_id: str, corpus_id: str | None) -> list[str]` collapsing the byte-identical query pair at its 2 sites. Switch the 4 sites. While there: the archivist temperature fallback literal `0.7` at ~L337 aligns to `0.8` (DUP-12's noted drift — dead in practice, but the literals should agree; cite the review).
- [ ] Step 3: **DUP-7** — port hardening both ways, NO shared abstraction: (a) api `services/llm.py`'s Ollama branch gains the worker's 5xx retry loop (replicate `claude_client.py:64-90`'s shape in async form with `asyncio.sleep`); (b) worker `claude_client.py`'s Ollama path gains the api's empty-response guard semantics (`RuntimeError("LLM returned empty response")` after the thinking-fallback, matching llm.py:84-85 — read both first; if the worker already raises an equivalent, document and skip). Tests: worker side — extend the existing pattern of monkeypatch fakes to return an empty-content 200 and assert the RuntimeError; api side — cannot unit-test easily without an async harness in api/tests: add `api/tests/test_llm_retry.py` using monkeypatched `httpx.AsyncClient` (the api tests already run under pytest-asyncio).
- [ ] Step 4: Both suites green. Commits: `refactor(worker): shared build_post_sources + resolve_enabled_personas + archivist paper-scope helper (R10 DUP-6, DUP-12)` and `fix: converge LLM provider hardening — api gains 5xx retry, worker gains empty-response guard (R10 DUP-7)`.

---

### Task 7: api plumbing — celery client, auth gates, upload cap, rate-limit knobs, search flag

**Files:** Create `api/celery_client.py`; modify `api/routers/{feed,messages,reading_lists,user_posts,papers}.py` (celery), `api/routers/personas.py:22` + `api/routers/settings.py` ollama-models handler (auth), `api/routers/papers.py` upload handler (API-19), `api/config.py` + `api/routers/replies.py` + `api/routers/personas.py` (BP-6 knobs), `api/routers/search.py` + `api/config.py` (BP-14), new shared textutil for `_escape_like`. Tests: extend `api/tests/`.

- [ ] Step 1: **API-5/DUP-13/BP-15** — `api/celery_client.py`:
```python
"""Single Celery client for API-side dispatch (R10 API-5).

Module-level so hot polling paths don't construct a new app + broker
connection per request. Configured with broker AND result backend —
papers.py's old inline copy omitted the backend (drift)."""
from celery import Celery

from config import settings

celery_app = Celery(broker=settings.redis_url, backend=settings.redis_url)


def get_celery() -> Celery:
    return celery_app
```
Replace the 4 router `_get_celery` helpers and papers.py's inline construction with `from celery_client import get_celery`. KEEP the local name `_get_celery = get_celery` aliases OUT — update call sites properly. CAUTION: `api/tests/test_summary_redispatch.py` monkeypatches `routers.messages._get_celery` — update that test to patch the new import site (`monkeypatch.setattr(messages, "get_celery", ...)` — check how the router references it and patch THAT name); this is the one test-text change allowed, justify in report. Also delete papers.py's dead `_get_redis` helper + `from redis import Redis` import if now unused (BP-15's residue — ruff will tell you).
- [ ] Step 2: **API-6/BP-13** — add `user: AuthUser = Depends(get_current_user)` to `GET /personas` and `GET /settings/ollama-models` (imports exist in both files — verify). Frontend-caller gate: grep `frontend/src` for `listPersonas`/`ollama-models` calls — both go through `lib/api.ts` `request()` which sends credentials, so auth'd sessions keep working; confirm and cite. Tests: `api/tests/test_auth_scoping.py`-style — unauthenticated client gets 401 on both (there is an unauthenticated client fixture or build one with plain httpx AsyncClient against the app; read conftest for the pattern).
- [ ] Step 3: **API-19** — in `upload_paper`, BEFORE `await file.read()`: check `request.headers.get("content-length")` and 413 if it exceeds `settings.max_upload_size_mb * 1024 * 1024 + 16384` (multipart overhead allowance); the handler needs the `Request` param (check whether it already has one). Keep the post-read check (defense in depth — Content-Length can lie). Test: POST with a spoofed oversized Content-Length header, assert 413 without body upload.
- [ ] Step 4: **BP-6** — add `rate_limit_replies_per_day: int = 60` and `rate_limit_persona_dm_per_day: int = 60` to `api/config.py` next to the other rate knobs; replace the three hardcoded `60`s (`replies.py:335,707`, `personas.py:158`). Do NOT delete `generation_limit_per_day` (wave 5, DEP-5). Test: characterization — the settings fields exist and default 60.
- [ ] Step 5: **BP-14** — add `search_use_normalized_posts: bool = True` to `api/config.py`; `search.py` reads `settings.search_use_normalized_posts` instead of `os.getenv`; move `_escape_like` from `replies.py:23-32` to a new `api/textutil.py` as `escape_like` (public), import in BOTH replies.py and search.py (replies keeps a `_escape_like = escape_like` alias only if internal call sites are many — prefer updating call sites).
- [ ] Step 6: Full api suite green. Commits: one per step-group (5 commits max, messages citing the finding IDs).

---

### Task 8: api concurrency/correctness bugs — API-10, API-13, API-14, API-15, API-16, API-2

**Files:** `api/routers/likes.py:70-84`, `api/routers/bookmarks.py:78-93`, `api/routers/workspaces.py:221`, `api/routers/settings.py` clear_all_papers + `_cleanup_artifacts` hoist, `api/routers/user_posts.py:130-151,171-199`, `api/routers/personas.py:303-321`, `api/routers/messages.py` + `api/auth/rate_limit.py` (API-2). Tests: `api/tests/test_wave3_correctness.py`.

Requirement sources: `review/round10/api.md` API-10/13/14/15/16/2 — each entry has the exact evidence and the recommended fix; read them all first. TDD each:

- [ ] Step 1: **API-10** — likes + bookmarks create handlers become single-statement upserts: `INSERT ... ON CONFLICT (user_id, feed_id, post_index, message_index) DO NOTHING RETURNING id`, then on no-row (conflict) fetch the existing id. VERIFY the exact unique-constraint columns from `infra/postgres/init.sql:150,239` first (message_index nullable? A NULL in a unique constraint never conflicts in Postgres — if message_index is nullable, check whether the table uses a partial/expression index or COALESCE convention; if plain UNIQUE with nullable column, post-level likes (NULL message_index) can still duplicate — in that case implement the recommended upsert for the non-NULL path AND keep a try/except UniqueViolation → fetch fallback for the NULL path, documenting why; report what you found). Test: two rapid identical POSTs both 2xx and only one row.
- [ ] Step 2: **API-13** — `workspaces.py` sort key: `key=lambda a: a["timestamp"] or datetime.min.replace(tzinfo=timezone.utc)` (add imports). Test: unit — build the activities list shape with a None timestamp and sort with the new key (extract the key to a module-level `_activity_sort_key` so it's testable).
- [ ] Step 3: **API-14** — wrap `clear_all_papers`'s two DELETEs in `async with db.transaction():` (mirror clear_everything at ~L346); hoist the duplicated `_cleanup_artifacts` closure to one module-level `async def _cleanup_artifacts(user_id, paper_ids, log_event)` used by both endpoints. Test: the existing danger-zone tests must stay green (they exist — grep `clear` in api/tests); add one asserting both endpoints share the same function object via inspect if trivially possible, else rely on ruff+suite.
- [ ] Step 4: **API-15** — `create_user_post`: dispatch BEFORE the status write… read the review entry: the recommended order is dispatch-then-INSERT? No — re-read API-15: INSERT persists first so status exists; fix = wrap so a dispatch failure marks the row `error` instead of stranding `pending`: try/except around `send_task`; on exception `UPDATE user_posts SET status='error' WHERE id=$1` then re-raise as 503. `reply_to_user_post`: the status flip gains `AND status = 'complete'` and 409s when 0 rows. Tests: monkeypatch `get_celery` to raise on send_task → POST returns 5xx AND the row's status is `error` not `pending`; the follow-up double-fire test posts two concurrent follow-ups (sequentially is fine: first flips to pending, second gets 409).
- [ ] Step 5: **API-16** — `delete_persona_dm_message` becomes the atomic `SET messages = messages - $3::int` pattern with the same length-guard as `replies.py:696-699` (read that handler and mirror it). Test: delete index 0 twice on a 1-message thread → second gets 404/409 not corruption.
- [ ] Step 6: **API-2** — add to `api/auth/rate_limit.py` an imperative:
```python
async def check_rate_limit(user: AuthUser, key_prefix: str, max_requests: int, window_seconds: int = 86400) -> None:
    """Imperative twin of the RateLimit dependency — for handlers that must
    charge the limit only on specific branches (R10 API-2: charging cached
    reads throttled pure browsing)."""
```
…with the SAME body semantics as `RateLimit.__call__` (auth_provider none skip, INCR-first, expire-on-first, 429 over limit) — factor the shared body into a private helper both use, don't copy it. In `messages.py` `get_paper_summary`: REMOVE the `_rl` dependency and call `await check_rate_limit(user, "summary", settings.rate_limit_summary_per_day)` immediately before the `send_task` dispatch (both the error-redispatch fall-through and the fresh-dispatch reach it — place it right before the dispatch block so all dispatch paths are charged and no read path is). `create_group_chat` KEEPS its dependency (every call dispatches). Update the handler's comment. Tests: cached-read path (existing complete summary) does NOT 429 after >limit reads with auth_provider stubbed to non-none — this needs the rate limiter active: monkeypatch `settings.auth_provider` to "basic" and `_get_redis` to a fake counter; assert N cached reads never 429, while a dispatch path increments.
- [ ] Step 7: **API-11** — `api/routers/citations.py:27-35`: rebuild the many-author branch per the review's fix: build `formatted` from ALL authors; exactly-20 lists all 20 (`", ".join(formatted[:-1]) + ", & " + formatted[-1]` over the full list); >20 emits first 19 + `", ... "` + the TRUE last author (`formatted[-1]` of the full list). Tests first (RED against current code): 20 authors → all 20 present; 21 authors → author #21 present after the ellipsis, author #20 absent, exactly 19 before the ellipsis.
- [ ] Step 8: **API-12/BP-5** — `api/routers/reading_lists.py`: `apply_ai_ordering` gets a pydantic model (`class OrderedPaper(BaseModel): paper_id: str` + `class ApplyOrderingRequest(BaseModel): ordered_papers: list[OrderedPaper]`) replacing `body: dict` (place them wherever Task 11's Step 2 convention puts request models — if Task 11 already ran, `api/models/requests.py`; else inline and Task 11 sweeps them); BOTH `reorder_reading_list` and `apply_ai_ordering` reject duplicate paper IDs (`len(seq) != len(set(seq))` → 422). Tests first: duplicate-ID payloads → 422 (currently succeed — RED); malformed `ordered_papers: ["x"]` → 422 not 500.
- [ ] Step 9: Full api suite green. One commit per finding (8 commits).

---

### Task 9: API-3 — signed-URL hydration off the event loop

**Files:** `api/routers/feed.py:121-190`, `api/routers/papers.py:311-325`. Test: `api/tests/test_hydration_offloop.py`.

- [ ] Step 1: Read the two hydration helpers (`_hydrate_audio_urls`, `_hydrate_podcast_episode_url`) and `list_figures`'s per-row URL loop. Restructure each so ALL storage URL calls for a response happen inside ONE `await asyncio.to_thread(...)` hop (a small sync closure that loops and returns the collected URLs), then merge results — matching the pattern the same files already use for upload/delete (`papers.py:88,276`). Semantics identical; ordering preserved.
- [ ] Step 2: Test: monkeypatch the storage backend's `audio_url` to a function that ASSERTS it is NOT running on the event loop thread (`threading.current_thread() is not main` won't work directly — instead capture `asyncio.get_running_loop()` inside the fake: calling it must raise RuntimeError when properly off-loop):
```python
def _fake_audio_url(*a, **k):
    import asyncio
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return "https://signed.example/ok"
    raise AssertionError("storage URL call ran ON the event loop (R10 API-3)")
```
Wire via monkeypatching the storage object used by feed.py (find its import — `from storage import storage` or a local alias), seed a feed row with `audio_status='ready'` and one post carrying an `audio_key`, GET the feed, assert 200 and the URL in the response. RED first: the fake raises under the current on-loop implementation.
- [ ] Step 3: Full api suite green. Commit `perf(api): batch signed-URL hydration off the event loop (R10 API-3)`.

---

### Task 10: Error contracts — BP-1, BP-2, BP-3

**Files:** `api/services/llm.py` (new `llm_error_to_http`), `api/routers/replies.py`, `api/routers/personas.py`, `api/routers/feed.py:330,375`, `api/routers/alerts.py:87-98`, plus explicit-idempotency comments in `bookmarks.py`, `tags.py`, `workspaces.py`. Tests: `api/tests/test_error_contracts.py`.

- [ ] Step 1: **BP-1** — the graded exception→status mapping exists VERBATIM twice (`personas.py:246-263` ≈ `replies.py:832-849`). Move it into `api/services/llm.py` as `def llm_error_to_http(exc: Exception) -> HTTPException` (verify-then-move: diff the two blocks first; if they drifted, reconcile supersets and note). Switch both sites, AND wrap `create_reply`'s main-persona `asyncio.gather` failure path (replies.py:574-578) to use it instead of blanket 500. Test: unit — `llm_error_to_http(asyncio.TimeoutError())` → 504, `httpx.ConnectError("x")` → 503, `ValueError("x")` → 400, `RuntimeError("x")` → 500.
- [ ] Step 2: **BP-2** — feed.py's two `400 "Post index out of range"` become `404` with detail matching the peers (`"Post not found"` style — read personas/replies for the phrasing and align). Frontend-caller gate: grep for handling of those endpoints' 400s.
- [ ] Step 3: **BP-3** — minimal, non-breaking standardization: `alerts.py` dismiss becomes `status_code=204` + 404-on-missing (frontend gate: check `dismissAlert` in lib/api.ts tolerates 204 — `request()` returns undefined for 204; verify the caller ignores the body). `personas.py`'s two DM-delete/clear endpoints: KEEP 200+JSON (the frontend consumes `{"messages": ...}` — verify, cite) but add the 404 existence guard where missing. The intentionally-idempotent deletes (`bookmarks.py:119-131`, `tags.py:133-148`, `workspaces.py`) get a one-line `# Intentionally idempotent: ...` comment instead of behavior change. Tests: dismiss returns 204 and second dismiss 404.
- [ ] Step 4: Full api suite green (update any test asserting the old codes — each such change cited to the finding). Commit per finding (3).

---

### Task 11: Models + mappers — BP-4/API-7, DUP-16, DUP-17, BP-17, BP-18

**Files:** `api/models/*`, ~12 routers (inline request models move), `api/routers/papers.py`, `api/routers/feed.py` (row mappers), `api/routers/replies.py` (grounding extraction), `api/routers/reading_lists.py` (batched inserts), `api/constants.py` (limit caps). Tests: suite + `api/tests/test_models_convention.py`.

This is the wave's churn-heavy task; keep each step a separate commit.

- [ ] Step 1: **BP-4 dead half** — delete `PostBase/ThreadPost/QuotePost/ReplyPost/FigurePost` from `api/models/feed.py`, `PaperCreate/Chunk/Figure` from `models/paper.py`, `Corpus/User` from `models/user.py`, and `api/tests/test_models.py` (its only consumers). Fix the false "typed contract" comment at feed.py:10-11. Suite must stay green (nothing production imports them — re-verify with grep before deleting; anything importing them = STOP).
- [ ] Step 2: **BP-4 promote half** — move the 17 inline request models (list in `review/round10/best-practices.md` BP-4) into `api/models/requests.py` (one file — they're 2-5 lines each), import back into their routers. Pure moves, no field changes. Test: `test_models_convention.py` asserts every router's `BaseModel` subclasses come from `models.requests` (walk `routers.*` modules, assert no locally-defined BaseModel subclasses remain except pydantic response models if any — implement pragmatically, even a static grep-based check in the test is acceptable).
- [ ] Step 3: **DUP-16** — module-level `_paper_from_row(row)` in papers.py (3 hydration sites), `_feed_from_row(row, *, include_media=True)` in feed.py (2 sites; the list variant passes include_media=False preserving its current narrower shape); unify papers' two list-SQL variants with the `($2::uuid IS NULL OR p.corpus_id = $2)` predicate. VERIFY response parity: capture GET /papers and GET /feed/{id} JSON before/after (the suite's existing shape assertions are the net; run them).
- [ ] Step 4: **DUP-17** — extract `_load_conversation_and_sources(db, user_id, feed_id, post_index)` inside replies.py used by `create_reply` + `zap_response` (verify-then-extract: diff the two blocks; the review says only the query-message differs).
- [ ] Step 5: **BP-17** — reorder/apply-ordering rebuild their chapters via the `CHAPTER_INSERT_SQL`-style batched statement (parameterizing the unlocked index — read the create path's comment and the two loop sites; the shared constant already encodes initial-create semantics: reorder preserves chapter STATUSES? Read the loops first — if reorder intentionally preserves per-chapter status, the batched rewrite must too; if that makes the SQL substantially different from CHAPTER_INSERT_SQL, write a sibling statement next to the loops rather than forcing the constant — decide from the code, document).
- [ ] Step 6: **BP-18** — hoist the nine LIMIT literals to `api/constants.py` (`MAX_FEEDS_LIST = 20` etc., names from the sites), reference from the SQL f-strings safely (they're constants, not user input — keep them as Python constants interpolated once, with a comment). No pagination redesign (that's explicitly not this wave).
- [ ] Step 7: Full api suite green. 6 commits.

---

### Task 12: users.py + audit coverage — API-4 (backend half), BP-12, BP-10

**Files:** `api/routers/users.py`, the audit gaps: `api/routers/settings.py` (5 danger-zone clears), `api/routers/workspaces.py` (delete), `api/routers/bookmarks.py:119-131`, `api/routers/user_posts.py`, `api/routers/likes.py`, `api/routers/personas.py`, `api/routers/replies.py`. Tests: `api/tests/test_audit_coverage.py`.

- [ ] Step 1: **BP-12** — users.py conventions: typed `db: asyncpg.Connection = Depends(get_db)`, return annotations, keyword HTTPException args (three small edits).
- [ ] Step 2: **API-4 backend** — implement `default_corpus_id` in `update_user_profile` (persist it — read the users table/init.sql for the column; if no column exists, add migration `add_users_default_corpus.sql` with `ADD COLUMN IF NOT EXISTS default_corpus_id UUID` + FK if the table style uses them — mirror init.sql conventions; apply locally + append to CI list) — OR, if `UserUpdate.default_corpus_id` has no plausible consumer semantics, drop the field from the model instead. Decide from what `users.py`/frontend types expect; the review said "implement or drop" — dropping is acceptable and smaller; document the choice. (UI wiring is wave 4 either way.)
- [ ] Step 3: **BP-10** — add `record_audit` calls (mirror the existing call shape at `papers.py:280`) to: all five settings.py danger-zone clears, workspaces delete, bookmarks delete-by-post, user_posts delete, likes delete, personas DM delete/clear, replies delete. Event names snake_case matching existing style (read audit.py + existing call sites for the convention).
- [ ] Step 4: Test: after calling `clear_all_feeds` (the cheapest destructive endpoint) as user A, `SELECT count(*) FROM audit_log WHERE user_id=$1 AND action='<the event name>'` is 1. One test per NEW audited action is overkill — test two representative endpoints (one danger-zone clear, one keyed delete) and static-assert the rest: grep-based test asserting `record_audit` appears in each named handler's source via inspect.
- [ ] Step 5: Full api suite green. Commit per finding (3).

---

### Task 13: Wave gate — full verification + final review

(a) Both container suites + shared suite + `ruff check api/ worker/ shared/`; (b) rebuild stack (`docker compose build api worker && docker compose up -d`), reinstall dev deps, re-run suites in fresh images (this wave changed worker CMD — verify beat banner again); (c) e2e smokes: upload → ingest → generate feed (exercises persona helpers + event loop + sources), fire check_stale_papers manually, request feed audio claim/status; (d) push branch, `gh pr create --fill`, CI green; (e) controller: whole-branch review package + final reviewer; fix loop; verdict Ready.

### Task 14: Merge + deploy verify (controller)

No Railway config changes this wave. `git checkout main && git merge --no-ff r10/wave3-backend && git push`; watch CI + api/worker deploys at the merge commit; healthz; worker logs show BOTH `celery@... ready` AND the beat banner (`beat: Starting...`); confirm `check-stale-papers-daily` appears in beat logs. Delete branch; ledger + memory close-out.
