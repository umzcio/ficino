# TS Port 05 — Reading Lists and Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the last two product slices and close the carried items:
- the `/reading-lists` routes, the `propose_ordering` job and the `generate_chapter` job, with the figure-slot bug
  fixed and pinned;
- the ElevenLabs `speak` provider (single-voice TTS and the one-call dialogue), the `generate_audio_for_feed` and
  `generate_podcast_for_feed` jobs, `POST /feed/{id}/audio` and `/podcast`, media on local disk under
  `{MEDIA_DIR}/feeds/{feed_id}/`, audio URLs the unchanged frontend can play, and `/media` byte ranges;
- the carry items: a shared `isUuid`, one source for the retry policy, distinct-model assertions,
  `deleteFeedMedia` on every feed delete path, the group-chat stuck check and the Archivist follow-up dead end.

After this plan every route in C §1 is served by the TS API and every queue in `src/jobs/registry.ts` has a
handler.

**Architecture:**

*Reading lists.* One router (`src/routes/readingLists.ts`) and one SQL helper module
(`src/readingLists/chapters.ts`) that the router and the worker share, as Python shared `CHAPTER_INSERT_SQL`. The
ordering prompt, its parser and its validation are pure functions in `src/readingLists/ordering.ts`; the chapter's
system-prompt suffix and post finishing are pure functions in `src/readingLists/chapter.ts`. Both are pinned to
goldens produced by the real Python. The two handlers live in `src/tasks/readingLists.ts` and reuse plan 03's
persona, prompt, retrieval, slot and index code.

*Audio.* `src/providers/speak.ts` is the only code that talks to ElevenLabs. It goes through `deps.fetch`, like
every other provider, so the test fakes see each call. Feed audio is one file per post (a playlist, as in Python).
The podcast is **one** `text-to-dialogue` call producing **one** file. The pure script builder lives in
`src/audio/podcast.ts`; the speech-text and claim helpers in `src/audio/feedAudio.ts`; both handlers in
`src/tasks/audio.ts`. The API never writes `audio_status`/`podcast_status`; the worker claims them. GET
`/feed/{id}` prefixes the signed media URLs with the public API base, and `/media` answers byte ranges.

*Carry items.* Small, separate fixes in the files they belong to, each with its own test.

