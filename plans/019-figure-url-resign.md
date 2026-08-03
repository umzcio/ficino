# Plan 019: Re-sign figure URLs on read instead of persisting 30-day bearer tokens

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- worker/tasks/persona_tasks.py api/routers/feed.py api/routers/papers.py api/tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

Feed generation persists figure URLs into feed-post JSONB with a 30-day TTL. Under the **local** storage backend this is safe — the `/figures/{paper_id}/{figure_id}` endpoint re-checks authentication AND paper ownership on every access (`api/routers/figures.py:21-41`). Under the **Supabase** backend (what the SaaS runs), the persisted URL is a signed URL: a pure capability token with no access-time auth, valid for 30 days. Anyone who obtains one (shared screen, browser history, copied feed JSON, referrer leakage from an `<img>` fetch) gets 30 days of unauthenticated access to figure crops of the owner's papers — asymmetric with every other media surface (audio/podcast URLs are 24h TTL and re-signed per authenticated GET). Fix: treat figure URLs like audio URLs — re-sign fresh (short TTL) inside the authenticated, ownership-checked feed GET, and shrink the persisted TTL to match.

## Current state

- `worker/tasks/persona_tasks.py:29` — the persisted TTL:

```python
FIGURE_URL_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days
```

- `worker/tasks/persona_tasks.py:430-447` — figure URLs minted at generation time. NOTE: the comment here says "24h TTL" but the code passes `ttl=FIGURE_URL_TTL_SECONDS` (30 days) — the comment drifted; this plan fixes both.
- `worker/tasks/persona_tasks.py:747-748` — figure posts persist BOTH the URL and the figure id into the post JSONB:

```python
                if selected_figure:
                    post_data["figure_url"] = selected_figure["image_url"]
                    post_data["figure_id"] = selected_figure["id"]
```

- `api/routers/feed.py:161-197` — the pattern to mirror (`_hydrate_audio_urls`): collects posts needing URLs, does ALL signing in ONE `asyncio.to_thread` hop (the storage signed-URL call is a blocking HTTP round-trip; N direct calls would stall the event loop — R10 API-3), mutates posts in place, fails soft per item:

```python
    def _fetch_all() -> dict[int, str | None]:
        urls: dict[int, str | None] = {}
        for idx in indices:
            try:
                urls[idx] = storage_backend.audio_url(user_id, feed_id, idx)
            except Exception:  # noqa: BLE001
                urls[idx] = None
        return urls

    urls = await asyncio.to_thread(_fetch_all)
```

- The GET handler around `api/routers/feed.py:245-252` already conditionally hydrates audio (`if row["audio_status"] == "ready": await _hydrate_audio_urls(...)`) before `return _feed_from_row(row, posts_data, ...)`.
- `shared/ficino_shared/storage/supabase.py:198-213` — `figure_image_url(user_id, paper_id, figure_id, image_path, ttl=600)`: needs `image_path` (the storage key), which is NOT in the post JSONB — it must be looked up from the `figures` table.
- `frontend/src/components/Feed/PostCard.tsx:338-347` — the frontend already handles both absolute (Supabase) and relative (local) `figure_url` values, so no frontend change is needed.
- The frontend's documented recovery path is `GET /papers/{paper_id}/figures` — find where that route signs its URLs (`grep -rn "figure_image_url" api/`) and check its TTL; if it also uses the 30-day constant, this plan fixes it too.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `ruff check api/ worker/` | exit 0 |
| API tests | `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |
| Worker tests | `docker exec ficino-worker sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |

(If the docker stack is not running, `docker compose up -d` from the repo root first.)

## Scope

**In scope**:
- `worker/tasks/persona_tasks.py` — TTL constant + comment fixes only
- `api/routers/feed.py` — new `_hydrate_figure_urls` + call it in the feed GET
- `api/routers/papers.py` (or wherever `GET /papers/{paper_id}/figures` lives) — TTL fix only, if it shares the constant
- `api/tests/` — new hydration test

**Out of scope**:
- `shared/ficino_shared/` — the storage backends' signing APIs are correct; only their TTL arguments change.
- The post JSONB schema — `figure_id` is already persisted; no migration.
- `api/routers/figures.py` (the local-backend serving endpoint) — already re-checks auth + ownership per request; do not touch.
- Frontend — handles both URL shapes already.

## Git workflow

