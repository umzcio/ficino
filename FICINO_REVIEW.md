# FICINO_REVIEW.md — Round 7

Focused code review. Severity floor: HIGH/CRITICAL only. Per-agent cap: 10. Six parallel sub-agents (security, bugs, perf, a11y, llm-safety, deps) + native Playwright on the deployed site at `https://ficino.local/ficino`.

## Executive summary

| Severity | Count |
|---|---|
| CRITICAL | 2 |
| HIGH | 10 |
| **Total** | **12** |

Below the 15-30 target band. Codebase has already absorbed rounds 1-6 (most IDOR, rate-limit, and a11y polish already closed); what's left is mostly correctness edge cases and cost-control gaps.

A11y and dependency audits returned empty — no AA blockers on core flows, no HIGH/CRITICAL CVEs with an exploit path in how Ficino uses its deps (`pip-audit` clean on api + worker, `npm audit --omit=dev` reports 0 vulns across 19 prod packages).

### Top 3 beta blockers

1. **CRIT-1 — Every figure in production 404s.** `api/routers/figures.py:44` strips the `<paper_id>/` subdir with `os.path.basename`; files are written by the worker to `/app/figures/<paper_id>/<name>.png` but the handler resolves to `/app/figures/<name>.png`. Verified live: file exists on the subdir path, absent on the flat path.
2. **CRIT-2 — Supabase auth bypass on missing secret.** `supabase_jwt_secret` defaults to `""` (config.py:33) and `jwt.decode(token, "", algorithms=["HS256"])` accepts any attacker-forged HS256 token signed with empty key. An operator deploying `AUTH_PROVIDER=supabase` without setting the secret gets silent account takeover.
3. **HIGH-1 — Retry poisons the corpus.** `chunks` has no `UNIQUE (paper_id, chunk_index)` (init.sql:68-80), so any Celery retry of `process_paper` after the chunk insert step duplicates the entire paper's embeddings, degrading search quality and doubling HNSW storage.

## Critical

### CRIT-1 — `api/routers/figures.py:44` — flat path strip 404s every figure

`os.path.basename(row["image_path"])` drops `<paper_id>/` from stored path. Worker writes to `/app/figures/<paper_id>/fig_pN_K.png` (`worker/lib/pdf_extractor.py:275`, `ingestion_tasks.py:241`). Handler reconstructs `Path(figures_dir) / filename` which resolves to `/app/figures/fig_pN_K.png` — nonexistent.

Verified live: `ls /app/figures/3ad58fb9-.../fig_p18_0.png` → exists; `ls /app/figures/fig_p18_0.png` → no such file.

Quote (figures.py:44,47):
```python
filename = os.path.basename(row["image_path"])
...
full_path = Path(settings.figures_dir).resolve() / filename
```

**Fix:** Resolve with the paper subdir: `full_path = (Path(settings.figures_dir).resolve() / paper_id / filename).resolve()`, then keep the existing `relative_to(base)` escape check. Also sanitize `paper_id` and `filename` for `..` before the join.

### CRIT-2 — `api/auth/providers.py:112-117` + `api/config.py:33` — empty JWT secret accepts forged tokens

`jwt.decode(token, settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated")` where `settings.supabase_jwt_secret: str = ""` validates any HS256 token signed with the empty string. The handler then upserts on `clerk_id`, which ON CONFLICT maps an attacker-chosen `sub` to any existing local user.

Quote (providers.py:112-115):
```python
payload = jwt.decode(
    token,
    settings.supabase_jwt_secret,
    algorithms=["HS256"],
```

**Fix:** Fail-closed at startup. In `main.py` lifespan (or `auth/__init__.py`), raise when `auth_provider == "supabase"` and `supabase_jwt_secret` is empty — same pattern used by `signed_url._resolve_signing_key`.

## High

### HIGH-1 — `infra/postgres/init.sql:68-80` — missing `UNIQUE (paper_id, chunk_index)` on chunks

`process_paper` has `max_retries=2`; any exception after `store_chunks_batch` (e.g. transient DB error on the final status update at `ingestion_tasks.py:309-314`) re-runs the pipeline and re-inserts every chunk. No dedupe key on the table → duplicate embeddings silently poison HNSW and tsvector search.

Quote (init.sql:68-80): `CREATE TABLE chunks (...chunk_index INTEGER NOT NULL, ...)` — no UNIQUE.