**Tech Stack:** Plans 01–04 dependencies only. **No new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-29-typescript-port-design.md`. Reference abbreviations:
- **C §x** is `ts-port-reference/api-contract.md`.
- **W §x** is `ts-port-reference/worker-inventory.md`.

The carry-forward docs are the four `2026-1*-ts-port-0[1-4]-carryover.md` files; this plan takes every
"Carry into plan 05" item from them except the future reprocess endpoint, which it defers to plan 06 (see the
table after Task 12). Where this plan says "port X", the
Python file it names is the source of truth for every string, number, branch and SQL statement this plan doesn't
pin. Read it. The Python sources are:

| Area | Python file |
|---|---|
| Reading-list routes and `REORDER_CHAPTER_INSERT_SQL` | `api/routers/reading_lists.py` |
| Request models | `api/models/requests.py:97-112` |
| `CHAPTER_INSERT_SQL` | `shared/ficino_shared/constants.py:26-38` |
| Ordering and chapter jobs | `worker/tasks/reading_list_tasks.py` |
| Feed audio and podcast jobs | `worker/tasks/audio_tasks.py` |
| ElevenLabs client and voices | `worker/lib/tts.py` |
| Podcast script | `worker/lib/podcast.py` |
| Audio routes | `api/routers/feed.py:327-410` |
| Persona prompt (figure branch) | `worker/lib/persona.py:371-640` |

## Global Constraints

- **Workspace.** Work on branch `ts-port/05-reading-audio` in the worktree `<worktree>`, based on
  plan 04's head (`56e7fc6` or later). Never modify `api/`, `worker/`, `shared/`, `frontend/` or `tests/e2e/`. You
  may read them and run them inside the `ficino-api` and `ficino-worker` images to make goldens (see
  `server/test/fixtures/goldens/gen/README.md`). Run `npm ci` in `server/` first. Baseline before Task 1:
  `npx vitest run` gives 92 test files and 1555 tests, all passing. Do not run eslint (its config is broken).
- **Public repository.** No private paths, host names, real user ids, API keys or private paper content in any
  file, log line or fixture. Goldens use synthetic text only. Scratch output goes under `$SCRATCH` (any directory
  outside the repo).
- **Earlier plans' rules still apply:**
  - Code: ESM, strict TS, NodeNext (relative imports end in `.js`), everything in `server/`.
  - SQL: parameterized only (`sql.unsafe` only for catalog identifiers). jsonb writes go through `sql.json(...)`;
    appends use `col || ${sql.json(arr)}`, never a read-modify-write. postgres.js already parses jsonb; never
    double-parse. COUNT columns are cast `::int`.
  - Literals: wire literals copied exactly from Python, including every `detail` string and log event name.
  - Nothing reads `process.env` after boot. New env goes through `Config` (`loadConfig`).
  - No module-level mutable state. Randomness through the injected `Rng`.
  - Router mounting: never mount a router at `/` with `use('*', requireUser)`. Each router's first line is
    `r.use('*', requireUser)`.
  - Validation order: a route's rate-limit middleware runs before its validators. A charge that Python makes only
    on the dispatch branch uses `chargeUserRateLimit(c, prefix)`.
  - New int path params use `pyInt` and must match the param-fill regex in `test/api/routes-auth.test.ts`.
  - Audit after the main write, never inside a transaction (`recordAudit`).
  - Handlers return plain objects, never a lone `{ value: x }`.
  - Commits are authored as `umzcio <umzcio@users.noreply.github.com>` and end with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Python strings.** Every `[:N]` cap is a code-point slice (`pySlice`); `len()` is `pyLen`; `str.strip()` is
  `pyStrip`; an f-string that may print `None` uses `pyStr`; `str.title()` is the new `pyTitle` (Task 6). Python's
  `sorted()` of strings is code-point order, not `Array.prototype.sort`'s UTF-16 order.
- **Timestamps.** Pydantic-serialized fields use `toPydanticIso` (`src/db/time.ts`).
- **Non-UUID ids.** A path or body id that cannot be a UUID answers the route's own 404 (or the empty list shape)
  where Python returned 500 on the cast. Use `isUuid` (Task 1). Plan 04 convention; not repeated per task.
- **The audio quality bar (owner).** Dialogue audio is ONE continuous render. The podcast is exactly one
  ElevenLabs `POST /v1/text-to-dialogue` call whose response is saved as one file,
  `feeds/{feed_id}/podcast/episode.mp3`. No code path may split a script across several calls, concatenate audio,
  or write per-segment files. A script over the dialogue cap fails the podcast; it is never split. Python already
  works this way (`worker/lib/podcast.py`, `audio_tasks.py:444`), so this is parity, not a deliberate change. Feed
  audio stays one file per post, as in Python: `ListenView` plays them as a playlist with a hard cut between posts.
  That is a port, not an endorsement. The owner's rule says stitched per-clip TTS with hard cuts reads as broken, so
  the Task 12 carryover and the controller's report-back put it to the owner as a decision for the frontend redo.
  Until then no paid per-clip render runs by default: the Task 12 smoke renders only the podcast unless
  `SMOKE_FEED_AUDIO=1` is set; tests use fakes.
- **ElevenLabs.** The key is operator env only (`ELEVENLABS_API_KEY` → `config.elevenlabsApiKey`), never a user
  setting. Tests use fakes; no test touches the network. The only real call is the optional smoke in Task 12.
- **Real LLM checks** use this host's Ollama on `127.0.0.1:11434`. **No new listeners or ports.**

## Deliberate changes from Python (each pinned by a test)

1. **A chapter's figure slot no longer fails the chapter** (spec "Known bugs"). `generate_chapter` loads the
   scope's figures once and treats each planned `figure` slot exactly as `generate_feed` does: `pickFigure`, and
   `'skip'` drops the slot with `figure_post_skipped_no_figures_in_paper` or
   `figure_post_skipped_no_eligible_figure`; otherwise the figure goes to `buildPostPrompt` and `attachFigure`.
   Python passed `figure` to `build_post_prompt` without a figure, outside the slot `try`, so about 61% of default
   chapters failed. `buildPostPrompt` itself stays outside the slot `try`, as in Python, so any other throw from it
   (a persona missing from `personas`) still fails the chapter and pg-boss retries it. Task 4.
2. **A chapter whose every in-scope chunk was embedded with another model fails loudly**, with `generate_feed`'s
   message (plan 03 deliberate change 2), instead of completing with an empty feed. Task 4.
3. **The chapter's feed upsert, its `complete` mark and the next chapter's unlock run in one transaction**; the
   `feed_posts` index write follows the commit and stays non-fatal. Python ran four separate statements. Task 4.
4. **`generate_chapter`'s owner is `user_id || list.user_id || STUB_USER_ID`.** Python's
   `str(rl["user_id"])` made a NULL owner the string `"None"`. Task 4.
5. **`propose_ordering` reads the papers `ORDER BY array_position(${paper_ids}::uuid[], p.id)`**, so the prompt and
   the id-mismatch fallback follow the list's order. Python had no `ORDER BY` (heap order). Task 3.
6. **Feed audio and podcasts work on local storage** (spec). Python's local backend raised `NotImplementedError`,
   so the jobs always ended `failed`. Task 6 and Task 7.
7. **Media URLs carry the public API base.** `GET /feed/{id}` returns `audio_url` and `podcast_audio_url` as
   `${config.publicApiBase}/media/feeds/...?token=...` (`PUBLIC_API_BASE`, default `/ficino/api`, the frontend's
   `VITE_API_BASE` default), because `ListenView` assigns them to `audio.src` as-is. The signed resource and the
   storage key stay prefix-free. Python's Supabase URLs were absolute. Task 9.
8. **`/media` serves single byte ranges** (206, 416, `Accept-Ranges: bytes`), so Safari can play and every browser
   can seek. Task 9.
9. **Every feed delete path removes `{MEDIA_DIR}/feeds/{feed_id}/`.** Python left the Supabase objects behind.
   `deleteFeedMedia` becomes a no-op on a non-UUID, like `deletePaperArtifacts`. Task 9.
10. **Group chats get a stuck check, and `POST /messages/groups` no longer overwrites a row the worker already
    wrote** (`ON CONFLICT (id) DO NOTHING`). Task 10.
11. **An Archivist follow-up whose job is gone can be retried.** A follow-up may retry an `error` post whose job
    will never run again, replacing its trailing user turn; `GET /user-posts/{id}/status` marks a `pending` post on
    a lost job `error`, and clears the `task_id` of an `error` post whose job is `failed`, `cancelled` or `missing`
    (a final attempt that was hard-killed before its catch ran); the Archivist's error mark is scoped to its own job
    and clears `task_id` on the final attempt; a redelivered follow-up whose answer is already stored is an
    idempotent skip. A failed **first** answer (`replies = []`) stays a dead end, as in Python (carryover). Task 11.
12. **Per-post `audio_error` stages name the TS error class** (`http_<status>_voice_<id>` is unchanged;
    `exception_NetworkError`, `exception_TimeoutError`, `fallback_HttpStatusError`, `upload_Error`), where Python
    printed `httpx` class names. The detail after the stage is the TS error's `message` (`HTTP 401: <body[:200]>`,
    `network error: …`), not httpx's `str(exc)`; a fallback failure's ` body=` suffix is the HTTP body for an
    `HttpStatusError` and empty for anything else, as Python's `fb_body = ""`. The frontend never reads them. Task 6.
13. **`POST /feed/{id}/audio|podcast` re-dispatches a dead claim.** Python relied on Celery's `task_acks_late`
    redelivery to rerun a SIGKILLed audio job, whose claim `UPDATE` then took over the stale `generating` row. The
    audio queues have `retryLimit: 0`, so pg-boss fails an expired audio job instead of redelivering it (its
    expiry takes the same fail path as a throw, which retries only while `retry_count < retry_limit`; the
    `propose_ordering` and `generate_chapter` queues, `retryLimit: 2`, do get an expired job redelivered). Nothing
    else reruns a dead audio job, so the route takes that role: a
    `generating` row whose `<col>_claimed_at` is NULL or older than `reclaimMinutes(config.jobTimeLimitSec)` is
    charged and dispatched exactly like a NULL or `failed` one. The handler's claim makes a double dispatch safe.
    Task 8.
14. **A podcast whose every in-scope chunk was embedded with another model fails** with `generate_feed`'s message,
    before any LLM or ElevenLabs spend, and a partial mismatch logs `embed_model_mismatch`. Python had no model
    filter in `retrieve_chunks`; the TS filter (plan 03 deliberate change 2) would otherwise render and charge an
    ungrounded episode with `(no retrieved chunks)`. Task 7.
15. **ElevenLabs timeouts are total deadlines.** Python's httpx `timeout=30.0` / `180.0` are per-phase (connect,
    read, write); `fetchBytes` uses one `AbortSignal.timeout` over the whole request, as `fetchJson` does. Both
    endpoints answer only after the render is done and then send one small mp3, so the wait for the response is
    the whole budget either way; the total cap is slightly stricter. Task 5.
16. **A job abort (the time limit) is never a per-post or per-slot failure.** Celery's `SoftTimeLimitExceeded`
    subclasses `Exception`, so in Python a time limit inside an ElevenLabs call was caught by
    `_synthesize_with_fallback`'s generic `except Exception`, recorded as `exception_SoftTimeLimitExceeded`, and the
    loop went on, so the feed could still end `audio_status = 'ready'`; inside a chapter slot it was logged as
    `chapter_post_failed` and the chapter could still commit `complete` with the post missing. In TS every per-post
    catch in feed audio and every chapter slot catch rethrows when `ctx.signal.aborted`, and both handlers call
    `ctx.signal.throwIfAborted()` after their loop, so the feed ends `failed` and the chapter is not committed (the
    same convention as `generate_feed`'s slot catch). Pinned by the Task 6 abort tests and the Task 4 last-slot
    abort test.
17. **Audio input edges.** (a) The podcast's owner-settings load runs inside the job's failure catch, so a settings
    failure ends `podcast_status = 'failed'`; Python called `apply_provider_settings` before its `try`, which left
    the row `generating` until the reclaim window passed. (b) A NULL `feeds.user_id` reads `STUB_USER_ID`'s settings
    (`user_id ?? STUB_USER_ID`, as deliberate change 4); Python passed the string `'None'`. (c) Feed audio fails on a
    non-array `posts` with `feed posts is not a list`; Python failed on a non-empty object (an `AttributeError` on
    its first key) but ended `ready` with nothing rendered on `{}`. The podcast keeps Python's coercion of a
    non-array `posts` to `[]`. Tasks 6 and 7.

Kept on purpose (parity, recorded in the carryover): ElevenLabs calls are not retried; the dialogue cap is
Python's 2000 code points; `regenerate_post` drops a post's `audio_key` while `audio_status` stays `ready`;
`apply-ordering` drops client rationale text; an ordering fallback stores empty rationales, so the frontend's
2-minute ordering wait ends in its Retry state; a failed first Archivist answer cannot be retried; feed audio is a
per-post playlist with hard cuts (an owner decision, see the Task 12 carryover); a `posts` item that is not a JSON
object (`null`, a string, a number, a boolean, an array) fails the whole feed-audio job when the loop reaches it,
as Python's `post.get` `AttributeError` did (Task 6), while the podcast's helpers skip such items, as Python's
`isinstance(post, dict)` guards do (Task 7).

## Review Focus

1. **A podcast is never stitched.** Whatever the LLM returns (many turns, very long turns, garbage), the episode is
   exactly one `text-to-dialogue` call and one `episode.mp3`, with no `text-to-speech` call and no other file under
   `podcast/`. A script over 2000 code points throws `DialogueTooLongError` before any HTTP call and the podcast
   ends `failed` (reached in Task 7 through the fallback script with a very long persona key). Pinned in Tasks 5
   and 7.
2. **Listen works in the unchanged frontend, Safari included.** The URLs from `GET /feed/{id}` start with
   `/ficino/api/media/`, and the same URL with that prefix stripped (what nginx forwards) plays. `Range: bytes=0-1`
   returns 206 with 2 bytes; `bytes=-5` returns the last 5; a range past the end is 416; HEAD carries
   `content-length`. Pinned in Task 9.
3. **No forever-spinner from a dead job.** An audio or podcast job killed before its catch ran leaves a
   `generating` row; once its claim is older than the reclaim window, `POST /feed/{id}/audio|podcast` charges and
   dispatches again, and the new job's claim takes the row over. A fresh claim is neither re-dispatched nor taken
   over. A failed or aborted render ends `failed`, never `generating` or `ready`. A group chat on a lost or failed
   job re-dispatches once. A `pending` user post on a lost job becomes `error`, and a follow-up on it can be
   retried. Pinned in Tasks 6, 7, 8, 10, 11 and the Task 12 end-to-end test.
4. **Spend is charged once, and only for real work.** `POST /feed/{id}/audio|podcast` answers 501 before anything
   else without a key; a `ready` feed or a freshly claimed `generating` one never charges (a stale claim is a real
   re-dispatch and charges once); the podcast shares the `audio` bucket; a 429
   dispatches nothing. A group chat the worker already wrote is healed without a charge, so polling never drains
   `summary`. Pinned in Tasks 8 and 10.
5. **One user never reaches another's lists, papers, feeds or media.** Creating a list with user B's papers or
   workspace is 404; generating a chapter of B's list is 404 `Chapter not found`; reorder with B's paper is 404;
   B's papers never appear in a detail; a valid media token for B's feed is 404 for A; deleting A's feeds removes
   only A's media. Pinned in Tasks 2 and 9.

---

### Task 1: Carry-over plumbing: `isUuid`, the retry limit from the job, distinct-model assertions

**Files:**
- Create: `server/src/shared/uuid.ts`, `server/test/shared/uuid.test.ts`
- Modify: `server/src/routes/{messages,replies,feed,userPosts}.ts`, `server/src/storage/local.ts`,
  `server/src/jobs/queue.ts`, `server/src/tasks/ingestion.ts`, `server/src/http/validate.ts` (rename its
  32-hex `UUID_RE` to `HEX32_RE`), `server/src/worker/main.ts`, `server/src/jobs/context.ts` (comment only)
- Test: `server/test/worker/main.test.ts` (extend), `server/test/routes/personas.test.ts`,
  `server/test/routes/replies-post.test.ts`

**Interfaces:**
- Produces in `src/shared/uuid.ts`:
  - `UUID_PATTERN: string`, the unanchored hyphenated pattern
    `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`.
  - `isUuid(v: unknown): v is string`: a string matching `^${UUID_PATTERN}$` case-insensitively.
- `MEDIA_KEY_RE` in `local.ts` is built from `UUID_PATTERN`. Every former `UUID_RE.test(x)` becomes `isUuid(x)`
  (`ids.every(isUuid)`, `.filter(isUuid)`); `checkId` becomes `if (!isUuid(id)) throw new Error('invalid id')`.
- `worker/main.ts` calls `boss.work(name, {localConcurrency, batchSize: 1, includeMetadata: true}, …)` and passes
  `job.retryLimit` to `makeJobContext`. The per-name lookup line
  (`overrides.queueOverrides?.[name]?.retryLimit ?? QUEUES[name].retryLimit`) is deleted, so `ensureQueues` is the
  only place that merges policy and overrides, and the job row (which pg-boss's own retry decision reads) is the
  source. `makeJobContext`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `uuid.test.ts`: accepts lower- and upper-case hyphenated ids. Rejects 32 hex digits without hyphens, `{…}`
    braces, `urn:uuid:…`, an id with a trailing `\n`, `''`, `null`, `123`.
  - `uuid.test.ts`, guard: read every `src/**/*.ts` file; the literal `[0-9a-f]{8}-` occurs only in
    `src/shared/uuid.ts`.
  - `main.test.ts`, a **new** test beside `passes each queue its retry limit …` (that test stays unchanged): start
    the worker with no `queueOverrides` and a recording handler for `generate_corpus_synthesis` (queue policy
    `retryLimit: 2`) that throws. Send through pg-boss directly, `boss.send('generate_corpus_synthesis', {}, { id:
    randomUUID(), retryLimit: 0 })`; this bypasses `JobQueue.send`, which takes no per-job options and writes the
    `job_progress` row the fake handler does not need. The handler sees `retryLimit 0` and `isFinalAttempt: true`
    on its first attempt, and after the job reaches `failed` no second attempt was recorded.
  - `personas.test.ts` (`Review Focus 1: concurrent DMs …`) and `replies-post.test.ts`
    (`Review Focus 1: concurrent replies …`): seed `{llm_provider: 'api', anthropic_api_key, claude_model}` with
    `('ka', 'model-a')` for user A and `('kb', 'model-b')` for user B. The setting is `claude_model`; there is no
    `anthropic_model`. For every Anthropic call, `[c.apiKey, c.model]` equals A's pair when the call carries A's
    text, else B's; and `new Set(calls.map(c => c.model))` equals `{'model-a', 'model-b'}`.
- [ ] **Step 2: Run them.** `cd server && npx vitest run test/shared/uuid.test.ts test/worker/main.test.ts
  test/routes/personas.test.ts test/routes/replies-post.test.ts`. The guard and the per-job retry case fail; the
  two Review Focus tests pass already or fail only on the new assertion.
- [ ] **Step 3: Implement.** Replace all seven `UUID_RE` copies; leave `HEX32_RE` in `validate.ts`.
- [ ] **Step 4: Run the full suite and the typecheck.** `npm test` (every malformed-id test in `messages`,
  `user-posts`, `replies`, `feed` and `media` stays green) and `npm run typecheck`.
- [ ] **Step 5: Commit** with the message
  `refactor(server): shared isUuid, retry limit from the job row, distinct-model assertions`.

### Task 2: Chapter SQL and the `/reading-lists` routes

**Files:**
- Create: `server/src/readingLists/chapters.ts`, `server/src/routes/readingLists.ts`
- Modify: `server/src/app.ts` (mount `/reading-lists`), `server/src/shared/constants.ts` (replace the
  "intentionally not ported here (plan 05)" comment with a pointer to `readingLists/chapters.ts`)
- Test: `server/test/readingLists/chapters.test.ts`, `server/test/routes/reading-lists.test.ts`

**Interfaces:**
- Produces in `src/readingLists/chapters.ts` (`db` is typed `Sql | postgres.TransactionSql`, as
  `loadStoredSettings` does, so the `sql.begin` handle typechecks):
  - `insertChapters(db: Sql | postgres.TransactionSql, listId: string, paperIds: string[]): Promise<void>`. Port of
    `CHAPTER_INSERT_SQL`:
    ```sql
    INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
    SELECT ${listId}::uuid, (row_num - 1)::int, ARRAY[pid]::uuid[],
           CASE WHEN row_num = 1 THEN 'unlocked' ELSE 'locked' END
    FROM unnest(${paperIds}::uuid[]) WITH ORDINALITY AS t(pid, row_num)
    ```
  - `insertReorderChapters(db: Sql | postgres.TransactionSql, listId: string, paperIds: string[], maxComplete: number): Promise<void>`. Port
    of `REORDER_CHAPTER_INSERT_SQL`: the index is `${maxComplete}::int + row_num`, the first new one `unlocked`.
- Produces `readingListsRoutes(): Hono<AppEnv>` (C §1.12). All behind `requireUser`. Every `created_at` goes
  through `toPydanticIso`.

  | Route | Behavior |
  |---|---|
  | `GET /?workspace_id=` | port the grouped query (`chapter_count`, `completed` as `::int`), `ORDER BY rl.created_at DESC`, **no LIMIT**; filter on `corpus_id` only when `workspace_id` is truthy; a non-UUID filter gives `[]`; items `{id, name, paper_count: paper_sequence.length, chapter_count, completed_chapters, rationale, created_at}` |
  | `GET /:list_id` | 404 `Reading list not found`; papers re-scoped to the owner with `id = ANY(...)`, output in sequence order, foreign or deleted ids dropped, each `{id, title: title \|\| filename, authors: authors ?? [], year, rationale}` (Python's `or`: an empty title falls back to `filename`) where `rationale` is taken from the first rationale entry whose `paper_id` equals the id (string-exact) as `Object.hasOwn(r, 'rationale') ? r.rationale : ''` (Python's `r.get("rationale", "")`, so a stored `null` stays `null`), and is `''` without an entry; chapters ordered by `chapter_index` as `{id, chapter_index, paper_ids, feed_id, status}` (no `created_at`); response `{id, name, corpus_id, papers, chapters, created_at}` |
  | `POST /` | **201**; the order below |
  | `PUT /:list_id/reorder` | the order below; `{status: 'reordered'}`; log `reading_list_reordered` |
  | `PUT /:list_id/apply-ordering` | the order below; `{status: 'applied'}`; log `ai_ordering_applied` |
  | `POST /:list_id/chapters/:chapter_index/generate` | **202**; the order below |
  | `DELETE /:list_id` | 404 `Reading list not found` when nothing was deleted; **204**; then audit `reading_list.delete`, `reading_list`, resource id `list_id`, status 204; chapter feeds stay |

- `POST /` runs in this order:
  1. `userRateLimit('feed_generation')`.
  2. `body({name: z.string(), corpus_id: z.string().nullish(), paper_ids: z.array(z.string()).nullish()})`.
  3. A truthy `corpus_id` must be an owned corpus, else 404 `Workspace not found`.
  4. A **non-empty** `paper_ids` (an empty list falls through, as Python's falsy check): any non-UUID, or an owned
     count (`id = ANY(...)`, `::int`) other than `paper_ids.length`, gives 404 `One or more papers not found`
     (duplicates 404 this way); no status check. Else a truthy `corpus_id` takes the owner's `complete` papers of
     that corpus `ORDER BY uploaded_at`. Else 400 `Provide paper_ids or corpus_id`.
  5. Fewer than 2 gives 400 `Need at least 2 papers for a reading list`.
  6. `sql.begin`: insert `reading_lists (user_id, corpus_id, name, paper_sequence)` `RETURNING id`, with
     `corpus_id || null` (a falsy `corpus_id` such as `""` stores NULL, as `userPosts.ts` does, where Python's
     uuid cast of `""` was a 500), then `insertChapters(tx, id, paperIds)`. `rationale` keeps its default `[]`.
  7. After commit, `queue.send('propose_ordering', {paper_ids, list_id, user_id})`. No try (a send failure is a
     500 after the row exists, as in Python).
  8. Log `reading_list_created {list_id, papers, task_id}`; respond `{id, task_id, paper_count}`.
- `PUT /:list_id/reorder`: `body({paper_sequence: z.array(z.string())})`; 404 `Reading list not found`. When the
  sequence is non-empty: duplicates give 422 `{"detail": "Duplicate paper IDs in sequence"}` (a plain detail
  string); any non-UUID or an owned count other than the distinct count gives 404 `One or more papers not found`.
  An empty sequence skips both checks. Then `sql.begin`: set `paper_sequence`; delete the chapters with
  `feed_id IS NULL`; `maxComplete = COALESCE(MAX(chapter_index), -1)` over `complete` chapters; when
  `seq.slice(maxComplete + 1)` is non-empty, `insertReorderChapters(tx, id, rest, maxComplete)`. No permutation
  check, rationale untouched (Python quirks).
- `PUT /:list_id/apply-ordering`: `body({ordered_papers: z.array(z.object({paper_id: z.string()}))})`; 404
  `Reading list not found`; empty gives 400 `No ordering data`; duplicates give 422
  `Duplicate paper IDs in ordering`; a set unequal to the stored sequence (string compare against the lowercase
  stored ids) gives 400 `Ordering must be a permutation of the existing paper list`. Then `sql.begin`: set
  `paper_sequence` and `rationale = [{paper_id}, …]` (client rationale text is dropped, as Python's `model_dump`
  did); delete **all** chapters; `insertChapters`.
- `POST /:list_id/chapters/:chapter_index/generate`: `userRateLimit('feed_generation')`, then
  `params({chapter_index: pyInt})`. A list not owned (or a non-UUID id) and a missing chapter both give 404
  `Chapter not found`; a `locked` chapter gives 400 `Chapter is locked. Complete prior chapters first.`;
  `unlocked` and `complete` both dispatch `queue.send('generate_chapter', {reading_list_id, chapter_index,
  user_id})`. Log `chapter_generation_dispatched {list_id, chapter, task_id}`; respond `{task_id, status:
  'queued'}`. The frontend polls `GET /feed/status/{task_id}`, which already maps any queue.

- [ ] **Step 1: Write the failing tests.**
  - `chapters.test.ts`, against the DB (ports `test_constants.py::test_chapter_sql_encodes_first_unlocked`):
    three ids give chapters 0, 1, 2 with statuses `unlocked, locked, locked` and `paper_ids` `[[id0], [id1],
    [id2]]`; `insertReorderChapters(…, [x, y], 1)` gives indexes 2 and 3, `unlocked` then `locked`.
  - `reading-lists.test.ts`. These port the nine `test_reading_lists.py` tests, the four reading-list tests of
    `test_idor_followups.py`, and the three `test_wave3_correctness.py` reorder/apply tests.
    - List: scoped to the caller; filtered by `workspace_id`; `workspace_id=nope` gives `[]`; counts are numbers;
      `created_at` ends in `Z`.
    - Detail: user B gets 404; a sequence holding one of B's papers lists only A's; `title` falls back to
      `filename` both when it is NULL and when it is `''`; `rationale` is `''` without an entry, `''` for an entry
      without a `rationale` key, and `null` for an entry whose `rationale` is `null`; chapters carry no
      `created_at`.
    - Create: from `paper_ids` (201, `paper_count` 2, chapters 0 `unlocked` and 1 `locked`, and a `job_progress`
      row on `propose_ordering` whose job data is `{paper_ids, list_id, user_id}`); from `corpus_id` (only
      `complete` papers, in upload order); `paper_ids: []` with a `corpus_id` uses the corpus; `corpus_id: ""` with
      two `paper_ids` gives 201 and a list whose `corpus_id` is NULL; B's paper id 404
      `One or more papers not found`; B's corpus 404 `Workspace not found`; a duplicate id 404; a non-UUID id 404;
      neither field 400; one paper 400.
    - Reorder: updates `paper_sequence`; a duplicate gives 422 `Duplicate paper IDs in sequence`; B's paper 404;
      B's list 404. With chapters 0 and 1 `complete` (feed set) and 2 `locked`, the sequence `[p0, p1, p3, p2]`
      keeps 0 and 1 and inserts index 2 `unlocked` for `p3` and 3 `locked` for `p2`. An empty sequence deletes
      every chapter without a feed.
    - Apply-ordering: a valid permutation gives `applied`, rationale `[{paper_id}]` only (client `rationale` text
      dropped), all chapters rebuilt (a `complete` one included); a foreign paper id gives 400; a duplicate gives
      422 `Duplicate paper IDs in ordering`; a malformed body (`{ordered_papers: [{}]}`) gives 422 with the
      pydantic shape; an empty list gives 400 `No ordering data`.
    - Chapter generate: `unlocked` gives 202 `{task_id, status: 'queued'}` and a `generate_chapter` job; `locked`
      gives 400; index 9 gives 404 `Chapter not found`; B's list gives 404 `Chapter not found`; `/chapters/x/…`
      gives 422.
    - Delete: 204 and an audit row `reading_list.delete`; the chapter feed row still exists; B gets 404.
    - Rate limit: under `authProvider: 'basic'` with `rateLimits.feed_generation: 1`, a create then a chapter
      generate is 429 (the bucket is shared), and a create whose body is invalid still uses the slot.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement and mount.**
- [ ] **Step 4: Run the full suite** (`routes-auth.test.ts` must see the new routes gated) **and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): /reading-lists routes and the shared chapter SQL`.

