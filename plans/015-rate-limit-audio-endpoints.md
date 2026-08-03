# Plan 015: Rate-limit the audio and podcast dispatch endpoints

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- api/routers/feed.py api/config.py api/tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

Every endpoint that dispatches paid third-party work (feed generation, summaries, group chats, chapters, uploads, replies, DMs) is rate-limited per user per day — except the two ElevenLabs audio dispatches. Each audio dispatch is up to ~20 TTS calls and each podcast is an LLM script call plus one large Text-to-Dialogue call. The claim/idempotency guard only blocks *concurrent* duplicates and `ready` feeds: any feed in `failed`/`NULL` status is re-dispatchable forever, and every historical feed can be dispatched once in a single burst. On multi-user deploys (`AUTH_PROVIDER != none`) an authenticated user can run up unbounded ElevenLabs/LLM spend.

## Current state

- `api/routers/feed.py` — the two dispatch handlers. Neither has any rate limiting:

```python
# api/routers/feed.py:255-260
@router.post("/{feed_id}/audio", status_code=202)
async def request_feed_audio(
    feed_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
```

```python
# api/routers/feed.py:295-300
@router.post("/{feed_id}/podcast", status_code=202)
async def request_feed_podcast(
    feed_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
```

Both handlers then: 501 when `settings.elevenlabs_api_key` is unset, 404 when the feed isn't owned by the user, return early (`{"status": current}`) when status is `generating`/`ready`, otherwise `celery_app.send_task(...)` and return `{"status": "generating", "task_id": task.id}`.

- `api/config.py:42-53` — existing rate-limit settings, in this exact style:

```python
    rate_limit_uploads_per_day: int = 50
    rate_limit_generations_per_day: int = 20
    rate_limit_user_posts_per_day: int = 30
    rate_limit_summary_per_day: int = 30
    rate_limit_replies_per_day: int = 60
    rate_limit_persona_dm_per_day: int = 60
```

- The convention to match — `api/routers/messages.py` charges **imperatively, right before the dispatch**, so cached/idempotent reads are never charged:

```python
    # Charge the rate limit here, right before the dispatch, so it covers
    # every path that reaches this point (fresh dispatch, the error
    # redispatch above, and the stuck-generating redispatch above) while
    # never touching the cached-read return above.
    await check_rate_limit(user, "summary", settings.rate_limit_summary_per_day)
    task = celery_app.send_task(...)
```

`check_rate_limit` and `RateLimit` are imported from `auth.rate_limit` (`api/routers/messages.py:13`). Check `api/routers/feed.py`'s current imports first — `RateLimit` is already used in this file for feed generation (`feed.py:70` region), so the import may only need `check_rate_limit` added.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `ruff check api/` | exit 0 |
| API tests | `docker compose up -d` then `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |
| Targeted tests | `docker exec ficino-api sh -c "pytest tests/ -q -k audio"` | all pass |

(If the docker stack is not running, start it with `docker compose up -d` from the repo root first. The api suite needs the postgres/redis containers.)

## Scope

**In scope** (the only files you should modify):
- `api/routers/feed.py`
- `api/config.py`
- `api/tests/` — one test file (new or the existing audio-dispatch test file, if one exists)
- `.env.example` — one commented line documenting the new knob, next to the other `RATE_LIMIT_*` entries if any exist there (check first; if no rate-limit entries exist in `.env.example`, skip this file)

**Out of scope** (do NOT touch, even though they look related):
- `worker/tasks/audio_tasks.py` — the worker side is fine.
- Any other endpoint's rate limits.
- The `RateLimit` dependency-based pattern on other routes — do not " unify" the two patterns; the imperative `check_rate_limit` placement is deliberate here (cached reads must not be charged).

## Git workflow

- Branch: `advisor/015-rate-limit-audio-endpoints` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(api): rate-limit audio and podcast dispatch endpoints` (see `git log --oneline -10`).

## Steps

### Step 1: Add the setting

In `api/config.py`, add directly after `rate_limit_persona_dm_per_day` (line 53), matching the existing style:

```python
    rate_limit_audio_per_day: int = 20
```

**Verify**: `ruff check api/config.py` → exit 0.

### Step 2: Charge both dispatches

In `api/routers/feed.py`:

1. Ensure `check_rate_limit` is imported from `auth.rate_limit` (extend the existing import if `RateLimit` is already imported from there).
2. In `request_feed_audio`, immediately before `celery_app.send_task(` (currently around line 286), add:

```python
    # Charge right before dispatch so the idempotent early-returns above
    # (already generating/ready) are never charged — mirrors the summary
    # dispatch in messages.py.
    await check_rate_limit(user, "audio", settings.rate_limit_audio_per_day)
```

3. In `request_feed_podcast`, do the same immediately before its `send_task`.

**Verify**: `ruff check api/` → exit 0. `grep -n "check_rate_limit" api/routers/feed.py` → exactly 2 call sites.

### Step 3: Tests

Find the existing rate-limit test pattern: `grep -rln "check_rate_limit\|RateLimit\|429" api/tests/` and read the summary rate-limit test (the summary endpoint uses the same imperative pattern). Add tests in the audio-dispatch test file (find it with `grep -rln "request_feed_audio\|generate_audio_for_feed\|audio" api/tests/`; create `api/tests/test_feed_audio_rate_limit.py` modeled on the summary one if none exists) covering:

- Dispatching audio for a `failed`/NULL-status feed when under the limit → 202, task dispatched.
- Exceeding `rate_limit_audio_per_day` → 429 (or whatever status the limiter raises — match the existing tests' assertion) and **no** `send_task` call.
- The `generating`/`ready` early-return path does **not** consume rate-limit budget (repeat the early-return N+1 times where N is the limit; the next real dispatch still succeeds).

**Verify**: `docker exec ficino-api sh -c "pytest tests/ -q -k audio"` → all pass, including the new tests.

### Step 4: Full suite

**Verify**: `docker exec ficino-api sh -c "pytest tests/ -q"` → all pass (190+ tests, 0 failures).

## Test plan

Covered in Step 3. Structural pattern: the existing summary rate-limit test found in Step 3.

## Done criteria

- [ ] `ruff check api/` exits 0
- [ ] `docker exec ficino-api sh -c "pytest tests/ -q"` exits 0; new audio rate-limit tests exist and pass
- [ ] `grep -c "check_rate_limit" api/routers/feed.py` ≥ 2
- [ ] Cached/idempotent early-returns remain uncharged (test asserts this)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The handlers in "Current state" don't match the excerpts (drift).
- `check_rate_limit` has a different signature than `(user, bucket_name, limit)` — read `api/auth/rate_limit.py` and report what you found instead of guessing.
- A verification step fails twice after a reasonable fix attempt.
- The existing test suite fails on a clean checkout *before* your change (note the pre-existing failures and stop).

## Maintenance notes

- If a future endpoint dispatches paid work, it must get the same imperative `check_rate_limit` right before `send_task` — reviewers should check this on any new dispatch route.
- `rate_limit_audio_per_day` is env-overridable (`RATE_LIMIT_AUDIO_PER_DAY`) via pydantic-settings, same as the other knobs.
- 20/day was chosen to match `rate_limit_generations_per_day`; legitimate heavy users hitting 429 is the tunable failure mode.