**Fix:** Migration: `ALTER TABLE chunks ADD CONSTRAINT chunks_paper_chunk_idx_uq UNIQUE (paper_id, chunk_index)`. Then change `worker/lib/db.py:189-193` to `INSERT ... ON CONFLICT (paper_id, chunk_index) DO UPDATE SET ...`. Also emit `DELETE FROM chunks WHERE paper_id = $1` at the top of the chunking stage so a retry starts clean.

### HIGH-2 — `worker/lib/settings.py:119-123` — per-user LLM keys race via `os.environ`

`apply_provider_settings` writes each user's API keys to `os.environ`; `claude_client.py:25`, `embedder.py:24-26`, `figure_describer.py:32` re-read env at call time. Concurrent Celery tasks for different users overwrite each other's keys → user A's Claude call billed to user B.

Quote (settings.py:119-123): `with _env_lock: ... os.environ[env_var] = str(value)` — lock covers the apply, not the downstream read.

**Fix:** Thread a config dict (or `contextvars.ContextVar`) through the client callers. `apply_provider_settings` returns a resolved config object; each LLM/embed client takes `config=` explicitly rather than reading `os.getenv` at call time.

### HIGH-3 — `api/routers/papers.py:86-89` — blocking file I/O stalls the event loop

`with open(file_path, "wb") as f: f.write(contents)` inside `async def upload_paper` for up to 50MB. Single upload blocks every other in-flight API request on the same uvicorn worker for the duration of the write. `os.path.exists` / `os.remove` on the delete path are the same shape.

Quote (papers.py:87-89):
```python
with open(file_path, "wb") as f:
    f.write(contents)
```

**Fix:** `await asyncio.to_thread(_write_bytes, file_path, contents)` or use `aiofiles`. Same for `os.makedirs`, `os.path.exists`, `os.remove` in the delete path.

### HIGH-4 — `worker/tasks/persona_tasks.py:759-764` — `regenerate_post` read-modify-write without lock or user scope

Reads `feeds.posts`, mutates one index in Python, writes whole JSONB back with `UPDATE feeds SET posts = $1 WHERE id = $2`. Two concurrent regenerates (or regenerate racing an `append_to_feed_id` generate) lose one update. UPDATE also lacks the `user_id = $N` scope the SELECT uses, so a buggy dispatcher could write any feed by id.

Quote (persona_tasks.py:759-764):
```python
posts[post_index] = post_data
posts_json = json.dumps(posts, default=str)
await conn.execute("UPDATE feeds SET posts = $1 WHERE id = $2", posts_json, feed_id)
```

**Fix:** Either wrap in `SELECT ... FOR UPDATE` inside a tx, or use `jsonb_set` (same pattern as `api/routers/feed.py:173-186` for `delete_post`). Add `AND user_id = $3` to the UPDATE.

### HIGH-5 — `api/routers/replies.py:189-433` — `create_reply` RMW drops concurrent replies

`create_reply` SELECTs `post_replies.messages`, appends in-memory, then overwrites the full JSONB. Double-submit or two-tab scenario: both POSTs read the same base, the later-resolving write wins, the earlier user message + persona response vanish.

Quote (replies.py:189-192, 430-433):
```python
row = await db.fetchrow("SELECT id, messages FROM post_replies WHERE feed_id = $1 AND post_index = $2", ...)
...
await db.execute("UPDATE post_replies SET messages = $1, updated_at = NOW() WHERE id = $2", messages_json, reply_id)
```

**Fix:** Serialize via `SELECT ... FOR UPDATE` inside a transaction, or move to append-style: `UPDATE post_replies SET messages = messages || $1::jsonb WHERE id = $2`.

### HIGH-6 — `frontend/src/components/Messages/PaperChat.tsx:91-97` — polling ignores `status === 'error'` → infinite spinner

