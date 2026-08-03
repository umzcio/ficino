# Plan 017: Make propose_ordering's persist atomic and retryable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- worker/tasks/reading_list_tasks.py worker/lib/db.py api/routers/reading_lists.py worker/tests/ api/tests/`
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

`propose_ordering` persists its result as three separate autocommit writes (UPDATE the list → DELETE all chapters → INSERT rebuilt chapters), wrapped in a `try/except` that only logs. A crash, deploy, or DB error after the DELETE commits but before the INSERT leaves the reading list with **zero chapters while `rationale` is already set** — the frontend's rationale poller exits normally, the task returns success, nothing retries, and the chapter flow is permanently dead for that list with no surfaced error. The task runs `acks_late` with a hard time limit, so mid-persist kills are realistic. The same non-atomic UPDATE/DELETE/INSERT rebuild exists in two API endpoints (milder: user gets a 500, but still leaves a chapterless list row).

## Current state

- `worker/tasks/reading_list_tasks.py:193-215` — the non-atomic, failure-swallowing persist:

```python
        if list_id:
            try:
                new_sequence = [p["paper_id"] for p in result]
                execute(
                    "UPDATE reading_lists SET paper_sequence = $1::uuid[], rationale = $2::jsonb WHERE id = $3",
                    new_sequence, json.dumps(result), list_id,
                )
                # Rebuild chapters to match the new order. ...
                execute(
                    "DELETE FROM reading_list_chapters WHERE reading_list_id = $1",
                    list_id,
                )
                execute(CHAPTER_INSERT_SQL, list_id, new_sequence)
                log.info("propose_ordering_persisted", list_id=list_id)
            except Exception as e:
                # Persistence failure is surfaced loudly but doesn't retry
                # the whole task — the ordering itself already succeeded.
                log.error("propose_ordering_persist_failed", error=str(e)[:200])
```

The task's outer `except` (line 220-224) already does `self.retry(exc=exc)` up to `max_retries=2` — if the persist block raises instead of swallowing, retries come for free. The chapter rebuild is idempotent after the DELETE (same `CHAPTER_INSERT_SQL` used by the API's create endpoint).

- `worker/lib/db.py` — sync-over-async helpers (`execute`, `fetchrow`, `fetch`, `executemany`) over a persistent asyncpg pool, with a `_run(coro)` bridge. The transaction exemplar to mirror is `_store_chunks_batch` in the same file:

```python
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM chunks WHERE paper_id = $1", paper_id)
            await conn.executemany("""INSERT INTO chunks ...""", rows)
```

- `api/routers/reading_lists.py` — `create_reading_list` (~L220-232: INSERT list + `CHAPTER_INSERT_SQL`) and `reorder_reading_list` (~L265-290: UPDATE sequence + DELETE + `CHAPTER_INSERT_SQL`). Handlers receive `db: asyncpg.Connection`; asyncpg connections support `async with db.transaction():`. Read the exact current code before editing — line numbers above are approximate.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `ruff check worker/ api/` | exit 0 |
| Worker tests | `docker exec ficino-worker sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |
| API tests | `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |

(If the docker stack is not running, `docker compose up -d` from the repo root first.)

## Scope

**In scope**:
- `worker/lib/db.py` — add one transaction helper
- `worker/tasks/reading_list_tasks.py` — use it; remove the swallow
- `api/routers/reading_lists.py` — wrap the two rebuild sites
- `worker/tests/` and/or `api/tests/` — new tests per the test plan

**Out of scope**:
- Any other task's persistence (they're already idempotent/atomic).
- `CHAPTER_INSERT_SQL` itself — do not change the SQL.
- The frontend polling behavior (plan 027 bounds the poll; unrelated to atomicity).

## Git workflow

- Branch: `advisor/017-reading-list-persist-transaction` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(worker): persist propose_ordering atomically and let failures retry`.

## Steps

### Step 1: Add a transaction helper to `worker/lib/db.py`

Add, mirroring the file's existing wrapper style (async impl + sync `_run` bridge + pool-closed retry semantics — copy the shape of `_execute`/`execute`):

```python
async def _execute_in_transaction(statements: list[tuple[str, tuple]]) -> None:
    """Run (query, args) pairs in one transaction — all commit or all roll back."""
    pool = await _ensure_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for query, args in statements:
                await conn.execute(query, *args)