- Branch: `advisor/019-figure-url-resign` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(api): re-sign figure urls per authenticated feed GET`.

## Steps

### Step 1: Shrink the persisted TTL and fix the drifted comments (worker)

In `worker/tasks/persona_tasks.py`:

1. Change `FIGURE_URL_TTL_SECONDS` to `60 * 60` (1 hour) and rewrite the comment block above it (lines ~25-28): the persisted URL is now only a short-lived fallback for offline/IndexedDB copies between GETs; the API re-signs on every authenticated feed read (see `_hydrate_figure_urls`), so a leaked persisted URL grants at most ~1 hour.
2. Fix the comment at ~line 430 that says "24h TTL" to describe reality: URLs are persisted with a 1h TTL and re-signed fresh on every feed GET; when one expires, the frontend recovers via `GET /papers/{paper_id}/figures` (local backend) or the next feed GET (re-sign).

**Verify**: `ruff check worker/tasks/persona_tasks.py` → exit 0.

### Step 2: Add `_hydrate_figure_urls` to `api/routers/feed.py`

Write a new helper directly after `_hydrate_audio_urls`, mirroring its structure and comment style:

- Collect `indices` of posts where `isinstance(post, dict) and post.get("figure_id")`.
- If none, return.
- ONE DB query (on the handler's existing `db` connection — pass it in) resolving image paths with ownership enforced:

```python
    rows = await db.fetch(
        """SELECT f.id, f.paper_id, f.image_path
           FROM figures f
           JOIN papers p ON f.paper_id = p.id AND p.user_id = $1
           WHERE f.id = ANY($2::uuid[])""",
        user_id, [posts[i]["figure_id"] for i in indices],
    )
```

- Build `{str(figure_id): (paper_id, image_path)}`; then ONE `asyncio.to_thread` hop that loops indices, looks up the figure, and calls `storage_backend.figure_image_url(user_id, str(paper_id), figure_id, image_path or "", ttl=600)` — fail soft per figure (`None` on any exception, same `# noqa: BLE001` style as the audio helper).
- Overwrite `posts[idx]["figure_url"]` only for indices that got a non-None URL (leave the persisted URL in place on signing failure — a possibly-stale image beats a certainly-broken one; log at warning level like the audio helper's philosophy comment describes).

### Step 3: Call it in the feed GET

In the GET handler (around `api/routers/feed.py:245`), call `await _hydrate_figure_urls(posts_data, user.id, db)` UNCONDITIONALLY (not gated on audio/podcast status), before `return _feed_from_row(...)`. Check the handler's exact signature for the `db` connection variable name first.

**Verify**: `ruff check api/routers/feed.py` → exit 0.

### Step 4: Fix the recovery endpoint's TTL if shared

`grep -rn "figure_image_url\|FIGURE_URL_TTL" api/` — if `GET /papers/{paper_id}/figures` (or any other api route) mints URLs with a long TTL, drop it to the 600s default (just remove the explicit `ttl=` argument) with a one-line comment. If it already uses the default, change nothing.

**Verify**: `grep -rn "ttl=" api/routers/ | grep -i figure` → no TTL above 3600 remains.

### Step 5: Tests

In `api/tests/`, find the feed-GET test file (`grep -rln "_hydrate_audio_urls\|audio_url" api/tests/` — the audio hydration tests are the structural pattern). Add tests asserting:

- A feed whose posts include a figure post (`figure_id` + stale `figure_url`) comes back from `GET /feed/{id}` with `figure_url` re-signed (mock/stub the storage backend the same way the audio tests do; assert the signing call received `ttl=600` and the correct image_path from the DB).
- A figure belonging to a DIFFERENT user's paper is not re-signed (ownership join filters it; URL left as persisted).
- A storage-backend exception leaves the persisted URL in place and the GET still returns 200.
- A feed with no figure posts performs no figure queries (mirror however the audio tests assert the early return, if they do).

**Verify**: `docker exec ficino-api sh -c "pytest tests/ -q -k figure"` → all pass, including new tests.

### Step 6: Full suites

**Verify**: api and worker full pytest runs → all pass.

## Test plan

Covered in Step 5. Structural pattern: the existing `_hydrate_audio_urls` tests.

## Done criteria

- [ ] `ruff check api/ worker/` exits 0
- [ ] api and worker pytest suites exit 0; new hydration tests exist and pass
- [ ] `grep -n "FIGURE_URL_TTL_SECONDS" worker/tasks/persona_tasks.py` shows 1 hour
- [ ] No remaining figure URL is minted with ttl > 3600 anywhere in `api/` or `worker/`
- [ ] The re-sign path batches all storage calls in one `asyncio.to_thread` (read the final diff — no `await`ed per-figure signing on the event loop)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- Figure posts in the JSONB do NOT consistently carry `figure_id` across all generators (check the append path, regenerate path at `persona_tasks.py:935+`, and the chapter generator in `reading_list_tasks.py` — grep each for `figure_url`). If some path persists `figure_url` without `figure_id`, report which; do not invent a lookup heuristic.
- `_feed_from_row` or the GET handler shape differs from what's described (drift).
- Re-signing turns out to require N+1 storage calls that can't batch (e.g. local backend signing is cheap but supabase-py can't batch) — report the measured behavior; the one-to_thread-hop structure is mandatory.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- Old feeds (generated before this change) keep working: their persisted 30-day URLs simply get overwritten by fresh 600s ones on every GET.
- Offline/IndexedDB feed copies hold URLs good for ~1h after the last sync; the next online GET re-hydrates. If offline figure viewing beyond 1h becomes a product requirement, the workspace-download flow (`frontend/src/lib/workspace-download.ts`) should prefetch figure BYTES into IDB — that's a separate feature, explicitly out of scope here.
- A reviewer should scrutinize: the ownership JOIN in the hydration query, the fail-soft semantics, and that no per-figure `await` leaked onto the event loop.