### Task 3: `propose_ordering`

**Files:**
- Create: `server/src/readingLists/ordering.ts`, `server/src/tasks/readingLists.ts`,
  `server/test/fixtures/goldens/gen/reading_list_ordering.py`,
  `server/test/fixtures/goldens/reading-list-ordering.json`
- Modify: `server/src/worker/handlers.ts`, `server/test/helpers/fakeProviders.ts`,
  `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/readingLists/ordering.test.ts`, `server/test/tasks/propose-ordering.test.ts`

**Interfaces:**
- Consumes: `insertChapters` (Task 2); `loadJobSettings`, `generateText`, `fenceUntrusted`, `pySlice`, `pyStr`.
- Produces in `src/readingLists/ordering.ts` (port of `reading_list_tasks.py:27-218, 447-490`):
  - `type OrderingRow = { id: string; title: string | null; authors: string[] | null; year: number | null; filename: string | null; chunks: string[] }`
  - `type OrderingPaper = { paper_id: string; title: string | null; authors: string; year: number | string; preview: string }`
  - `orderingContext(rows: OrderingRow[]): OrderingPaper[]`. Preview: each chunk `pySlice(c, 0, 200)`, joined with
    `' '`, then `pySlice(…, 0, 500)`. `title || filename` (Python's `or`: an empty title falls back; an empty
    title with a NULL filename gives null, which prints `None`). `authors` is
    `', '`-joined, or `Unknown` when null or empty. `year` is the year, or `Unknown` when null or 0.
  - `ORDERING_USER = 'Analyze these papers and propose the optimal reading order. Return JSON only.'`
  - `orderingSystemPrompt(papers: OrderingPaper[]): string`. The rendered `ORDERING_SYSTEM` (Python `{{`/`}}` become
    single braces) with its one `{papers}` placeholder replaced literally, as `str.format` does:
    `tpl.replace('{papers}', () => text)`. A string replacement argument would expand `$&`, `` $` `` and `$'`
    inside untrusted titles and previews. Each paper renders as
    `` `Paper ID: ${id}\nTitle: ${fence(pyStr(title))}\nAuthors: ${fence(authors)} (${pyStr(year)})\nContent preview: ${fence(preview)}` ``,
    joined by `\n\n`, where `fence` is `fenceUntrusted`.
  - `parseOrderingJson(text: string): Record<string, unknown>[]`. Port of `_parse_ordering_json`:
    1. `JSON.parse(text)`; **if it parses at all, return `coerceOrdering(parsed)`**, even when that is `[]`.
    2. Else the first fenced block, `` /```(?:json)?[PY_WS]*\n?([\s\S]*?)```/ `` built with `PY_WS`; if its group
       parses, return `coerceOrdering`.
    3. Else the greedy `/\[[\s\S]*\]/` span; if it parses, `coerceOrdering`; else `[]`.

    `coerceOrdering(v)`: an array keeps its plain-object items; an object takes the first of the keys `ordering`,
    `papers`, `result`, `data` whose value is an array, and keeps its plain-object items; anything else is `[]`.
  - `type OrderedPaper = { paper_id: unknown; position: unknown; rationale: unknown; title: string | null; authors: string; year: number | string }`
  - `validateOrdering(papers: OrderingPaper[], items: Record<string, unknown>[]): { ordered: OrderedPaper[]; mismatch: { missing: string[]; extra: unknown[] } | null }`.
    Python's `dict.get(key, default)` is ported by **key presence**, never by `??`: `get(item, k, d)` is
    `Object.hasOwn(item, k) ? item[k] : d`, so an explicit JSON `null` stays `null` (Python's `None`).
    The returned ids are a **set**, as in Python: `get(item, 'paper_id', '')` per item (a `null` id is a set member
    and lands in `extra` as `null`); an array or object `paper_id` throws `TypeError: unhashable type: 'list'` /
    `'dict'`. A set unequal to the input set gives the fallback (input order, `position` = 0-based index,
    `rationale: ''`) and `mismatch` (first 5 of each). An equal set (duplicates pass) maps each item in LLM order to
    `{paper_id, position: get(item, 'position', 0), rationale: get(item, 'rationale', ''), title, authors, year}`
    (a `null` rationale is persisted as `null`), then a **stable** sort by `position` with Python's `<`:
    - `pyLt(a, b)`: numbers and booleans compare numerically; strings by code point; two arrays compare
      lexicographically as Python lists do: find the first index whose elements are not `pyEq` (numeric equality
      for numbers and booleans, string equality, element-wise for arrays, same keys and `pyEq` values for objects,
      `null == null`; a type mismatch is unequal, never a raise) and return `pyLt` of that pair (which may itself
      raise), else compare lengths. Every other pair (a string beside a number, an array beside a number, any
      `null`, two objects) throws `` TypeError: '<' not supported between instances of '<type(a)>' and '<type(b)>' ``
      with Python type names (`int`, `float`, `str`, `NoneType`, `list`, `dict`, `bool`). A single item never
      compares.
    - The sort mirrors CPython 3.11's `list.sort` (the `ficino-worker` image's version, `python:3.11-slim`;
      `count_run` and `binarysort` are unchanged in 3.12, and 3.13 rewrote `count_run`, so goldens regenerated on a
      3.13+ image could name a different pair) for fewer than 64 items, so a raise names the same pair in the
      same order: `count_run` (compare `keys[1] < keys[0]`; a strictly descending run continues while
      `keys[i] < keys[i-1]` and is then reversed; an ascending run continues while `keys[i] < keys[i-1]` is false),
      then a binary insertion of each later key `pivot` into the sorted prefix, comparing `pyLt(pivot, keys[mid])`.
      The left operand is always the later key, so with 2 items the message is
      `'<' not supported between instances of '<type of item 1>' and '<type of item 0>'`. For well-typed keys any
      stable sort gives the same order; with 64 or more items and mixed types the pair named may differ (out of
      scope).
- Produces in `src/tasks/readingLists.ts`:
  - `type ProposeOrderingData = { paper_ids: string[]; list_id?: string | null; user_id?: string | null }`
  - `proposeOrdering(data: ProposeOrderingData, ctx: JobContext, deps: WorkerDeps): Promise<Record<string, unknown>>`:
    1. Log `propose_ordering_start {paper_count, list_id}`.
    2. `loadJobSettings(sql, user_id || STUB_USER_ID, …)`.
    3. Port the LATERAL query (first 5 chunks per paper by `chunk_index`) with no user scope, plus
       `ORDER BY array_position(${paper_ids}::uuid[], p.id)` (deliberate change 5).
    4. No rows: return `{ordered_papers: [], error: 'No papers found'}`; no persist, no throw.
    5. `generateText(providers, deps.providers, {system: orderingSystemPrompt, user: ORDERING_USER, temperature:
       0.3, maxTokens: 2048, signal: ctx.signal})`.
    6. `validateOrdering(papers, parseOrderingJson(raw))`; a mismatch logs `propose_ordering_id_mismatch {missing,
       extra, input_count, returned_count}` at warn.
    7. With a `list_id`, one `sql.begin`: `UPDATE reading_lists SET paper_sequence = ${ids}::uuid[], rationale =
       ${sql.json(ordered)} WHERE id = ${list_id}` (no user scope), `DELETE` **all** its chapters, then
       `insertChapters(tx, list_id, ids)`. Log `propose_ordering_persisted`.
    8. Log `propose_ordering_complete {duration_ms, papers}`; return `{ordered_papers, duration_ms}`.
    9. Any throw logs `propose_ordering_failed {error}` and rethrows; pg-boss retries (2 at 180 s). Nothing writes
       a failure status, and there are no `ctx.progress` calls.
  - Registered in `HANDLERS` as `propose_ordering`.
- `fakeProviders`: `ChatPurpose` gains `ordering`, marker
  `analyzing a set of academic papers to propose an optimal reading order`. `defaultChat` for `ordering` returns
  `[]` (callers that need a real ordering pass `chat`).