def execute_in_transaction(statements: list[tuple[str, tuple]]) -> None:
    """Execute multiple statements atomically. Sync wrapper."""
    return _run(_execute_in_transaction(statements))
```

Note: the pool-closed-rebuild retry used by `_execute` etc. is deliberately omitted — a transaction must not be retried half-applied, and pool-closed errors will surface to the caller (which retries the whole task). Add a one-line comment saying so.

**Verify**: `ruff check worker/lib/db.py` → exit 0.

### Step 2: Use it in `propose_ordering`

Replace the `try/except` block at `worker/tasks/reading_list_tasks.py:193-215` with:

```python
        if list_id:
            # One transaction: a crash between DELETE and INSERT previously
            # left the list with zero chapters but a set rationale — the
            # frontend poller exits, nothing retries, chapter flow dead.
            # Letting the raise reach the outer handler re-enables the
            # Celery retry the task already supports (chapter rebuild is
            # idempotent after DELETE).
            new_sequence = [p["paper_id"] for p in result]
            execute_in_transaction([
                ("UPDATE reading_lists SET paper_sequence = $1::uuid[], rationale = $2::jsonb WHERE id = $3",
                 (new_sequence, json.dumps(result), list_id)),
                ("DELETE FROM reading_list_chapters WHERE reading_list_id = $1",
                 (list_id,)),
                (CHAPTER_INSERT_SQL,
                 (list_id, new_sequence)),
            ])
            log.info("propose_ordering_persisted", list_id=list_id)
```

Keep the nearby comments explaining *why* the persist happens at all (lines 188-192) intact.

**Verify**: `ruff check worker/tasks/reading_list_tasks.py` → exit 0.

### Step 3: Wrap the two API rebuild sites

In `api/routers/reading_lists.py`, wrap the write sequences of `create_reading_list` and `reorder_reading_list` in `async with db.transaction():`. Read the current code first; the change is purely indentation + the `async with` line + a one-line comment referencing atomic chapter rebuild. Do not alter the SQL or the response shapes.

**Verify**: `ruff check api/routers/reading_lists.py` → exit 0.

### Step 4: Tests

Worker (`worker/tests/` — find the reading-list task tests with `grep -rln "propose_ordering" worker/tests/`):

- Atomicity: make `CHAPTER_INSERT_SQL` fail (e.g. drop/rename the target table in a fixture, or monkeypatch to raise on the third statement) and assert the `reading_lists` UPDATE was rolled back (rationale still NULL) and the exception propagated.
- Retry path: with the persist raising, the task calls `self.retry` (follow how the existing tests invoke bound tasks — read the existing propose_ordering tests first and reuse their harness).

API (`api/tests/`, existing reading-list tests — `grep -rln "reading" api/tests/`):

- `create_reading_list` still creates list + chapters (existing tests should cover; make sure they pass).
- `reorder_reading_list` still rebuilds chapters in the new order (existing coverage).

**Verify**: `docker exec ficino-worker sh -c "pytest tests/ -q -k reading"` and `docker exec ficino-api sh -c "pytest tests/ -q -k reading"` → all pass.

### Step 5: Full suites

**Verify**: worker and api full pytest runs → all pass.

## Test plan

Covered in Step 4. Structural pattern: the existing `propose_ordering` task tests and reading-list API tests.

## Done criteria

- [ ] `ruff check worker/ api/` exits 0
- [ ] Worker and api pytest suites exit 0; the new atomicity test exists and fails if the transaction is removed (verify by temporarily reverting Step 2's helper call, or by reasoning demonstrated in the test)
- [ ] No `try/except`-log-only block remains around the persist (`grep -n "propose_ordering_persist_failed" worker/tasks/reading_list_tasks.py` → no matches)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The persist block doesn't match the excerpt (drift).
- `CHAPTER_INSERT_SQL`'s signature differs from `(list_id, sequence)` — report the actual signature.
- The API endpoints structure their writes differently than described (e.g. they already use a transaction, or the writes are interleaved with reads that must stay outside) — report the actual shape.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- `execute_in_transaction` is now the worker's canonical way to do multi-write persistence — future tasks with multiple writes should use it instead of consecutive `execute()` calls.
- A reviewer should scrutinize that nothing outside the three statements depended on autocommit timing (e.g. a concurrent reader seeing the DELETE before the INSERT — the transaction now correctly hides that intermediate state).
- Deferred out of scope: collapsing DELETE+INSERT into a single CTE. The transaction achieves the same atomicity with less risk.