Poll handler only breaks on `complete`; any other status (including the server's `error` branch at `api/routers/messages.py:196-198`) reschedules the poll. User sees a forever-spinning summary with no recourse. The backend-side retry has already given up, but the UI keeps trying.

Quote (PaperChat.tsx:91-97):
```tsx
if (status.status === 'complete') {
  const updated = await getPaperSummary(paperId)
  setSummary(updated)
  setLoading(false)
} else {
  timeoutRef.current = setTimeout(poll, 2000)
}
```

**Fix:** Add `else if (status.status === 'error') { setSummary({...summary, status: 'error', error: status.error}); setLoading(false); return }` and surface an error UI + retry button. Mirror the pattern in `useFeed.pollStatus`.

### HIGH-7 — `api/routers/settings.py:141-147` — unbounded `posts_per_generation` → runaway LLM spend

`SettingsUpdate.settings: dict` accepts any value for any allowed key. `ALLOWED_SETTINGS_KEYS` is a name allow-list only — no numeric bounds. Set `posts_per_generation: 10000` → `plan_feed_posts` loops ~10,000 Claude calls per generation. Combined with `auto_generate_on_upload: true`, one upload fans out that many calls.

Quote (settings.py:141-147):
```python
for key, value in body.settings.items():
    if key in ALLOWED_SETTINGS_KEYS:
        filtered[key] = value
```

**Fix:** Change `ALLOWED_SETTINGS_KEYS` from a set to a `dict[str, tuple[type, min, max]]`. Reject out-of-range values with 422. Minimum bounds to start: `posts_per_generation: (int, 1, 50)`, `persona_temperature: (float, 0.0, 1.5)`, `chunk_max_tokens: (int, 100, 4000)`.

### HIGH-8 — `api/routers/personas.py:59-61` — `PersonaDmRequest.message` has no `max_length`

Every other LLM-facing body (`UserPostCreate`, `ReplyRequest`) caps user input. `message` goes directly into the persona DM prompt → Claude/Ollama. At 60 DMs/day (rate limit), a user can ship 60 × (multi-MB) input tokens.

Quote (personas.py:59-61):
```python
class PersonaDmRequest(BaseModel):
    message: str
```

**Fix:** `message: str = Field(max_length=2000)` to match `ReplyRequest.user_message`.

### HIGH-9 — `worker/tasks/alert_tasks.py:67-115` — `check_contradictions` scales O(papers × 3 LLM calls)

Auto-dispatched from `process_paper` (`ingestion_tasks.py:321-327`). Selects every other complete paper in the corpus (no LIMIT), then runs 3 contradiction classifications per pair. 200-paper workspace → 600 Claude calls per upload. User has no opt-out.

Quote (alert_tasks.py:67-71):
```python
other_papers = await conn.fetch("""SELECT id, title, filename FROM papers
  WHERE corpus_id = $1 AND id != $2 AND status = 'complete'""", ...)
```

**Fix:** Cap: `LIMIT 8` in the SELECT, or `random.sample(other_papers, min(8, len(other_papers)))` before the pair loop. Upload cost is bounded regardless of corpus size.

### HIGH-10 — `frontend/src/App.tsx:436-438` — TL;DR refetch every 2s during paper processing

`useEffect(() => { getPaperTldrs().then(...) }, [corpus.papers])`. `useCorpus.refresh` produces a fresh array on every 2s poll while any paper has `status !== 'complete'`. The TL;DR endpoint reads all of `paper_summaries` for the user (`api/routers/messages.py:82-96`) every 2 seconds for the duration of the processing.

Quote (App.tsx:436-438):
```tsx
useEffect(() => {
  getPaperTldrs().then(data => setPaperTldrs(data.tldrs || {}))
}, [corpus.papers])
```

**Fix:** Depend on a stable derived key:
```tsx
const completeIds = useMemo(
  () => corpus.papers.filter(p => p.status === 'complete').map(p => p.id).sort().join(','),
  [corpus.papers]
)
useEffect(() => { getPaperTldrs().then(...) }, [completeIds])
```

## Playwright failures

Ran `tests/e2e/review.spec.ts` (7 scenarios covering brief's core flows) on desktop 1280×800 and mobile 390×844.

- **Desktop:** 5 passed, 2 skipped (R-04 workspace dropdown early-returns at `<2` workspaces; R-07 sign-out hidden under `AUTH_PROVIDER=none`). No failures.
- **Mobile:** 4 passed, 2 skipped, 1 failed (R-02 `button[aria-label^="Replies"]` not visible within 15s at 390px). Classified as **test-premise, not a HIGH finding**: the Reply button exists and is rendered identically across viewports (`PostCard.tsx:703`); the mobile viewport just doesn't land on a FeedPost on first paint (Archivist pending placeholder fills the visible region). Users can scroll to reach it — the flow is not blocked. Fixing this is a Playwright scroll-into-view tweak, not a product bug.

No flow-blocking Playwright failures at HIGH+ severity.

## Dropped during dedup

1 finding dropped: performance-reviewer's blocking-I/O report was identical to bug-hunter's `papers.py:88-89` — merged as HIGH-3.
