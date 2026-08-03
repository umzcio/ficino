# Plan 018: Make fresh generate_feed idempotent under hard-kill redelivery

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- worker/tasks/persona_tasks.py worker/tests/`
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

Celery runs with `task_acks_late=True` (`worker/celery_app.py:21`), so a SIGKILL, deploy, or hard time limit between the feed INSERT committing and the task ack redelivers the task with the same `request.id`. On the **append** path this is handled — generated posts carry `_task_id` and a prior attempt's work is detected and skipped. On the **fresh-feed** path nothing guards it: each attempt mints a new random `feed_id` and the INSERT has no conflict handling, so redelivery re-runs ~12 persona LLM calls plus embeddings (billed to the feed owner) and inserts a **duplicate feed** that shows up in the user's feed history. The sibling `generate_chapter` task already solves this exact problem with a deterministic `uuid5` feed id — this plan ports that pattern.

## Current state

- `worker/tasks/persona_tasks.py:294-295` — the fresh path mints a random id per attempt:

```python
    else:
        feed_id = str(uuid.uuid4())
```

- `worker/tasks/persona_tasks.py:277-293` — the append path's guard (the convention to mirror, including the `generate_feed_idempotent_skip` log event):

```python
        # Idempotency guard: Celery retries reuse the same task_id. If a prior
        # attempt of this same task already appended its posts, return early
        # rather than double-appending. Each generated post is tagged with
        # `_task_id` below so we can detect this on retry.
        if any(
            isinstance(p, dict) and p.get("_task_id") == self.request.id
            for p in existing_posts
        ):
            logger.info("generate_feed_idempotent_skip", ...)
            return {..., "idempotent": True}