- [ ] **Step 1: Write the golden generator.** `gen/reading_list_ordering.py` runs in the `ficino-worker` image. It
  imports `tasks.reading_list_tasks` and patches `fetch` (the case's rows, in case order), `execute_in_transaction`
  (record the statements and args), `apply_provider_settings` (no-op), `claude_client.generate_text_sync` (record
  `(system, user, kwargs)`, return the case's raw text) and the task's `retry` (return `exc`). It writes
  `reading-list-ordering.json` as `{parse: [{text, result}], runs: [{name, rows, raw, call, persisted, result}]}`
  (`result` is `{raises: "<Type>: <msg>"}` on a raise). Cases:
  - **parse:** a bare array; an array with non-dict items; `{"ordering": …}`, `{"papers": …}`, `{"result": …}`,
    `{"data": …}`; a dict with two wrapper keys; `{}`; a JSON string literal; `` ```json `` fenced; a fence
    without a language; two fenced blocks; prose plus an array; prose with two arrays (greedy span, invalid);
    an invalid fence but a valid bracket span; garbage.
  - **runs:** an exact match with ties and a missing `position` and `rationale`; an explicit `"position": null`
    beside a number (raises); an explicit `"rationale": null` (persisted as `null`); a `"paper_id": null` (mismatch,
    `null` in `extra`); a missing id; an extra id; an item without `paper_id`; duplicate ids passing the set check;
    mixed `position` types over 2 items (raises) and over 3 items, `[1, 2, "a"]` and `["a", 1, 2]` (raises, pinning
    the pair and order the message names); list positions `[[2], [1]]` and `[[1, "a"], [1, "b"]]` (sorted, no
    raise) and `[[1], ["a"]]` (raises on the element pair, `str` against `int`); a `list` paper_id (raises); `list_id=None` (no persist); no rows; rows with a
    null title (filename), an empty-string title (filename), an empty title with a null filename (`None`), null
    title and filename, empty authors, year `None` and `0`, more than 5 chunks, chunks with `é`, a combining mark and
    an astral character past 200 and 500 code points, a title with `{}`, with `</untrusted>`, and with `$&`, `$'`
    and `` $` ``.
- [ ] **Step 2: Run it** and commit the JSON.
- [ ] **Step 3: Write the failing tests.**
  - `ordering.test.ts`: every `parse` case through `parseOrderingJson`; every `run`'s rows through
    `orderingContext` and `orderingSystemPrompt` give the recorded system and user prompts byte for byte, with
    `temperature 0.3` and `max_tokens 2048`; `validateOrdering` over the parsed raw gives the recorded `persisted`
    rationale or the recorded raise.
  - `propose-ordering.test.ts`, against the DB with fake providers and the handler called directly:
    - Happy path: an LLM ordering reversing two papers persists the reversed `paper_sequence`, the rationale, and
      chapters rebuilt from scratch (a `complete` chapter is wiped too, as in Python).
    - Fallback: an LLM answer naming an unknown id persists the input order (array_position order, deliberate
      change 5) with empty rationales and logs `propose_ordering_id_mismatch`.
    - `No papers found` for unknown ids: no persist, no throw.
    - One transaction (ports `test_reading_list_persist.py`): in the test, create a `BEFORE INSERT` trigger on
      `reading_list_chapters` that raises, run the handler, and drop the trigger in `finally`. The handler throws,
      and `paper_sequence`, `rationale` and the old chapters are unchanged.
    - The LLM call carries the owner's stored `ollama_llm_model`, not another user's.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement and register.**
- [ ] **Step 6: Run the full suite and the typecheck.**
- [ ] **Step 7: Commit** with the message `feat(server): propose_ordering job pinned to Python goldens`.

### Task 4: `generate_chapter`, with the figure slot fixed

**Files:**
- Create: `server/src/readingLists/chapter.ts`, `server/test/fixtures/goldens/gen/chapter_tasks.py`,
  `server/test/fixtures/goldens/chapter-tasks.json`
- Modify: `server/src/tasks/readingLists.ts`, `server/src/worker/handlers.ts`, `server/src/feed/retrieval.ts`,
  `server/src/tasks/feed.ts`, `server/test/helpers/fakeProviders.ts`, `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/readingLists/chapter.test.ts`, `server/test/tasks/generate-chapter.test.ts`

**Interfaces:**
- Consumes: `loadPersonas`, `systemPrompts`, `resolveEnabledPersonas`, `planFeedPosts`, `POST_TYPE_WEIGHTS`,
  `buildPostSources`, `buildShortCite`, `assignPostCategory` (`feed/personas.ts`); `buildPostPrompt`
  (`feed/prompts.ts`); `generatePersonaPost`, `validatePostShape` (`feed/llmPost.ts`); `retrieveForPersona`,
  `countEmbedModelMismatch`, `countScopeChunks`, `embedModelId` (`feed/retrieval.ts`, `providers/embed.ts`); `applyEngagementDefaults`, `pickFigure`,
  `attachFigure` (`feed/slots.ts`); `loadFigures`, `writeFeedPostsIndex` (`tasks/feed.ts`); `uuid5`.
- Produces in `src/feed/retrieval.ts`: `assertEmbedModelScope(sql: Sql, paperIds: string[], model: string, log: Logger): Promise<void>`
  (step 6 below), used by `generate_feed`, `generate_chapter` and the podcast (Task 7).
- Produces in `src/readingLists/chapter.ts`:
  - `chapterContext(chapterIndex: number): string`. Exact bytes: `` `\nThis is Chapter ${i + 1} of a reading list. ` ``,
    plus, only when `i > 0`, `` `The reader has already covered ${i} prior paper(s). Build on that foundation — reference earlier papers when relevant.` ``
    (U+2014). Chapter 0 keeps the trailing space.
  - `chapterScope(sequence: string[], chapterPaperIds: string[]): string[]`: when the chapter's last id is in the
    sequence, the sequence up to and including the **first** occurrence of that id (`sequence.indexOf(last) + 1`,
    as Python's `list.index`; never `lastIndexOf`, since `propose_ordering` can persist duplicate ids); else the
    chapter's own ids (also when the chapter has no ids).
  - `promptPostType(planned: string): string`: `post`, `thread` and `figure` pass through; anything else
    (`quote`, `reply`) becomes `post`. So a chapter never fetches anchor chunks and never consumes a `choice`.
  - `finishChapterPost(rng: Rng, raw: Post, o: { personaKey: string; plannedType: string; slotIndex: number; chunks: Chunk[]; figure: FeedFigure | null; logger: Logger }): Post`.
    Sets `persona`; sets `post_type` to the **planned** type only when absent; `id = slotIndex + 1` and
    `time = ` `` `${(slotIndex + 1) * 2}m` `` (loop index, so skipped slots leave gaps); no `_task_id`; then, in
    `groundPost`'s order: `paper_ref = buildShortCite(chunks[0])` when there are chunks, `attachFigure` when a
    figure was picked, `sources = buildPostSources(chunks)`, `category = assignPostCategory(persona, post_type)`,
    `applyEngagementDefaults`, `validatePostShape` (which throws to drop the post).
- Produces in `src/tasks/readingLists.ts`:
  - `type GenerateChapterData = { reading_list_id: string; chapter_index: number; user_id?: string | null }`
  - `generateChapter(data: GenerateChapterData, ctx: JobContext, deps: WorkerDeps): Promise<Record<string, unknown>>`:
    1. Log `generate_chapter_start`. Read the list (no user scope), else throw `Reading list <id> not found`.
    2. `owner = data.user_id || list.user_id || STUB_USER_ID` (deliberate change 4). Read the chapter, else throw
       `Chapter <i> not found`. No `locked` re-check.
    3. Idempotent skip: when `chapter.feed_id` names a feed of `owner` with `post_count > 0`, log
       `generate_chapter_idempotent_skip` and return `{status: 'complete', feed_id, post_count, idempotent: true}`.
    4. `cumulative = chapterScope(…)`; log `chapter_scope`. `feedId = uuid5(`ficino:chapter:${reading_list_id}:${chapter_index}`)`.
    5. Settings as `tasks/feed.ts` reads them: `posts_per_generation` (12), `resolveEnabledPersonas`,
       `persona_temperature` (0.8), `post_type_weights` (`POST_TYPE_WEIGHTS`), `preferences`.
    6. Deliberate change 2: `await assertEmbedModelScope(sql, cumulative, embedModelId(providers), log)`. This
       helper is the `generate_feed` check moved verbatim from `tasks/feed.ts` into `feed/retrieval.ts` (log
       `embed_model_mismatch` on a partial mismatch; throw the `No chunks embedded with …` message when every
       in-scope chunk is excluded; no-op on an empty id list). `generate_feed` calls it in place of its inline
       block with unchanged behaviour; Task 7 reuses it.
    7. Build `const rctx: RetrievalCtx = { sql, config, providers, deps: deps.providers, logger: log, signal:
       ctx.signal }`, as `tasks/feed.ts` does, so every retrieval and embedding call is abortable. For each enabled
       persona in persona order, serially: `retrieveForPersona(rctx, personas, {personaKey,
       paperIds: cumulative, topK: 10})`. No liked-paper boost, exclusions or contradictions.
    8. `figures = await loadFigures(sql, deps.storage, cumulative)` (deliberate change 1).
    9. `plan = planFeedPosts(rng, personas, {numPosts, enabled, customWeights, preferences})`.
    10. Per slot `i`, after `ctx.signal.throwIfAborted()`: no chunks for the persona skips silently. A `figure`
        slot calls `pickFigure(rng, figures, personas.get(persona), 'figure')`; `'skip'` logs the matching
        `figure_post_skipped_*` event (as `tasks/feed.ts` does) and continues. Then, **outside** the slot `try`, as
        in Python (deliberate change 1): system = `(prompts.get(persona) ?? `You are ${persona}`) +
        chapterContext(chapter_index)`; user = `buildPostPrompt({…, postType: promptPostType(type), chunks,
        figure})`. Inside one `try`: `generatePersonaPost(providers, deps.providers, {system, user, temperature,
        signal: ctx.signal})` with the user `temperature` (no per-persona override);
        `finishChapterPost`; push. The catch first rethrows when `ctx.signal.aborted` (deliberate change 16);
        any other throw logs `chapter_post_failed {error}` and continues.
    11. `ctx.signal.throwIfAborted()` (an abort during the last slot never commits the chapter), then `sql.begin`
        (deliberate change 3): upsert `feeds (id, user_id, corpus_id, posts, paper_count, post_count,
        generation_duration_ms)` with `(feedId, owner, list.corpus_id, posts, cumulative.length, posts.length, 0)`
        `ON CONFLICT (id) DO UPDATE SET posts, paper_count, post_count, generated_at = NOW()`; set the chapter
        `feed_id, status = 'complete'`; unlock `chapter_index + 1` where `status = 'locked'`.
    12. After commit: `writeFeedPostsIndex(sql, feedId, posts, 0, owner)` in a try; a throw logs
        `feed_posts_index_sync_failed {feed_id, error_type, error}` at warn.
    13. Log `generate_chapter_complete`; return `{status: 'complete', feed_id, post_count}`. No progress writes,
        no fan-out. Any throw logs `generate_chapter_failed` and rethrows.
  - Registered in `HANDLERS` as `generate_chapter`.
- `fakeProviders`: `ChatPurpose` gains `chapter`, marker `of a reading list. `, checked before `persona`.

- [ ] **Step 1: Write the golden generator.** `gen/chapter_tasks.py` runs in the `ficino-worker` image. It patches
  `fetchrow`/`fetch`/`execute` (canned rows, every execute recorded), `apply_provider_settings` (the case's
  settings), `retrieval.retrieve_for_persona` (the case's chunks per persona), `persona_lib.plan_feed_posts` (the
  case's fixed plan), `get_active_persona_prompts` (the case's prompts), `get_personas` (the case's personas),
  `claude_client.generate_persona_post_sync` (record `(system, user, kwargs)`, return the case's post dict or
  raise), `_write_feed_posts_index` (record), `random` (low bound / first item, as `persona-prompts.json` does) and
  the task's `retry`. It writes `chapter-tasks.json` as `[{name, input, calls, stored_posts, executes, result}]`.
  Cases: chapter 0 and chapter 2 (the suffix bytes); a planned `quote` and `reply` whose LLM post omits
  `post_type`; a failing slot and a persona with no chunks (id and time gaps); a `thread` slot; the cumulative scope
  with the last paper outside the sequence; the idempotent skip; and a plan with a `figure` slot, recorded as the
  `ValueError` raise that documents the bug.
- [ ] **Step 2: Run it** and commit the JSON.
- [ ] **Step 3: Write the failing tests.**
  - `chapter.test.ts`: for every golden case except the figure one, each recorded call's system equals the case's
    prompt plus `chapterContext(i)`, its user equals `buildPostPrompt` for `promptPostType(planned)`, and
    `finishChapterPost(() => 0, …)` over the case's LLM post equals the stored post (with the gaps). `chapterScope`
    covers both branches, an empty chapter (its own `[]`), and first-occurrence semantics: sequence `[a, b, a, c]`
    with chapter ids `[a]` gives `[a]`, and with chapter ids `[c, a]` gives `[a]`.
  - `generate-chapter.test.ts`, against the DB with fake providers:
    - Happy path: the feed row has id `uuid5('ficino:chapter:<list>:0')`, `generation_duration_ms` 0 and
      `paper_count` = the scope; chapter 0 is `complete` with that `feed_id`; chapter 1 is `unlocked`; the
      `feed_posts` index has the posts (ports `test_generate_chapter_writes_feed_posts_index`); every chat had
      purpose `chapter`; the handler's return value `result`, passed as a completed job's output, gives
      `feedStatusFromJob(id, {queue: 'generate_chapter', state: 'completed', progress: null, output: result})`
      equal to `{status: 'complete', task_id: id, feed_id, post_count, duration_ms: null}` (the route-level poll
      is covered by the Task 12 end-to-end step 3).
    - **The figure-slot fix** (deliberate change 1): with `post_type_weights: {figure: 1}`,
      `posts_per_generation: 4` and no figures, the job completes, the chapter is `complete`, the log has
      `figure_post_skipped_no_figures_in_paper`, and no stored post has `post_type: 'figure'`. With a seeded figure
      whose type the persona allows, a stored post has `figure_id` and `figure_caption`.
    - A post without `content` is dropped (ports `test_reading_list_tasks_imports_validator`).
    - Idempotent skip: a second run returns `idempotent: true` and makes no LLM call. A chapter whose feed has 0
      posts regenerates.
    - Deliberate change 2: every chunk tagged with another `embed_model` throws the `generate_feed` message before
      any LLM call.
    - Deliberate change 3: when the unlock statement fails, nothing of the transaction survives. The test creates a
      `BEFORE UPDATE ON reading_list_chapters FOR EACH ROW WHEN (NEW.status = 'unlocked')` trigger that raises, so
      the preceding complete-mark (`status = 'complete'`) passes and only the unlock fails; it drops the trigger in
      `finally`. Afterwards no `feeds` row exists, chapter 0 is not `complete` and has no `feed_id`, and chapter 1
      is still `locked`.
    - A missing list throws `Reading list <id> not found`.
    - Deliberate change 16: a fake chat that aborts the job signal while answering the **last** slot makes the
      handler throw; no `feeds` row exists, chapter 0 is not `complete` and has no `feed_id`, chapter 1 is still
      `locked`, and no `chapter_post_failed` line was logged for that slot. A second variant pins that the signal
      reaches the LLM call: a fake chat that never settles on its own (the fake's `abortable` helper, released only
      by the signal) while the test aborts the job signal; the handler rejects promptly instead of hanging until
      the test timeout.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement and register.**
- [ ] **Step 6: Run the full suite and the typecheck.**
- [ ] **Step 7: Commit** with the message `feat(server): generate_chapter with figure slots fixed`.

### Task 5: The `speak` provider (ElevenLabs TTS and dialogue)

**Files:**
- Create: `server/src/providers/speak.ts`, `server/test/fixtures/goldens/gen/tts_requests.py`,
  `server/test/fixtures/goldens/tts-requests.json`
- Modify: `server/src/providers/http.ts`, `server/src/config.ts`, `server/test/helpers/fakeProviders.ts`,
  `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/providers/speak.test.ts`, `server/test/providers/http.test.ts` (new),
  `server/test/config.test.ts` (extend)

**Interfaces:**
- Produces in `http.ts`: `fetchBytes(deps: Pick<ProviderDeps, 'fetch'>, url: string, init: {method?; headers?; body?; timeoutMs: number; signal?}): Promise<Uint8Array>`.
  Same timeout, abort, `NetworkError` and `HttpStatusError(status, body text)` semantics as `fetchJson`; share
  one private helper rather than copying it.
- Produces in `config.ts`: `elevenlabsModelId` (`ELEVENLABS_MODEL_ID`, default `eleven_turbo_v2_5`) and
  `elevenlabsDialogueModelId` (`ELEVENLABS_DIALOGUE_MODEL_ID`, default `eleven_v3`).
- Produces in `src/providers/speak.ts` (port of `worker/lib/tts.py`; no retries, as in Python):
  - `type TtsConfig = { apiKey: string; modelId: string; dialogueModelId: string }`;
    `ttsConfig(config: Config): TtsConfig` (the key `pyStrip`ped).
  - `class TtsUnavailableError extends Error` (`ELEVENLABS_API_KEY is not set`);
    `class DialogueTooLongError extends Error` (`` `dialogue exceeds 2000-char cap: ${n}` ``).
  - `DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'`; `VOICE_MAP`, frozen, copied from `tts.py` (`skeptic`,
    `methodologist`, `practitioner`, `hype`, `gradstudent`, `archivist`, `amplifier`, `host_a`, `host_b`);
    `voiceIdFor(key: string): string` (`DEFAULT_VOICE` for any other key).
  - `DIALOGUE_CHAR_CAP = 2000`.
  - `speak(cfg: TtsConfig, deps: Pick<ProviderDeps, 'fetch'>, req: { text: string; voiceId: string; signal?: AbortSignal }): Promise<Uint8Array>`.
    `POST https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, headers `xi-api-key`, `accept: audio/mpeg`,
    `content-type: application/json`, body `{text, model_id: cfg.modelId, voice_settings: {stability: 0.5,
    similarity_boost: 0.75}}`, `timeoutMs` 30 000 (a total deadline, deliberate change 15).
  - `type DialogueInput = { text: string; voice_id: string }`;
    `speakDialogue(cfg, deps, req: { inputs: DialogueInput[]; signal?: AbortSignal }): Promise<Uint8Array>`. In
    `tts.py`'s order: the empty-key check runs **first** (`TtsUnavailableError`), then the cap check (the sum of
    `pyLen(text)` above 2000 throws `DialogueTooLongError`), both **before** any request. So an over-cap script
    with no key throws `TtsUnavailableError`, and the podcast logs no `podcast_dialogue_too_long` for it. Then
    one `POST https://api.elevenlabs.io/v1/text-to-dialogue`, body `{inputs, model_id: cfg.dialogueModelId,
    settings: {stability: 0.5}}`, `timeoutMs` 180 000 (total, deliberate change 15). One call returns one file;
    this function never splits.
  - Both throw `TtsUnavailableError` on an empty key, before any request.
- `fakeProviders` gains the option `tts?: (call: TtsCall) => Uint8Array | Response | Promise<Uint8Array | Response>`
  where `type TtsCall = { kind: 'elevenlabs-tts' | 'elevenlabs-dialogue'; voiceId?: string; body: any }`.
  `FakeCall.kind` gains the same two values and `FakeCall` gains `url?: string`; each ElevenLabs call is recorded
  with `apiKey` from `xi-api-key` and `model` from `body.model_id`. The default answer is
  `new TextEncoder().encode('ID3fake:' + JSON.stringify(body))`, so tests can see what was rendered.

- [ ] **Step 1: Write the golden generator.** `gen/tts_requests.py` patches `httpx.Client` with a recorder and
  calls `synthesize` and `synthesize_dialogue` with a fixed fake key, plus `voice_id_for` over every map key and
  `custom_x`. It writes `tts-requests.json` as `{requests: [{url, headers, json, timeout}], voices: {key: id},
  too_long: "<raised message>"}` with the key value replaced by `<key>`. Cases: one TTS call with `é` and an astral
  character; a two-turn dialogue; a dialogue of exactly 2000 code points (sent) and of 2001 (raises, no request).
- [ ] **Step 2: Run it** and commit the JSON.
- [ ] **Step 3: Write the failing tests.**
  - `speak.test.ts`: every golden request is reproduced (URL, header names and values, JSON body); the voice map
    equals the golden; an empty or whitespace key throws `TtsUnavailableError` with no request; a 401 throws
    `HttpStatusError` 401 carrying the body; a dialogue of 2001 code points throws `DialogueTooLongError` with
    **no** request; an empty key with a 2001-code-point dialogue throws `TtsUnavailableError` (not
    `DialogueTooLongError`) with no request; 1001 astral characters (2002 UTF-16 units, 1001 code points) are sent, so the cap counts code
    points; a 2000-code-point dialogue sends exactly one request (Review Focus 1); the caller's abort rejects.
  - `http.test.ts`: `fetchBytes` returns the body bytes; a non-2xx throws `HttpStatusError`; a rejected fetch
    throws `NetworkError`; a timeout keeps its `TimeoutError` name.
  - `config.test.ts`: the two model-id defaults and overrides.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run the full suite and the typecheck.**
- [ ] **Step 7: Commit** with the message `feat(server): ElevenLabs speak provider (TTS and one-call dialogue)`.

### Task 6: `generate_audio_for_feed`

**Files:**
- Create: `server/src/audio/feedAudio.ts`, `server/src/tasks/audio.ts`,
  `server/test/fixtures/goldens/gen/feed_audio.py`, `server/test/fixtures/goldens/feed-audio.json`
- Modify: `server/src/shared/pystr.ts`, `server/src/worker/handlers.ts`,
  `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/audio/feedAudio.test.ts`, `server/test/tasks/feed-audio.test.ts`,
  `server/test/shared/pystr.test.ts` (extend)

**Interfaces:**
- Consumes: `speak`, `ttsConfig`, `voiceIdFor`, `DEFAULT_VOICE`, `TtsUnavailableError` (Task 5);
  `LocalStorage.saveAudio`; `loadPersonas`.
- Produces in `pystr.ts`:
  - `pyTruthy(v: unknown): boolean`, Python truthiness of a JSON value (`null`, `undefined`, `false`, `0`, `''`,
    `[]` and `{}` are false), the form private to `ingest/metadata.ts`. The three private `truthy` copies may stay.
  - `pyTitle(s: string): string`, CPython's `str.title()` (`do_title`), walking code points:
    - "Cased" is the Unicode `Cased` property, `/\p{Cased}/u` (it includes `ª`, `ʰ`, `ⅰ` and `ⓐ`, which
      `\p{Lu}\p{Ll}\p{Lt}` misses). `previousIsCased` is set from each **input** character, not its mapping.
    - A cased character after a non-cased one (or at the start) gets its **titlecase** mapping:
      `PY_TITLE_EXCEPTIONS[c] ?? c.toUpperCase()`. `PY_TITLE_EXCEPTIONS` is a frozen literal map in `pystr.ts` of
      every code point whose Python `c.title()` differs from `c.upper()` (the `Lt` digraphs `Ǆ ǅ ǆ → ǅ`,
      `Ǉ ǈ ǉ → ǈ`, `Ǌ ǋ ǌ → ǋ`, `Ǳ ǲ ǳ → ǲ`; full special casing such as `ß → Ss`, `ﬁ → Fi`, `և → Եւ`; Georgian
      Mkhedruli letters, which titlecase to themselves; about 135 entries), copied from the golden's
      `title_exceptions`.
    - A cased character after a cased one is lower-cased with `c.toLowerCase()`, except `Σ` (U+03A3), which
      becomes `ς` when, skipping `\p{Case_Ignorable}` characters in each direction, a cased character precedes it
      and none follows it, else `σ` (CPython's `handle_capital_sigma`).
    - Non-cased characters pass through.

    So `my_persona` gives `My_Persona`, `o'neil` gives `O'Neil`, `ǆx` gives `ǅx`, `ßa` gives `Ssa`, `ªb` gives
    `ªb`, `ⓐb` gives `Ⓐb` and `ΑΣ ΑΣΑ` gives `Ας Ασα`.
  - `pyTypeName(v: unknown): string`, the Python type name of a JSON value: `NoneType` for `null`/`undefined`,
    `bool`, `int` for an integer number, `float` for any other number, `str`, `list`, `dict`. (A jsonb `1.0` is a
    Python `float` but a JS integer; that edge is out of scope.)
- Produces in `src/audio/feedAudio.ts` (port of `audio_tasks.py:60-187`):
  - `MAX_TTS_CHARS = 4000`.
  - `postToSpeechText(post: Post, displayName: string): string | null`. `null` when `deleted` is truthy or the
    `pyStrip`ped content is empty. Pieces are the stripped content plus each non-blank string of `thread_posts`
    (stripped), joined by `\n\n`, prefixed `` `${displayName} says: ` `` when the name is non-empty. Over 4000 code
    points: `pySlice(joined, 0, 4000)` cut at its last `' '` (when there is one) plus `…`.
  - `reclaimMinutes(jobTimeLimitSec: number): number` = `Math.max(15, Math.floor(jobTimeLimitSec * 2 / 60))`.
  - `type MediaColumn = 'audio' | 'podcast'`;
    `claimMedia(sql: Sql, feedId: string, column: MediaColumn, minutes: number): Promise<{ user_id: string | null; corpus_id: string | null; posts: unknown } | undefined>`. The
    claim `UPDATE` copied from Python: set `<col>_status = 'generating', <col>_claimed_at = NOW()` where the status
    is NULL, `failed`, or `generating` with a NULL or older-than-`make_interval(mins => ${minutes})` claim;
    `RETURNING user_id, corpus_id, posts`. The two column names come from a fixed map, never from input.
- Produces in `src/tasks/audio.ts`:
  - `type FeedMediaData = { feed_id: string }`
  - `generateAudioForFeed(data: FeedMediaData, ctx: JobContext, deps: WorkerDeps): Promise<Record<string, unknown>>`,
    the port of `generate_audio_for_feed`:
    1. `claimMedia(…, 'audio', reclaimMinutes(config.jobTimeLimitSec))`; no row logs
       `feed_audio_skipped_already_claimed_or_ready` and returns `{status: 'skipped', reason: 'claimed_or_ready'}`.
       A non-array `posts` throws `feed posts is not a list` inside the step 8 catch, so the feed ends `failed`
       (deliberate change 17c).
    2. For each post index, serially, after `ctx.signal.throwIfAborted()`: an item that is not a plain object
       (`null`, a string, a number, a boolean, an array) throws
       `` new TypeError(`'${pyTypeName(post)}' object has no attribute 'get'`) `` inside the step 8 catch, so the
       feed ends `failed` with the posts before it already rendered and keyed (parity: Python's `post.get` raised
       `AttributeError` and its outer `except` failed the job). Otherwise display name =
       `personas.get(key)?.name || pyTitle(key)` for `key = pyTruthy(post.persona) ? pyStr(post.persona) : ''`
       (Python's `str(post.get("persona") or "")`: `false` and `0` give `''`, not `False`/`0`);
       `postToSpeechText` null counts `skipped`.
    3. Synthesize with the fallback (port `_synthesize_with_fallback`). Every `speak` call, the first one and the
       `DEFAULT_VOICE` fallback alike, passes `signal: ctx.signal`, so a time limit interrupts a 30 s render.
       `TtsUnavailableError` rethrows. Any
       `HttpStatusError` logs `synthesis_voice_failed`, records `` `http_${status}_voice_${voiceId}` `` with
       `pySlice(body, 0, 300)`, then, unless the voice already was `DEFAULT_VOICE`, retries once with
       `DEFAULT_VOICE`; a fallback failure logs `synthesis_fallback_failed` and records `` `fallback_${e.name}` ``
       with `` `${e.message} body=${body}` `` where `body = e instanceof HttpStatusError ? pySlice(e.body, 0, 300) :
       ''` (Python's `fb_body = ""` for anything but an `HTTPStatusError`; never `body=undefined`). Any other error
       records `` `exception_${e.name}` `` with `e.message`. A failed post counts `skipped`. **The job's own abort
       is never a per-post failure** (deliberate change 16): every catch in this helper (the first call, the
       fallback call and the generic arm) first rethrows when `ctx.signal.aborted`, before logging or recording a
       stage.
    4. `saveAudio(feedId, idx, mp3)`; a throw records `` `upload_${e.name}` `` and counts `skipped` (also
       rethrowing when `ctx.signal.aborted`).
    5. Write the key: `UPDATE feeds SET posts = jsonb_set(posts, ARRAY[${idx}::text, 'audio_key'], to_jsonb(${key}::text), true)`,
       then best-effort `posts #- ARRAY[${idx}::text, 'audio_error']`; count `rendered`.
    6. Recording an error is best-effort: `jsonb_set(posts, ARRAY[idx, 'audio_error'], to_jsonb(<stage>: <detail[:300]>), true)`,
       errors swallowed.
    7. `ctx.signal.throwIfAborted()` (an abort during the last post never ends `ready`), then set
       `audio_status = 'ready', audio_generated_at = NOW()` even when nothing rendered; return
       `{status: 'complete', rendered, skipped}`.
    8. Any throw: best-effort `audio_status = 'failed'`, then rethrow (the queue's `retryLimit` is 0).
  - Registered in `HANDLERS` as `generate_audio_for_feed`.

- [ ] **Step 1: Write the golden generator.** `gen/feed_audio.py` calls `_post_to_speech_text` over: a plain post;
  a deleted post; whitespace-only content; thread posts with a blank and a non-string entry; an empty display name;
  a body of 4100 code points with spaces; one of 4100 without a space; astral characters across the cut. It also
  records `str.title()` over `my_persona`, `o'neil`, `émile zola`, `ǆx`, `ǅX`, `x1y`, `ßa`, `ﬁx`, `ŉx`, `ªb`,
  `ⓐb`, `ⅰb`, `ΑΣ ΑΣΑ`, `ΑΣ.Α` and `İx xİ`; the persona key `str(v or "")` for `None`, `False`, `0`, `""` and `"x"`;
  `title_exceptions`, the map `{c: c.title()}` over every code point where `c.title() != c.upper()`, plus
  `unicodedata.unidata_version`; `max(15, T*2 // 60)` for T in 300, 600, 1800; and `str(exc)` of the
  `AttributeError` from `v.get("persona")` for `None`, `"x"`, `1`, `1.5`, `True` and `[1]` (the `pyTypeName`
  messages). Output `feed-audio.json`.
- [ ] **Step 2: Run it** and commit the JSON.
- [ ] **Step 3: Write the failing tests.**
  - `feedAudio.test.ts` and `pystr.test.ts`: the goldens. `PY_TITLE_EXCEPTIONS` equals the golden's
    `title_exceptions` exactly, and `pyTitle(c)` equals the recorded value for every key. `pyTruthy` over `null`,
    `false`, `0`, `''`, `[]`, `{}` (false) and `'x'`, `1`, `[0]`, `{a: 1}` (true). Node's ICU Unicode version may
    be newer than the image's Python; a code point added in between is out of scope.
  - `feed-audio.test.ts`, against the DB with fake providers and a real `LocalStorage` on the test media dir:
    - Claims (ports `test_media_claim_reclaim.py`): NULL and `failed` are claimed; `ready` is skipped; a
      `generating` claim 5 minutes old is skipped; claims 21, 30 and 90 minutes old are taken; a `generating` row
      with a NULL claim is taken; `reclaimMinutes(600)` is 20 and `reclaimMinutes(1800)` is 60. The widened window
      changes what is claimed (ports `test_raised_celery_time_limit_widens_reclaim_window`): a `generating` row
      claimed 25 minutes ago is taken by `claimMedia(sql, id, 'audio', reclaimMinutes(600))`, and a second such row
      is **not** taken by `claimMedia(sql, id2, 'audio', reclaimMinutes(1800))` (returns `undefined`, the row is
      unchanged).
    - Happy path: posts `[skeptic, deleted, whitespace, custom key my_persona]` give `{rendered: 2, skipped: 2}`;
      `audio_key` is `feeds/<id>/audio/post_0.mp3` and `…post_3.mp3`; both files exist; the TTS calls used the
      skeptic voice and `DEFAULT_VOICE`; the second call's text starts `My_Persona says: `; `audio_status` is
      `ready` and `audio_generated_at` is set; no `text-to-dialogue` call.
    - Fallback: a 401 for the skeptic voice and a 200 for the default renders the post and leaves no
      `audio_error`. A 401 for both leaves `audio_error` starting `fallback_HttpStatusError: ` and the post
      skipped; the job still ends `ready`. A 401 for the skeptic voice and then a fake `tts` that throws for the
      default voice (the fake fetch rejects, so `fetchBytes` throws `NetworkError`) leaves an `audio_error` that
      starts `fallback_NetworkError: network error: ` and ends with ` body=`.
    - A fake fetch that rejects records `exception_NetworkError: …`.
    - A feed whose `posts` is `{}` ends `failed` with `feed posts is not a list` and makes no TTS call.
    - Non-object items (parity): `posts: ['x']` ends `failed` with `'str' object has no attribute 'get'` and no
      TTS call; `posts: [<skeptic post>, null]` renders post 0 (its `audio_key` is written), then ends `failed`
      with `'NoneType' object has no attribute 'get'`. `pyTypeName` over the golden's values gives the recorded
      messages.
    - The signal reaches ElevenLabs: a fake `tts` that never settles on its own (released only by the signal,
      the fake's `abortable` helper) while the test aborts the job signal makes the handler reject promptly with
      `audio_status` `failed`, for the first call and, with a 401 first answer, for the `DEFAULT_VOICE` fallback.
    - A post whose `persona` is `false` speaks without a `… says: ` prefix and with `DEFAULT_VOICE`.
    - Aborting the job signal from inside the fake `tts` answer for the **last** post: the handler throws,
      `audio_status` is `failed` (not `ready`), and that post has no `exception_AbortError` breadcrumb.
    - An empty key: the handler throws `ELEVENLABS_API_KEY is not set` and `audio_status` is `failed`.
    - A storage whose `saveAudio` throws records `upload_Error: …`; the job ends `ready`.
    - An aborted signal before the second post: the handler throws and `audio_status` is `failed` (Review
      Focus 3).
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement and register.**
- [ ] **Step 6: Run the full suite and the typecheck.**
- [ ] **Step 7: Commit** with the message `feat(server): feed audio job on local media storage`.

### Task 7: `generate_podcast_for_feed` (one dialogue render)

**Files:**
- Create: `server/src/audio/podcast.ts`, `server/test/fixtures/goldens/gen/podcast_script.py`,
  `server/test/fixtures/goldens/podcast-script.json`
- Modify: `server/src/tasks/audio.ts`, `server/src/worker/handlers.ts`, `server/test/helpers/fakeProviders.ts`,
  `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/audio/podcast.test.ts`, `server/test/tasks/podcast.test.ts`,
  `server/test/tasks/podcast-settings-failure.test.ts`

**Interfaces:**
- Consumes: `speakDialogue`, `ttsConfig`, `voiceIdFor` (Task 5); `claimMedia`, `reclaimMinutes`, `pyTruthy`,
  `pyTitle` (Task 6); `assertEmbedModelScope` (Task 4); `isUuid` (Task 1); `retrieveChunks`, `RetrievalCtx`; `parsePostJson`; `fenceUntrusted`, `sanitizeInline`; `generateText`;
  `loadJobSettings`; `loadPersonas`; `STUB_USER_ID`.
- Produces in `src/audio/podcast.ts` (port of `worker/lib/podcast.py`; every constant and string copied):
  - `PODCAST_SYSTEM_PROMPT`; `PODCAST_QUERY = 'key findings, methods, debates, and limitations across these papers'`;
    `MIN_SEGMENTS = 4`, `TARGET_SEGMENTS = 10`, `MAX_TOTAL_CHARS = 1700`, `RETRIEVAL_TOP_K = 30`.
  - `type Segment = { speaker: 'host_a' | 'host_b'; text: string }`.
  - Every helper that walks `posts` takes `posts: unknown[]` and skips an item that is not a plain object (`null`,
    a string, a number, a boolean, an array), as Python's `isinstance(post, dict)` guards do (`podcast.py:85, 119,
    215, 219`): `collectPaperIds`, `summarizeFeedForPrompt`, and `fallbackScript`'s `n_posts` count and persona
    names.
  - `collectPaperIds(posts: unknown[]): string[]`; `personaName(post: Post, personas: Personas): string` (`key =
    pyTruthy(post.persona) ? pyStr(post.persona) : ''`, as in Task 6; the `key.replace('_', ' ')` is Python's
    replace-all, then `pyTitle`, else `A persona`);
    `summarizeFeedForPrompt(posts: unknown[], personas): string`; `formatChunksForPodcast(chunks: Chunk[]): string`;
    `podcastUserPrompt(covered: string, chunksBlock: string, feedBlock: string): string`;
    `parseScript(raw: string): Segment[] | null` (a `parsePostJson` throw is `null`);
    `fitTotalChars(segments: Segment[], cap = MAX_TOTAL_CHARS): Segment[]` (pops trailing segments while the
    `pyLen` total exceeds the cap **and** more than 2 remain);
    `fallbackScript(posts: unknown[], personas, chunks, paperTitles: string[]): Segment[]` (persona names sorted by code
    point).
  - `type PodcastSeams = { retrieve?: (q: { query: string; paperIds: string[]; topK: number }) => Promise<Chunk[]>;
    fetchTitles?: (paperIds: string[]) => Promise<Array<{ id: string; title: string | null }>> }`. Test seams only:
    `retrieve` defaults to `retrieveChunks(rctx, q)` and `fetchTitles` to
    `` sql`SELECT id, title FROM papers WHERE id = ANY(${ids}::uuid[])` ``. Production never passes them.
  - `buildPodcastScript(rctx: RetrievalCtx, o: { posts: unknown[]; personas: Personas; logger: Logger } & PodcastSeams): Promise<Segment[]>`,
    the port of `build_podcast_script` in Python's order: paper ids; `retrieve({query: PODCAST_QUERY, paperIds,
    topK: 30})` when there are ids (a throw logs `podcast_retrieval_failed` and gives `[]`); titles via
    `fetchTitles`, ported exactly: `titleById` maps each returned row's `id` (postgres.js gives it lowercase) to
    `title || 'Untitled'`, and `paperTitles = paperIds.filter(id => titleById.has(id)).map(id => titleById.get(id))`.
    So a paper id with no returned row (a deleted paper, or an id whose string differs from the lowercase row id,
    such as an uppercase source id) is **dropped**, not mapped to `Untitled`; only a returned row with a falsy title
    becomes `Untitled`. This sets `n_papers`, `covered` and the fallback's per-paper lines (a throw logs
    `podcast_paper_titles_failed`);
    `covered`; one `generateText(…, {temperature: 0.7, maxTokens: 3000, signal: rctx.signal})` (a throw logs `podcast_llm_failed` and
    falls back); `parseScript`, `fitTotalChars`, then the fallback when fewer than `MIN_SEGMENTS`. Never empty.
- Produces in `src/tasks/audio.ts`:
  `generatePodcastForFeed(data: FeedMediaData, ctx: JobContext, deps: WorkerDeps): Promise<Record<string, unknown>>`:
  1. `claimMedia(…, 'podcast', …)`; no row returns `{status: 'skipped', reason: 'claimed_or_ready'}`.
     `posts = Array.isArray(row.posts) ? row.posts : []` (Python's `if not isinstance(posts, list): posts = []`).
     Everything from step 2 on runs inside the step 7 catch.
  2. `loadJobSettings` for `owner = row.user_id ?? STUB_USER_ID` (ports `test_podcast_settings.py`); build the
     `RetrievalCtx` as Task 4 step 7 does, with `signal: ctx.signal`. A settings failure ends `failed` through step 7 (deliberate change 17a and b).
  3. Deliberate change 14: `await assertEmbedModelScope(sql, collectPaperIds(posts).filter(isUuid),
     embedModelId(providers), log)` (Task 4). A throw lands in step 7, so the podcast ends `failed` with no LLM
     or ElevenLabs call. Then `buildPodcastScript`.
  4. **Before synthesis**, write `podcast_segments = [{index, speaker, text, voice_id}]`, so the transcript shows
     even if synthesis fails.
  5. Log `podcast_dialogue_start {segments, total_chars}`. Then one `speakDialogue(ttsConfig(config),
     deps.providers, {inputs: segments.map(s => ({text: s.text, voice_id: voiceIdFor(s.speaker)})), signal:
     ctx.signal})`. Every error rethrows: `DialogueTooLongError` logs `podcast_dialogue_too_long`, an
     `HttpStatusError` logs `podcast_dialogue_http_error {status_code, body: pySlice(body, 0, 400)}`, and
     `TtsUnavailableError` rethrows as is.
  6. `savePodcastEpisode(feedId, mp3)`; set `podcast_status = 'ready', podcast_generated_at = NOW()`; return
     `{status: 'complete', segments: n, bytes: mp3.byteLength}`.
  7. Any throw: best-effort `podcast_status = 'failed'`, then rethrow.
  Registered in `HANDLERS` as `generate_podcast_for_feed`.
- `fakeProviders`: `ChatPurpose` gains `podcast`, marker `You are a podcast producer writing a short episode`.

- [ ] **Step 1: Write the golden generator.** `gen/podcast_script.py` imports `lib.podcast` and records, per case,
  the system and user prompt, the parsed, fitted and fallback segments. It patches `retrieve_chunks`, `fetch`
  (titles), `get_personas` and `claude_client.generate_text_sync`. Cases: a clean 10-turn script; 3 turns (falls
  back); an LLM throw; garbage; `{"segments": "x"}`; speakers ` HOST_A ` and `host_c`; a script of 4 turns of
  900 characters (trimmed to 2); posts without sources (no retrieval, `(unknown)`, `(no retrieved chunks)`); a null
  title (`Untitled`); a source `paper_id` with no papers row (dropped from `covered` and the fallback, so
  `n_papers` counts only the rows), and an uppercase source id whose lowercase twin has a row (also dropped); a
  custom persona key `my_persona`; deleted posts; a feed block past 3000 characters; chunks
  past 14 000; a chunk with `</untrusted>`; a title with an astral character; six titles in the fallback; `posts` holding `null`, a string and an array
  beside two real posts (skipped by `collectPaperIds`, `summarizeFeedForPrompt`, and `fallbackScript`'s `n_posts`
  and persona names).
- [ ] **Step 2: Run it** and commit the JSON.
- [ ] **Step 3: Write the failing tests.**
  - `podcast.test.ts`: every golden case through the pure functions, and through `buildPodcastScript` with the
    `retrieve` and `fetchTitles` seams answering the case's chunks (in the recorded order) and title rows and the
    fake providers' `chat` answering the case's raw text, gives the recorded prompts and segments. For the "LLM
    throw" case the fake `chat` returns `''`, so `generateText` throws the non-retryable
    `LLM returned empty response` at once. A `chat` that throws would make the fake fetch reject, which
    `fetchJson` turns into a transient `NetworkError` that `generateText` retries with real 2 s and 6 s sleeps,
    past vitest's 5 s default timeout.
  - `podcast.test.ts` (task), against the DB with fake providers:
    - Happy path: exactly **one** `elevenlabs-dialogue` call and **zero** `elevenlabs-tts` calls; its `inputs`
      voices are `voiceIdFor('host_a'|'host_b')`; `feeds/<id>/podcast/episode.mp3` exists and is the only file
      under `podcast/`; `podcast_status` is `ready`; `podcast_segments` has `index, speaker, text, voice_id`; the
      chat had purpose `podcast` and carried the owner's stored model.
    - Review Focus 1: an LLM script of 12 alternating turns of 300 code points each is trimmed to 5 turns (1500
      code points, at or above `MIN_SEGMENTS`, so no fallback) and produces exactly one dialogue call whose
      `inputs` has 5 entries totalling 1500 code points, and no other file.
    - A dialogue 500: `podcast_status` is `failed`, `podcast_segments` holds the script, no episode file exists.
    - A `ready` podcast is skipped; a stale `generating` claim is taken; an empty key ends `failed`.
    - Deliberate change 17: a feed with a NULL `user_id` renders, and its chat carries `STUB_USER_ID`'s stored
      `ollama_llm_model`; a feed whose `posts` is `{}` renders the fallback script (`posts` coerced to `[]`).
    - Deliberate change 17a, in its own file `test/tasks/podcast-settings-failure.test.ts` (the module mock would
      leak into the other cases; `test/api/main-boot-failure.test.ts` is the pattern): `vi.mock` of
      `src/providers/config.js` keeps the real module but makes `loadJobSettings` reject; the handler throws,
      `podcast_status` is `failed` (never `generating`), and no chat or ElevenLabs call was made.
    - Review Focus 1, over the cap: a post whose `persona` key is 2100 `x` characters and a chat that returns `''`
      (so the fallback script runs without the retry sleeps; its first segment names the persona and `fitTotalChars` keeps at least two
      segments) gives zero ElevenLabs calls, `podcast_status` `failed`, a `podcast_dialogue_too_long` log line,
      `podcast_segments` holding the script, and no episode file.
    - Deliberate change 14: every in-scope chunk tagged with another `embed_model` ends `failed` with the
      `No chunks embedded with …` error, no chat and no ElevenLabs call; a partial mismatch logs
      `embed_model_mismatch` and renders.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement and register.**
- [ ] **Step 6: Run the full suite and the typecheck.**
- [ ] **Step 7: Commit** with the message `feat(server): podcast job, one dialogue render per episode`.

### Task 8: `POST /feed/{id}/audio` and `/podcast`

**Files:**
- Modify: `server/src/routes/feed.ts`
- Test: `server/test/routes/feed-audio.test.ts`

**Interfaces:**
- Consumes: `chargeUserRateLimit`; `isUuid`; `queue.send`; `reclaimMinutes` (Task 6).
- Adds to `feedRoutes()` two routes that differ only in the column, the queue and the log event:

  | Route | Column | Queue | Log |
  |---|---|---|---|
  | `POST /:feed_id/audio` | `audio_status` | `generate_audio_for_feed` | `feed_audio_dispatched` |
  | `POST /:feed_id/podcast` | `podcast_status` | `generate_podcast_for_feed` | `feed_podcast_dispatched` |

  Each runs in this order:
  1. `requireUser` (the router's).
  2. `!config.elevenlabsApiKey` gives **501** `Audio TTS not configured`, before the id is looked at.
  3. A non-UUID id, or no feed `WHERE id AND user_id`, gives 404 `Feed not found`. The one `SELECT` reads
     `<col>_status`, `<col>_claimed_at` (logged in step 4) and a `stale` flag computed in SQL:
     `<col>_status = 'generating' AND (<col>_claimed_at IS NULL OR <col>_claimed_at < NOW() - make_interval(mins => ${reclaimMinutes(config.jobTimeLimitSec)}))`, the same
     predicate as the handler's claim. Column names come from a fixed map.
  4. `ready`, or `generating` that is not `stale`, gives **202** `{status}`, with no `task_id` and no charge. A
     `stale` `generating` row (deliberate change 13: its job died before its catch ran, and nothing else will ever
     claim it) logs `feed_audio_stale_claim` / `feed_podcast_stale_claim` `{feed_id, claimed_at}` at warn and falls
     through to the charge and dispatch, like NULL and `failed`.
  5. `await chargeUserRateLimit(c, 'audio')` (one bucket for both routes).
  6. `taskId = await queue.send(<queue>, {feed_id})`; log; **202** `{status: 'generating', task_id}`. The API never
     writes the status column; the worker claims it. No audit (as Python).

- [ ] **Step 1: Write the failing tests.** These port the four `test_feed_audio_rate_limit.py` tests.
  - No key: 501 `Audio TTS not configured` for an owned feed, an unknown feed and `/feed/nope/audio`, on both
    routes.
  - With `config: {elevenlabsApiKey: 'k'}`: user B's feed, an unknown id and a non-UUID give 404 `Feed not found`.
  - A NULL status dispatches: 202 with a `task_id` whose `job_progress` row is on `generate_audio_for_feed` and
    whose job data is `{feed_id}`; the feed row is unchanged. A `failed` status dispatches and is charged.
  - Under `authProvider: 'basic'` with `rateLimits.audio: 1`: a `ready` feed answered three times, then a
    freshly claimed `generating` one, never charges, and a dispatch afterwards still succeeds; a second dispatch is 429
    `Rate limit exceeded: 1 audio per 24h. Try again later.` and sends no job; after an audio dispatch, a podcast
    dispatch is 429 (shared bucket).
  - The podcast route dispatches `generate_podcast_for_feed`.
  - Deliberate change 13, on both routes: a `generating` row whose claim is older than
    `reclaimMinutes(jobTimeLimitSec)` gives 202 `{status: 'generating', task_id}`, one new job and the stale-claim
    log line; a `generating` row with a NULL claim dispatches too. A `generating` row claimed 1 minute ago gives
    `{status: 'generating'}`, no job and no charge. Under `basic` with `rateLimits.audio: 1`: a fresh-claim POST,
    then a stale-claim POST (202 with a job), then a dispatch on a third feed (429): the stale re-dispatch was
    charged exactly once and the fresh one never.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite** (`routes-auth.test.ts` gates both routes) **and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): POST /feed/{id}/audio and /podcast`.

### Task 9: Media the frontend can play: URL base, byte ranges, cleanup on every feed delete

**Files:**
- Create: `server/src/http/tokenQuery.ts` (moved from `routes/figures.ts`)
- Modify: `server/src/config.ts`, `server/src/routes/feed.ts`, `server/src/routes/media.ts`,
  `server/src/routes/figures.ts`, `server/src/storage/local.ts`, `server/src/routes/papers.ts`,
  `server/src/routes/settings.ts`
- Test: `server/test/routes/media.test.ts`, `server/test/routes/feed-read.test.ts`,
  `server/test/routes/settings.test.ts`, `server/test/routes/papers.test.ts`, `server/test/config.test.ts`,
  `server/test/storage/local.test.ts` (extend each)

**Interfaces:**
- Produces in `config.ts`: `publicApiBase: string` from `PUBLIC_API_BASE`, default `/ficino/api`. `''` is allowed;
  anything else must match `^(/[A-Za-z0-9._~-]+)+$` (no trailing slash), or `loadConfig` throws
  `PUBLIC_API_BASE must be empty or a path like /ficino/api`. An absolute origin is deliberately not accepted:
  media is supported only for same-origin deployments (a relative `VITE_API_BASE`, the frontend's default). The
  shipped frontend CSP (`frontend/nginx-security-headers.conf`: `media-src 'self' blob: https://*.supabase.co`,
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co`) allows media and API calls only from `'self'`
  (plus Supabase hosts), so it already rules out a cross-origin API such as `frontend/.env.example`'s
  `https://api.ficino.app`. Task 12 states this in the README and the carryover.
- `routes/feed.ts`: `audio_url` and `podcast_audio_url` become `` `${config.publicApiBase}${storage.audioUrl(…)}` ``
  and the same for the episode (deliberate change 7). Figure URLs stay relative (the frontend prefixes those).
- `src/http/tokenQuery.ts` exports `tokenQuery` unchanged; `figures.ts` and `media.ts` import it from there.
- `routes/media.ts` keeps the token, key-shape, ownership and missing-file checks in their current order, then
  (deliberate change 8):
  - Every 200 and 206 carries `accept-ranges: bytes`, `content-type: audio/mpeg` and `content-length`.
  - A `Range` header of exactly one `bytes=a-b`, `bytes=a-` or `bytes=-n` range (decimal digits only): for
    `bytes=a-b`, `a > b` is **malformed** (RFC 9110: ignore the header); otherwise clamp `b` to `size - 1`. A suffix
    `bytes=-n` with `n > 0` is `start = Math.max(0, size - n)`, `end = size - 1` (so `n > size` serves the whole
    file as `0-(size-1)`). Answer **206** with `content-range: bytes start-end/size`, streaming
    `createReadStream(path, {start, end})` through `Readable.toWeb`. `start` is never negative and `end` never
    below `start`, so `createReadStream` cannot throw `ERR_OUT_OF_RANGE`.
  - Unsatisfiable (`a >= size`, `bytes=-0`, or any range on an empty file): **416** with
    `content-range: bytes */size` and an empty body.
  - No header, a malformed one (`a > b` included), another unit or several ranges: **200** with the whole file,
    streamed.
  - HEAD: Hono 4.13 answers HEAD by running the GET handler and wrapping its response as
    `new Response(null, res)`, which never consumes or cancels the body, so a streamed body would leak its file
    descriptor. The handler therefore checks `c.req.method === 'HEAD'` after computing the status and headers and
    returns them with a `null` body, never calling `createReadStream`.
- `storage/local.ts`: `deleteFeedMedia(feedId)` returns without doing anything when `!isUuid(feedId)`.
- Feed delete paths (deliberate change 9). Each feed `DELETE` gains `RETURNING id`; after the delete (after commit
  inside `sql.begin`), `for (const id of ids) await storage.deleteFeedMedia(id)`:
  - `routes/papers.ts`, the last paper of a workspace (`DELETE FROM feeds WHERE corpus_id … AND user_id …`);
  - `routes/settings.ts` `clear-feeds`, `clear-everything` and `clear-papers`.

  Workspace delete is **not** a feed delete path: it deletes only the corpus, and `feeds_corpus_id_fkey` is
  `ON DELETE SET NULL`, so the feeds and their media stay. No route deletes users or a single feed. Reading-list
  delete leaves the chapter feeds (Python parity).

- [ ] **Step 1: Write the failing tests.**
  - `config.test.ts`: the default, `''`, `/x/y`, and `x/`, `/x/` and `/x y` throwing.
  - `feed-read.test.ts`: with `audio_status 'ready'` and a post with `audio_key`, `audio_url` starts with
    `/ficino/api/media/feeds/<id>/audio/post_0.mp3?token=`; with `podcast_status 'ready'`, `podcast_audio_url`
    starts with `/ficino/api/media/feeds/<id>/podcast/episode.mp3?token=`; with `publicApiBase: ''` both start with
    `/media/`. Update the existing assertions that expected a bare `/media/`. Review Focus 2: strip
    `/ficino/api` from the returned `audio_url`, save a file with `storage.saveAudio`, and GET it through the app:
    200 with the bytes.
  - `media.test.ts` (a 100-byte file):
    - no `Range`: 200, `accept-ranges: bytes`, `content-length: 100`;
    - `bytes=0-1` (Safari's probe): 206, 2 bytes, `content-range: bytes 0-1/100`;
    - `bytes=90-`: the last 10; `bytes=-5`: the last 5; `bytes=50-500`: clamped to `50-99`;
    - `bytes=100-` and `bytes=-0`: 416 with `content-range: bytes */100`;
    - `bytes=0-1,5-6`, `items=0-1` and `bytes=5-2` (start after end): 200 with the whole file;
    - `bytes=-500` (suffix longer than the file): 206, 100 bytes, `content-range: bytes 0-99/100`;
    - HEAD with `bytes=0-1`: 206, `content-length: 2`, empty body; HEAD without `Range`: 200,
      `content-length: 100`; neither HEAD opens a stream: the number of entries in `/proc/self/fd` after 50
      HEADs is at most 5 higher than before (a leak adds about 50);
    - a valid token for user B's feed key, as user A: 404 `Media not found` with and without `Range`; a bad
      token is still 403 before any range logic (Review Focus 5).
  - `local.test.ts`: `deleteFeedMedia('nope')` resolves and removes nothing. In the existing
    `non-UUID ids throw "invalid id"` test, delete the line
    `await expect(st.deleteFeedMedia(bad)).rejects.toThrow('invalid id');` (it now resolves); the new case
    replaces it, and every other line of that test stays.
  - `settings.test.ts` (clear-feeds, clear-papers, clear-everything) and `papers.test.ts` (`'204, files gone …
    feeds removed with the last paper of the corpus'`): before the call, `saveAudio` and `savePodcastEpisode` for
    user A's feed and for user B's feed; afterwards `{mediaDir}/feeds/<A's feed>` is gone and B's is still there.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message
  `feat(server): playable media URLs, /media byte ranges, feed media cleanup on delete`.

### Task 10: The group-chat stuck check

**Files:**
- Modify: `server/src/feed/status.ts`, `server/src/routes/messages.ts`
- Test: `server/test/routes/messages.test.ts`, `server/test/feed/status.test.ts` (extend both)

**Interfaces:**
- Produces in `status.ts`:
  `checkStranded(queue: Pick<JobQueue, 'getJobState'>, taskId: string): Promise<{ stranded: boolean; taskState: string; err?: string }>`.
  Stranded means `isStuckJobState(state)`, or `completed`, or a `getJobState` throw (`taskState: 'unknown'`,
  `err` = the message). The summary GET (`GET /messages/papers/:paper_id`) uses it in place of its inline
  try/catch with unchanged behaviour (plan 04 rulings 6 and 7).
- `POST /messages/groups`: the placeholder insert becomes `ON CONFLICT (id) DO NOTHING`. The id is a fresh
  `randomUUID()`, so a conflict means the worker already wrote the row, and its row wins.
- `GET /messages/groups/:synthesis_id`: when the row is `generating` with a `task_id` and `checkStranded` says
  stranded, log `corpus_synthesis_stuck_generating {synthesis_id, old_task_id, task_state, err?}` at warn, then:
  - when `messages` is a non-empty array, heal without a dispatch or a charge:
    `UPDATE corpus_syntheses SET status = 'complete', task_id = NULL WHERE id AND task_id = <old>`, and answer
    `complete`;
  - else `await chargeUserRateLimit(c, 'summary')` (the POST's bucket), send `generate_corpus_synthesis` with
    `{synthesis_id, paper_ids, name, user_id}` from the row, then
    `UPDATE … SET task_id = <new> WHERE id AND status = 'generating' AND task_id = <old>`, and answer `generating`
    with the new `task_id`.

  `error` rows keep their behaviour (no regenerate, Python parity). `created`, `retry` and `active` jobs are not
  stranded.

- [ ] **Step 1: Write the failing tests** (in `describe('group chats')`, using its `synth(...)` helper).
  - `status.test.ts`: `checkStranded` for each job state and for a throwing queue.
  - A `generating` row on `'celery-abc'` (missing) re-dispatches: a new 36-character `task_id`, a `job_progress`
    row on `generate_corpus_synthesis`, and the stored `task_id` updated.
  - A `generating` row on its own completed job with non-empty `messages` answers `complete`, adds no
    `job_progress` row, and stores `complete` with `task_id` NULL. The same with empty `messages` re-dispatches.
  - A throwing `getJobState` re-dispatches. A `created` job does not.
  - Review Focus 4: under `basic` with `rateLimits.summary: 1`, a stuck GET charges once and a second stuck GET is
    429; the healed case read three times never charges.
  - The POST race: build the app with a queue whose `send` writes the `complete` row with messages before it
    returns. After the POST the row is still `complete` with its messages.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message `fix(server): group chats recover from a lost or finished job`.

### Task 11: Archivist posts are never dead for good

**Files:**
- Modify: `server/src/routes/userPosts.ts`, `server/src/tasks/archivist.ts`
- Test: `server/test/routes/user-posts.test.ts`, `server/test/tasks/archivist.test.ts` (extend both)

**Interfaces:**
- A post is **retryable** when `status = 'error' AND task_id IS NULL AND replies->-1->>'role' = 'user'`: nothing
  will ever answer its last turn. `task_id IS NULL` keeps a pending pg-boss retry (a non-final failure keeps its
  `task_id`) from getting a second answer.
- `userPosts.ts`:
  - One helper, `dispatchOrFail(c, postId: string, queue: QueueName, data: Record<string, unknown>): Promise<string>`, replaces the
    two copies of the 503 block. On a send failure it logs `user_post_dispatch_failed`, runs
    `UPDATE user_posts SET status = 'error', task_id = NULL WHERE id = <postId>`, and throws
    `HttpError(503, 'Failed to dispatch Archivist response. Try again.')`. On success it sets `task_id` and returns
    it.
  - `POST /:post_id/replies`, the check-and-flip becomes:
    ```sql
    UPDATE user_posts
    SET replies = CASE WHEN status = 'error' THEN replies - (-1) ELSE replies END || ${sql.json([turn])},
        status = 'pending', task_id = NULL
    WHERE id = ${postId}
      AND (status = 'complete' OR (status = 'error' AND task_id IS NULL AND replies->-1->>'role' = 'user'))
    RETURNING id
    ```
    The retry **replaces** the trailing user turn with the new text: the frontend has already dropped its
    optimistic copy after the 503, so the new text is what the user means. No row still gives 409
    `Previous reply not ready yet`.
  - `GET /:post_id/status`: a `pending` row with a `task_id` whose job state is `failed`, `cancelled` or `missing`
    logs `user_post_stuck_pending` and runs
    `UPDATE … SET status = 'error', task_id = NULL WHERE id AND status = 'pending' AND task_id = <old>`, answering
    `{status: 'error', task_id: ''}`. It does not re-dispatch (no charge path, and a job that kills the process
    would loop). `completed` is **not** stuck here (a late `task_id` write from an earlier follow-up can point a
    live post at a completed job), and a `getJobState` throw leaves the post `pending`.
    An `error` row with a `task_id` whose job state is `failed`, `cancelled` or `missing` (a non-final attempt
    marked it `error` and kept its `task_id`, then the final attempt was hard-killed before its catch ran) logs
    `user_post_stuck_error` and runs `UPDATE … SET task_id = NULL WHERE id AND status = 'error' AND task_id =
    <old>`, answering `{status: 'error', task_id: ''}`; the follow-up retry predicate then applies. An `error` row
    on a `retry`, `created` or `active` job keeps its `task_id` (pg-boss will run it again).
- `archivist.ts`:
  - The error mark becomes
    `UPDATE user_posts SET status = 'error'` plus `, task_id = NULL` only when `ctx.isFinalAttempt`,
    `WHERE id = ${id} AND (task_id = ${ctx.jobId} OR task_id IS NULL)`.
  - A follow-up job whose post's last turn is already `archivist` returns
    `{status: 'complete', user_post_id, idempotent: true}` and writes nothing (a redelivery after its append
    committed). Any other last role still throws `No pending user turn in replies`.

- [ ] **Step 1: Write the failing tests.**
  - `user-posts.test.ts`:
    - Extend `dispatch failure: 503 and status error (deliberate change 4)`: the stored `replies.at(-1)` is the
      user turn and `task_id` is null.
    - After that failure, a follow-up with `'y'` gives 202; the `replies` length is unchanged and ends with
      `{role: 'user', content: 'y'}`; the status is `pending`; a `respond_to_user_post_followup` job was sent.
    - 409 for an `error` row whose `task_id` is set, and for an `error` row whose last turn is `archivist`.
    - Two concurrent retries of a retryable row: exactly one 202.
    - Status: a `pending` row on `'celery-abc'` answers `{status: 'error', task_id: ''}` and is stored `error` with
      `task_id` NULL (Review Focus 3); a `pending` row on a `created` job, on a completed job, and with a NULL
      `task_id` each stays `pending`. An `error` row (last turn `user`) on `'celery-abc'` answers `task_id: ''`,
      is stored with `task_id` NULL, and a follow-up on it then gives 202; an `error` row on a `created` job keeps
      its `task_id` and a follow-up on it is 409.
  - `archivist.test.ts`: on the final attempt a failure leaves `error` with `task_id` NULL; on a non-final attempt
    it keeps `task_id`; a row whose `task_id` belongs to another job is not marked; a follow-up on a row whose last
    turn is `archivist` returns `idempotent: true` and the row stays `complete`.
  - `archivist.test.ts`, the existing `a last turn that is not user throws and marks the post error`: its seed
    `[{role: 'archivist', content: 'Done.'}]` becomes the idempotent case above, so change that test's seed to
    `[{role: 'system', content: 'Done.'}]` (it still pins the throw `No pending user turn in replies` and the
    `error` mark), and add an `replies = []` variant that throws the same way.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message `fix(server): Archivist follow-ups can retry, lost jobs surface as error`.

### Task 12: End-to-end, the ElevenLabs smoke, docs

**Files:**
- Create: `server/test/worker/reading-audio-e2e.test.ts`, `server/scripts/elevenlabs-audio-smoke.ts`,
  `docs/superpowers/plans/2026-11-06-ts-port-05-carryover.md`
- Modify: `server/README.md`, `server/test/PORTING.md`, `docs/superpowers/plans/2026-11-05-ts-port-04-carryover.md`
  (its "Restored `user_posts` rows stuck in `pending` have no recovery path" item gains one line: superseded by
  plan 05 Task 11, see the plan 05 carryover; nothing else in it changes)

**Interfaces:** none new.

- [ ] **Step 1: Write the end-to-end test.** Follow `test/worker/conversations-e2e.test.ts`: one process,
  `AUTH_PROVIDER=none`, fake providers (an `ordering` chat that answers a valid ordering of the two ids, read from
  the prompt's `Paper ID:` lines), a real worker from `startWorker` with env `ELEVENLABS_API_KEY=fake`, and
  `testApp({providers, config: {elevenlabsApiKey: 'fake'}})`. It runs:
  1. Upload `sample.pdf` twice and wait for both to be `complete`.
  2. `POST /reading-lists` with both ids. Poll `GET /reading-lists/:id` until a paper has a rationale.
  3. `POST /reading-lists/:id/chapters/0/generate`. Poll `GET /feed/status/:task_id` until `complete`. The detail
     shows chapter 0 `complete` with a `feed_id` and chapter 1 `unlocked`.
  4. `POST /feed/:feed_id/audio`. Poll `GET /feed/:feed_id` until `audio_status` is `ready`. Each post with an
     `audio_url` plays: strip `/ficino/api`, GET it with `Range: bytes=0-1`, expect 206 and 2 bytes.
  5. Dead-job recovery (deliberate change 13): set `audio_status = 'generating'`, `audio_claimed_at = NOW() -
     interval '1 day'` and drop every post's `audio_key`, as a SIGKILLed job would leave the row. `POST
     /feed/:feed_id/audio` answers 202 with a `task_id`; poll until `audio_status` is `ready` and the posts carry
     `audio_url` again.
  6. `POST /feed/:feed_id/podcast`. Poll until `podcast_status` is `ready` and `podcast_audio_url` is set; GET it:
     200.
  7. `POST /settings/clear-feeds`: the feed's media directory is gone.

  Every chat had a purpose other than `other`, and the fakes saw exactly one `elevenlabs-dialogue` call.
- [ ] **Step 2: Run it.** It passes.
- [ ] **Step 3: Write the smoke script.** `scripts/elevenlabs-audio-smoke.ts` is manual and not part of CI. Copy
  the container and boot block of `scripts/ollama-conversations-smoke.ts` (same sweep labels, 127.0.0.1 only, no
  listener). It needs Ollama (`qwen3.8:27b`, `qwen3-embedding:latest`) and reads `ELEVENLABS_API_KEY` from its own
  environment; it never prints, logs or writes the key. It runs:
  1. Ingest `test/fixtures/sample.pdf` twice; create a reading list; wait for the ordering (print each rationale's
     first 120 characters, or the fallback); generate chapter 0 with `posts_per_generation: 2`.
  2. Without a key: print `SMOKE audio skipped (no ELEVENLABS_API_KEY)` and stop.
  3. With a key: the podcast on the chapter feed. Feed audio (per-post TTS clips, the path the owner's audio rule
     calls broken and that awaits the owner's decision in the carryover) runs only when `SMOKE_FEED_AUDIO=1` is
     also set, after the podcast; without it the script prints `SMOKE feed audio skipped (SMOKE_FEED_AUDIO not
     set)`, so no paid per-clip render happens before that decision. Wrap `fetch` to count calls to
     `api.elevenlabs.io` by endpoint and assert one `text-to-dialogue` call. Print each step's status and time, the
     rendered and skipped counts, the podcast's segment count and total code points, the byte sizes, and whether a
     `Range: bytes=0-1` read returns 206. Print every ElevenLabs response's endpoint, voice id and HTTP status, and
     on a non-2xx the first 400 characters of its body (never a request header), so a failing `host_a`/`host_b`
     voice shows as a dialogue 4xx with ElevenLabs' reason. Write the mp3 files to `SMOKE_OUT` (default a fresh temp
     directory, printed) so the owner can listen to them.

  Usage line in the header: `ELEVENLABS_API_KEY=… LOG_LEVEL=info npx tsx scripts/elevenlabs-audio-smoke.ts > "$SCRATCH/audio-smoke.log"`.
  The controller runs it once, with a key the owner provides, and records the outcome (not the key) in the
  carryover doc, including whether each voice used (the persona voices, `DEFAULT_VOICE`, `host_a`, `host_b`)
  answered 200 on that key. Cost: `planFeedPosts` always plans three openers from distinct personas, even when
  `posts_per_generation` is 2 (W 9.11), so the chapter holds up to 3 posts. By default the run costs one dialogue
  of at most 2000 characters; with `SMOKE_FEED_AUDIO=1` add up to 3 short TTS renders (6 if the default-voice
  fallback fires for each). The per-voice statuses then cover `host_a` and `host_b` only, unless feed audio ran.
- [ ] **Step 4: Update the docs.**
  - `server/README.md`: the `/reading-lists` routes, the audio routes, the four new queues' handlers, the media
    layout `{MEDIA_DIR}/feeds/{feed_id}/audio/post_<n>.mp3` and `…/podcast/episode.mp3`, byte ranges, and the new
    env (`ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_DIALOGUE_MODEL_ID`, `PUBLIC_API_BASE`), and that
    `PUBLIC_API_BASE` supports only same-origin deployments (empty or a path, matching a relative
    `VITE_API_BASE`).
  - `PORTING.md`: tick every `plan05` line with its test. Owners:

    | Python tests | Task |
    |---|---|
    | `test_reading_lists.py` ×9, the four reading-list `test_idor_followups.py` tests, the three `test_wave3_correctness.py` reorder/apply tests, `test_constants.py::test_chapter_sql_encodes_first_unlocked` | T2 |
    | `test_shared_adoption.py::test_chapter_sql_imported_by_both_sites` (one `insertChapters` used by the route and the job), `test_reading_list_persist.py` ×4 (`execute_in_transaction` maps to `sql.begin`: tick the commit/rollback pair against the trigger test) | T3 |
    | `test_chapter_post_validation.py::test_reading_list_tasks_imports_validator`, `test_wave3_task_fixes.py::test_generate_chapter_writes_feed_posts_index` | T4 |
    | `test_media_claim_reclaim.py` ×5 | T6 |
    | `test_podcast_settings.py::test_podcast_task_applies_owner_settings` | T7 |
    | `test_feed_audio_rate_limit.py` ×4 | T8 |
    | the bp10 audit line: add `reading_list.delete` (T2) and close it | T2 |
  - The carryover doc `2026-11-06-ts-port-05-carryover.md`, in plan 04's format: the deliberate changes, the
    rulings made during execution, the e2e and smoke results, the parity behaviours kept on purpose (listed under
    Deliberate changes above), the deferred minors, and the carry into plan 06. At least:
    - **Legacy stitched podcast.** Restored feeds whose `podcast_segments` carry per-segment `audio_key`s
      (`podcast/seg_<n>.mp3`, the old stitched form) have no `episode.mp3` and must not be played: null their
      `podcast_status` during the restore so they regenerate as one render.
    - **Legacy media files.** Supabase keys were `{user}/feeds/{feed}/…`; copy them to `feeds/{feed}/…` under
      `MEDIA_DIR`, or null the status columns.
    - **Compose.** API and worker share `MEDIA_DIR` and `SIGNED_URL_KEY`; set `PUBLIC_API_BASE` to the prefix
      nginx strips; the frontend's CSP (`media-src 'self' blob: https://*.supabase.co`) already allows
      same-origin audio.
    - **Stale audio after `regenerate_post` or an append** (parity): the post loses or never gets `audio_key`
      while the feed stays `ready`, and `POST /audio` short-circuits. A frontend-redo or feed-rework item.
    - **Reading-list ordering UX** (parity): the frontend gives up after 2 minutes, shorter than one 180 s retry,
      so a failed first attempt or a fallback ordering shows Retry.
    - **The Archivist retry path is API-only**: `UserPostCard` offers a reply only on `complete`, so an `error`
      post shown in the UI still needs the frontend redo to expose the retry.
    - **A failed first Archivist answer is a dead end** (parity): its `replies` is `[]`, so no follow-up can
      retry it; the user deletes and reposts. A product decision for the frontend redo.
    - **Future reprocess endpoint** (plan 02 carry): neither Python nor TS has one; an empty re-run keeps stale
      chunks while `chunk_count` is 0 (Python parity). Carry into plan 06 unchanged.
    - **Dead audio claims are recovered only through the POST** (deliberate change 13): a feed whose job died
      shows `generating` until the user presses play again after the reclaim window. A sweep is not needed for
      parity; note it for the frontend redo.
    - **Owner decision: feed Listen mode plays per-post clips with hard cuts.** Feed audio is one TTS file per
      post, played by `ListenView` as a playlist (Python parity). The owner's audio rule says stitched per-clip TTS
      with hard cuts reads as broken. A single continuous render needs a different design (for example one
      dialogue or narration call over the whole feed, which the 2000-character dialogue cap limits). Ask whether to
      keep the playlist for the frontend redo. The controller's report-back repeats this question.
    - **ElevenLabs voices (parity risk).** `tts.py`'s docstring calls every id a "first-gen preset voice", but
      several (`host_a` "Drew" `q0IMILNRPxOgtBTS4taI`, `host_b` "Tyler", and the Liz, Matthew, Gregory and Marcos
      persona voices) do not look like the legacy premade ids and may be Voice Library voices a key cannot use.
      Feed audio falls back to `DEFAULT_VOICE`; the podcast has no voice fallback, so an unusable host voice fails
      every podcast with a 4xx. Record the smoke's per-voice statuses here.
    - **Media needs a same-origin API.** `PUBLIC_API_BASE` is empty or a path; a cross-origin API base (an
      absolute `VITE_API_BASE`) is not supported for media, and the shipped CSP would block it anyway.
    - **Restored `corpus_syntheses` rows stuck in `generating` on Celery task ids** read as `missing` under the
      Task 10 stuck check. A row with non-empty `messages` heals to `complete` for free; a row with empty
      `messages` charges `summary` and dispatches a `generate_corpus_synthesis` LLM job on its first view, the same
      cutover cost as the plan 04 `paper_summaries` item. Sweep them during the restore (heal the ones with
      messages, set the rest `error`) or accept the cost.
    - **Restored `user_posts` rows stuck in `pending`** now surface as `error` on the first status poll (Task 11),
      and a follow-up on one whose last turn is a user turn can then be retried. A first answer (`replies = []`)
      stays a dead end. This supersedes plan 04's "no recovery path … mark them `error` during the restore" item;
      marking them `error` during the restore is still fine but no longer needed.
    - The remaining plan 02–04 cutover items, restated with the two items above replacing their plan 04 wording.
- [ ] **Step 5: Run the full suite, the typecheck and the build.** `npm test`, `npm run typecheck` and
  `npm run build` all pass. Report the new file and test counts against the baseline.
- [ ] **Step 6: Commit** with the message `feat(server): reading lists and audio end-to-end, ElevenLabs smoke, plan 05 docs`.

## Carry items taken (from the plan 01–04 carryovers)

| Item | Task |
|---|---|
| `propose_ordering`, `generate_chapter`, `CHAPTER_INSERT_SQL` and its test | 2, 3, 4 |
| `generate_audio_for_feed`, `generate_podcast_for_feed`, `POST /feed/{id}/audio` and `/podcast` | 6, 7, 8 |
| `/media` `Range`; audio URLs `ListenView` can use as-is | 9 |
| `deleteFeedMedia` on every feed delete path (workspace delete is not one) | 9 |
| Group-chat stuck check | 10 |
| Archivist follow-up dead end (plan 04 ruling 9) and the final-attempt crash | 11 |
| Shared `isUuid`; one retry-policy source; distinct-model assertions | 1 |
| Future reprocess endpoint (plan 02): no endpoint exists in Python or TS; an empty re-run keeps stale chunks while `chunk_count` is 0 (Python parity). Not taken; deferred to plan 06 (Task 12 carryover) | — |
| Deferred minors taken: `deleteFeedMedia` throwing on a non-UUID (9), `tokenQuery` in `routes/figures.ts` (9), the duplicated 503 block (11), `UUID_RE` copies (1), the `retryLimit` merge (1), Focus 1 tests asserting the key only (1) | as listed |

Deferred minors not taken here stay listed in their carryover docs; Task 12's carryover says which remain.