```

- `worker/tasks/persona_tasks.py:841-856` — the fresh-path INSERT, no `ON CONFLICT`:

```python
            execute(
                """INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                feed_id, effective_user_id, corpus_id, tag_filter,
                posts_json, len(paper_ids), len(all_posts), duration_ms,
            )
```

- The exemplar — `worker/tasks/reading_list_tasks.py:300-309` (`generate_chapter`):

```python
        # Generate a feed scoped to these papers.
        # Deterministic feed_id per (reading_list_id, chapter_index) so a
        # retry of this task uses the same id and the ON CONFLICT clause
        # on the INSERT below can upsert instead of creating an orphan
        # row each time ...
        feed_id = str(
            uuid.uuid5(uuid.NAMESPACE_DNS, f"ficino:chapter:{reading_list_id}:{chapter_index}")
        )
```

`uuid` is already imported in `persona_tasks.py` (line 295 uses `uuid.uuid4`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `ruff check worker/` | exit 0 |
| Worker tests | `docker exec ficino-worker sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |

(If the docker stack is not running, `docker compose up -d` from the repo root first.)

## Scope

**In scope**:
- `worker/tasks/persona_tasks.py`
- `worker/tests/` — the generate_feed test file (find with `grep -rln "generate_feed" worker/tests/`)

**Out of scope**:
- The append path — already guarded; do not touch it.
- `generate_chapter` — already idempotent.
- The API dispatch layer (`api/routers/feed.py`) — no change needed; each real user dispatch gets a fresh Celery task id, hence a fresh feed id.
- The `_write_feed_posts_index` sync after the INSERT — if it's not idempotent under redelivery, note it in your report but do not fix it here (read it first; if it obviously double-inserts on retry, that's a STOP condition).

## Git workflow

- Branch: `advisor/018-generate-feed-idempotency` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(worker): make fresh generate_feed idempotent on redelivery`.

## Steps

### Step 1: Deterministic feed id on the fresh path

Replace `worker/tasks/persona_tasks.py:294-295` with:

```python
    else:
        # Deterministic per Celery task id: acks_late redelivery reuses
        # request.id, so a retried attempt re-derives the SAME feed_id and
        # the entry guard below short-circuits instead of inserting a
        # duplicate feed (each real dispatch gets a fresh task id, so fresh
        # feeds still get fresh ids). Mirrors generate_chapter's uuid5.
        feed_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"ficino:feed:{self.request.id}"))
```

### Step 2: Entry guard on the fresh path

Immediately after the `else` block (before `log = logger.bind(...)` at line 296), add:

```python
        # Idempotency guard: if a prior attempt of this same task already
        # inserted its feed, return it rather than re-running the whole
        # pipeline (and double-billing the owner's LLM keys).
        existing = fetchrow(
            "SELECT post_count FROM feeds WHERE id = $1 AND user_id = $2",
            feed_id, effective_user_id,
        )
        if existing and existing["post_count"]:
            logger.info("generate_feed_idempotent_skip",
                        feed_id=feed_id, task_id=self.request.id,
                        existing_post_count=existing["post_count"])
            return {
                "feed_id": feed_id,
                "post_count": existing["post_count"],
                "duration_ms": 0,
                "idempotent": True,
            }
```

Check first whether `fetchrow` is already imported in `persona_tasks.py` (it is used at line 271 for the append path — yes). Place the guard so it only runs on the fresh path (inside or right after the `else`), never on append.

**Verify**: `ruff check worker/tasks/persona_tasks.py` → exit 0.

### Step 3: Belt-and-braces on the INSERT

Add `ON CONFLICT (id) DO NOTHING` to the fresh-path INSERT at line 841, with a one-line comment: `# redelivery raced the entry guard — never duplicate the feed`. After the `execute` call, the surrounding code continues to `_write_feed_posts_index` — read that flow and add the index-write inside a check that the INSERT actually happened **only if** the current code would otherwise double-write the index on redelivery; otherwise leave it and explain in your report why it's safe. (The entry guard in Step 2 makes this path unreachable in practice; this clause covers only the guard-vs-insert race.)

**Verify**: `ruff check worker/` → exit 0.

### Step 4: Test

In the generate_feed test file, add a redelivery test following the file's existing harness for invoking the bound task (read the existing tests first — note how they set `self.request.id` and stub the LLM/persona pipeline):

- Run the fresh-path task to completion with `request.id = "task-123"` → one feed row exists.
- Invoke the same task again with the same `request.id` → returns `idempotent: True` with the same `feed_id`, no second feed row (`SELECT COUNT(*) FROM feeds WHERE id = ...` == 1), and the persona-generation pipeline was not re-entered (assert via the same stub counters the existing tests use).
- A dispatch with a *different* `request.id` produces a *different* `feed_id`.

**Verify**: `docker exec ficino-worker sh -c "pytest tests/ -q -k generate_feed"` → all pass, including the new test.

### Step 5: Full suite

**Verify**: `docker exec ficino-worker sh -c "pytest tests/ -q"` → all pass.

## Test plan

Covered in Step 4. Structural pattern: the existing generate_feed tests in the same file.

## Done criteria

- [ ] `ruff check worker/` exits 0
- [ ] `docker exec ficino-worker sh -c "pytest tests/ -q"` exits 0; the redelivery test exists and passes
- [ ] `grep -n "uuid5" worker/tasks/persona_tasks.py` → 1 match on the fresh path
- [ ] The append path is byte-identical to before (except possibly comments)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match (drift) — in particular, if the fresh path no longer mints `uuid4` or already has a guard.
- `_write_feed_posts_index` would double-insert rows on redelivery in a way the entry guard doesn't cover.
- Anything else keys off `feed_id` being a *random* uuid (grep for consumers of the return value before assuming — report what you find).
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- The deterministic-id convention is now: `ficino:feed:{task_id}` for fresh feeds, `ficino:chapter:{list}:{index}` for chapters. New feed-like inserts should follow it.
- A reviewer should confirm the guard's `post_count > 0` condition can't misfire on a legitimately empty feed (feed generation validates posts before insert — empty feeds are dropped by design; confirm that invariant still holds when reading the diff).
