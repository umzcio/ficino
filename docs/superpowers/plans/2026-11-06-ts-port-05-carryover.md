# TS Port 05: decisions and carry-forward

Plan 05 is complete on `ts-port/05-reading-audio`. It covers:
- the `/reading-lists` routes, the shared chapter SQL, and the `propose_ordering` and `generate_chapter` jobs (with the
  figure-slot bug fixed);
- the ElevenLabs `speak` provider (single-voice TTS and the one-call dialogue), the `generate_audio_for_feed` and
  `generate_podcast_for_feed` jobs, `POST /feed/{id}/audio` and `/podcast`;
- media on local disk under `{MEDIA_DIR}/feeds/{feed_id}/`, media URLs the unchanged frontend can play, `/media` byte
  ranges, and media cleanup on every feed delete path;
- the carry items: a shared `isUuid`, the retry limit read from the job, distinct-model assertions, the group-chat
  stuck check and the Archivist follow-up dead end.

After this plan every route in the API contract is served by the TS API and every queue in `src/jobs/registry.ts` has a
handler. The full suite, the typecheck and the build pass.

`test/worker/reading-audio-e2e.test.ts` runs the new surfaces in one process against fake providers (a real worker
from `startWorker` with `ELEVENLABS_API_KEY=fake`):
- upload and ingest two papers;
- create a reading list over both; the ordering job stores a rationale per paper;
- generate chapter 0: the chapter is `complete` with a `feed_id` and chapter 1 is `unlocked`;
- feed audio: every post gets an `audio_url` under `/ficino/api/media/`, and each one, with the prefix stripped (what
  nginx forwards), answers `Range: bytes=0-1` with 206 and 2 bytes;
- dead-claim recovery (deliberate change 13): a `generating` row with a day-old claim and no `audio_key`s is
  re-dispatched by `POST /feed/{id}/audio` (202 with a `task_id`) and ends `ready` with every `audio_url` back;
- the podcast: `podcast_status` `ready`, the LLM's four turns stored, the episode answers 200, and exactly one
  `elevenlabs-dialogue` call carried those four turns;
- `POST /settings/clear-feeds` removes `{MEDIA_DIR}/feeds/{feed_id}/`.

Every chat the fakes answered had a recognised purpose, and every ElevenLabs call carried the operator key.

## Deliberate changes from Python

Each is pinned by a test. The plan lists them in full; this is the record.

1. **A chapter's figure slot no longer fails the chapter.** `generate_chapter` loads the scope's figures once and
   treats a `figure` slot as `generate_feed` does (`pickFigure`; a skip drops the slot with
   `figure_post_skipped_no_figures_in_paper` or `figure_post_skipped_no_eligible_figure`). Python failed about 61% of
   default chapters here. `buildPostPrompt` stays outside the slot `try`. Pinned in `tasks/generate-chapter.test.ts`.
   Cost if wrong: none for users; a chapter keeps the posts it could make.
2. **A chapter whose every in-scope chunk uses another embedding model fails loudly**, with `generate_feed`'s message.
   `tasks/generate-chapter.test.ts`. Cost if wrong: the user sees a failed chapter where Python completed an empty one.
3. **The chapter's feed upsert, its `complete` mark and the next chapter's unlock are one transaction**; the
   `feed_posts` index write follows the commit and stays non-fatal. `tasks/generate-chapter.test.ts`.
4. **`generate_chapter`'s owner is `user_id || list.user_id || STUB_USER_ID`** (Python made a NULL owner `"None"`).
5. **`propose_ordering` reads the papers in the list's order** (`ORDER BY array_position`); Python used heap order.
   `tasks/propose-ordering.test.ts`.
6. **Feed audio and podcasts work on local storage.** Python's local backend raised `NotImplementedError`, so the jobs
   always failed. `tasks/feed-audio.test.ts`, `tasks/podcast.test.ts`.
7. **Media URLs carry the public API base**: `${PUBLIC_API_BASE}/media/feeds/...?token=...` (default `/ficino/api`).
   The signed resource and the storage key stay prefix-free. `routes/feed-read.test.ts`, `routes/media.test.ts`.
8. **`/media` serves single byte ranges** (206, 416, `Accept-Ranges: bytes`; HEAD never opens a stream).
   `routes/media.test.ts`.
9. **Every feed delete path removes `{MEDIA_DIR}/feeds/{feed_id}/`**, and `deleteFeedMedia` no-ops on a non-UUID.
   Python left the Supabase objects behind. `routes/settings.test.ts`, `routes/papers.test.ts`, `storage/local.test.ts`.
10. **Group chats get a stuck check**, and `POST /messages/groups` no longer overwrites a row the worker already wrote
    (`ON CONFLICT (id) DO NOTHING`). A stranded row with messages heals without a charge; one without charges
    `summary` and re-dispatches once. `routes/messages.test.ts`, `feed/status.test.ts`.
11. **An Archivist follow-up whose job is gone can be retried.** `GET /user-posts/{id}/status` marks a `pending` post on
    a lost job `error` (`user_post_stuck_pending`) and clears the `task_id` of an `error` post on a dead job
    (`user_post_stuck_error`); a follow-up may retry such a post, replacing its trailing user turn; the Archivist's
    error mark is scoped to its own job and clears `task_id` on the final attempt; a redelivered follow-up already
    answered is an idempotent skip. A failed first answer stays a dead end. `routes/user-posts.test.ts`,
    `tasks/archivist.test.ts`.
12. **Per-post `audio_error` stages name the TS error class** (`exception_NetworkError`, `fallback_HttpStatusError`,
    `upload_Error`; `http_<status>_voice_<id>` unchanged). The frontend never reads them. `tasks/feed-audio.test.ts`.
13. **`POST /feed/{id}/audio|podcast` re-dispatches a dead claim.** The audio queues have `retryLimit: 0`, so nothing
    else reruns a job killed before its catch. A `generating` row whose claim is NULL or older than
    `reclaimMinutes(JOB_TIME_LIMIT_SEC)` is charged and dispatched like NULL or `failed`, and logs
    `feed_audio_stale_claim` / `feed_podcast_stale_claim`. `routes/feed-audio.test.ts` and the end-to-end test.
14. **A podcast whose every in-scope chunk uses another embedding model fails** before any LLM or ElevenLabs spend; a
    partial mismatch logs `embed_model_mismatch`. `tasks/podcast.test.ts`.
15. **ElevenLabs timeouts are total deadlines** (30 s TTS, 180 s dialogue) where httpx's were per phase.
    `providers/speak.test.ts`.
16. **A job abort is never a per-post or per-slot failure.** Every per-post catch in feed audio, every chapter slot
    catch and the podcast script builder's soft-fail catches rethrow on `ctx.signal.aborted`, and both loops check the
    signal after their last item, so the feed ends `failed` and the chapter is not committed. Python's
    `SoftTimeLimitExceeded` was swallowed and the feed could end `ready`. `tasks/feed-audio.test.ts`,
    `tasks/generate-chapter.test.ts`, `tasks/podcast.test.ts`.
17. **Audio input edges.** The podcast's owner-settings load runs inside the failure catch (a settings failure ends
    `failed`; Python left `generating`); a NULL `feeds.user_id` reads `STUB_USER_ID`'s settings; feed audio fails on a
    non-array `posts` with `feed posts is not a list`. `tasks/podcast-settings-failure.test.ts`,
    `tasks/podcast.test.ts`, `tasks/feed-audio.test.ts`.

Changes 18 to 23 came from the final review's fix wave.

18. **A media job writes only while it owns its claim, and stops as soon as it does not.** `claimMedia` returns the
    claim timestamp as a token; every later write (`audio_key`, `audio_error`, `podcast_segments`, `ready`,
    `failed`) is guarded by `<col>_status = 'generating' AND <col>_claimed_at = <token>`, and feed audio checks the
    claim before each paid render, the podcast before the dialogue render and before saving the episode. A deleted
    feed ends the job `{status: 'skipped', reason: 'feed_deleted'}`, removes `{MEDIA_DIR}/feeds/{id}/` again (a
    save may have recreated it after the delete path's cleanup) and logs `feed_audio_feed_deleted` /
    `feed_podcast_feed_deleted`; a claim taken over (a reclaim, change 21's reset) ends it `claim_lost`
    (`feed_*_claim_lost`), leaving the row and files to the new owner. Python kept paying for renders of a deleted
    feed and could overwrite a newer claim's status. `tasks/feed-audio.test.ts`, `tasks/podcast.test.ts`. Cost if
    wrong: a job whose claim is rewritten by something unforeseen stops early and the user presses Listen again.
19. **`propose_ordering` keeps a repeated paper id once**, at its first place after the position sort, and logs
    `propose_ordering_duplicate_ids`. `validateOrdering` keeps its golden parity (duplicates pass the set check);
    Python persisted one chapter per entry, so a padded answer bought a second paid chapter for one paper (both
    routes already 422 that shape). `tasks/propose-ordering.test.ts`.
20. **`generate_chapter` commits only onto the chapter row it read.** The complete mark is
    `WHERE id = <chapter> AND paper_ids = <its paper_ids>`; when that matches nothing (propose_ordering,
    apply-ordering or reorder rebuilt the chapters during the LLM calls) the whole change-3 transaction rolls back
    and the job returns `{status: 'skipped', reason: 'chapter_rebuilt'}` (`generate_chapter_rebuilt`). Python
    committed a feed no chapter pointed at and unlocked the next rebuilt chapter. `tasks/generate-chapter.test.ts`.
21. **A regenerated chapter feed drops its old media.** The chapter upsert's `ON CONFLICT DO UPDATE` also nulls
    `audio_status`, `audio_claimed_at`, `audio_generated_at`, `podcast_status`, `podcast_claimed_at`,
    `podcast_generated_at` and `podcast_segments`, and an updated (not inserted) row has its media directory removed
    after the commit. Python left a `ready` status on the new posts, so they could never be voiced and the old
    episode kept playing. `tasks/generate-chapter.test.ts`.
22. **An Archivist redelivery answers only its own turn.** A job whose post's `task_id` names another job that is
    still `created`, `retry` or `active` skips with `archivist_response_superseded` / `archivist_followup_superseded`
    (a finished or missing job named there does not stop it: a late `task_id` write can name one). A first-answer
    job whose post already has replies skips (`archivist_response_idempotent_skip`) instead of overwriting the
    conversation. `tasks/archivist.test.ts`.
23. **`generate_corpus_synthesis`'s idempotent skip heals a `generating` row** (`status = 'complete'`,
    `task_id = NULL`), so a restored row whose `messages` is a non-empty non-array (a double-encoded string) no
    longer loops through the group-chat stuck check, charging `summary` on every poll. `tasks/summary.test.ts`.
24. **A chapter with no papers retrieves nothing** (controller fix after the final review). `retrieveChunks` reads an
    empty `paperIds` as "no paper filter" and has no user filter, so Python's `generate_chapter` on a chapter whose
    cumulative scope was empty searched every user's chunks. The handler now skips retrieval for an empty scope and
    completes with zero posts. `generate_feed`, `regenerate_post`, the Archivist and the podcast already guarded
    this. `tasks/generate-chapter.test.ts`.

**Non-UUID ids.** As in plan 04, a path or body id that cannot be a UUID answers the route's own 404 (or the empty
shape) where Python returned 500 on the cast. A 32-hex unhyphenated or braced id, which Postgres accepts, is also 404.

## Rulings made during execution

They go beyond what the plan specified, so treat them as reviewable. Grouped by task; the per-task reports hold the
details.

- **Task 1.** Ingestion checks `isUuid(paperId)` without the `String()` wrap; the worker passes `job.retryLimit`
  (read with `includeMetadata`) to the job context, so the per-name policy lookup is gone.
- **Task 2.**
  - A `chapter_index` outside int4 answers 404 `Chapter not found` without a query (Python 500s encoding it).
  - Non-object rationale entries, or a non-array rationale, read as `''` in the detail instead of a 500.
  - Job data carries the client's raw id strings (an uppercase UUID passes), as Python did; handlers must not assume
    lowercase.
  - The bp10 audit PORTING line is closed with the `reading_list.delete` half.
- **Task 3.**
  - The mismatch payload carries `input_count` and `returned_count` beside `missing` and `extra`.
  - Golden mismatch lists are sorted (Python's set order is random under `-I`); with more than five ids Python's
    subset is arbitrary and TS keeps the first five.
  - `pySortBy` uses `count_run` plus binary insertion for every length; a raise among 64 or more mixed keys may name
    another pair than CPython.
  - A float with an integral value prints as `int` in a type-error message (JS cannot tell `1.0` from `1`).
  - Python-set semantics for returned ids: `1`, `1.0` and `true` collapse, `null` is a member, arrays and objects
    throw `unhashable type`.
- **Task 4.**
  - `groundPost` is exported from `feed/slots.ts` and reused rather than re-listed.
  - A non-UUID `reading_list_id` throws `Reading list <id> not found`.
  - The figure-slot check runs after the "no chunks" skip, as in `generate_feed`; the shared `logFigureSkip` serves
    both handlers.
- **Task 5.**
  - The golden carries each case's name, env and call, plus two model-override cases.
  - The exact-2000 golden mixes astral and BMP characters, so a UTF-16 count would reject it.
  - An empty `ELEVENLABS_MODEL_ID=` sends `model_id: ""`, as Python's `os.getenv` does.
  - `voiceIdFor` uses `Object.hasOwn`, so prototype keys map to the default voice.
- **Task 6.**
  - A truthy non-string `content` throws `'<type>' object has no attribute 'strip'`, failing the job as Python did.
  - `pyTitle` maps every character as CPython's `do_title` does.
  - `claimMedia` on a non-UUID returns nothing (the job logs skipped).
  - An extra test pins the after-loop abort check.
  - Feed audio loads no owner settings: the key is operator env only.
- **Task 7.**
  - An abort is never a podcast fallback: the script builder's three soft-fail catches rethrow on abort.
  - The default titles and retrieval reads do not filter non-UUID ids, for parity (Python's cast failed them).
  - Personas are loaded in the handler and passed to the builder.
  - Non-scalar turn values go through `pyStr` (JSON where Python printed a repr).
  - The default fake podcast chat returns a valid four-turn script.
- **Task 8.**
  - Column identifiers come from a fixed map through `sql(identifier)`.
  - `claimed_at` is logged as raw Postgres text.
  - A non-UUID feed id answers 404, after the 501 check.
  - `testApp` gained an optional `logger`.
- **Task 9.**
  - The `bytes` range unit matches case-insensitively (RFC 9110).
  - The HEAD fd-leak test uses a 4 MB file, since a 100-byte file hid the leak under mutation.
  - A 416 carries only `Content-Range`.
  - `PUBLIC_API_BASE` keeps the plan's regex verbatim, which accepts `/.` and `/..` segments (operator-set; it only
    prefixes URLs the browser resolves).
  - A file removed between `stat` and the stream open fails mid-response rather than 404; not addressed.
- **Task 10.**
  - A guarded write that matches nothing answers the row as stored now, not the state this request meant to write.
  - The GET re-dispatch logs `corpus_synthesis_dispatched`, as the POST does.
  - "Non-empty messages" means a JSON array with at least one element.
  - A re-dispatch that loses the take-over race leaves its extra job queued (already charged).
- **Task 11.**
  - A `getJobState` throw on the status route logs `user_post_status_check_failed` and answers the stored row.
  - The idempotent follow-up skip logs `archivist_followup_idempotent_skip`.
  - The status heal re-reads and answers the stored row when its guarded update matches nothing.
- **Task 12.**
  - The end-to-end test asserts the podcast's four LLM turns reach the one dialogue call; it uses four turns because
    fewer than `MIN_SEGMENTS` (4) switches the job to its fallback script.
  - The smoke script exits non-zero when any step throws or the dialogue count is not exactly one, prints
    `UNEXPECTED` beside a range read that is not 206 with 2 bytes, and counts ElevenLabs calls with a `fetch` wrapper
    passed to `startWorker` (the API process makes none).
  - The plan 04 carryover's `user_posts` item gains one line pointing here; nothing else in it changed.

## End-to-end and smoke results

- **End to end:** `test/worker/reading-audio-e2e.test.ts` passes in the full suite (about 15 s). A mutation that stops
  the route re-dispatching a stale `generating` claim fails it at the recovery step.
- **ElevenLabs smoke: not yet run.** `scripts/elevenlabs-audio-smoke.ts` was written and typechecked in Task 12; the
  implementer did not run it (it starts a loopback-published Postgres container, and the real run needs an owner key).
  The controller runs it once with a key the owner provides and records the outcome here (never the key):

  | Item | Result |
  | --- | --- |
  | Ordering (rationales or fallback) | pending |
  | Chapter 0 (`posts_per_generation` 2) | pending |
  | Podcast: status, segments, code points, bytes, `text-to-dialogue` calls (must be 1), range read | pending |
  | Feed audio (`SMOKE_FEED_AUDIO=1` only): rendered, skipped, bytes, range reads | pending, or not run |
  | `host_a` `q0IMILNRPxOgtBTS4taI` (Drew) | pending |
  | `host_b` `rPMkKgdwgIwqv4fXgR6N` (Tyler) | pending |
  | Persona voices and `DEFAULT_VOICE` | pending (only if feed audio ran) |

## Kept on purpose (Python parity)

- ElevenLabs calls are not retried; the dialogue cap is Python's 2000 code points, and a longer script fails the
  podcast rather than being split.
- `regenerate_post` drops a post's `audio_key` while `audio_status` stays `ready` (see the stale-audio item below).
- `apply-ordering` drops client rationale text.
- An ordering fallback stores empty rationales, so the frontend's 2-minute ordering wait ends in Retry.
- A failed first Archivist answer cannot be retried.
- Feed audio is a per-post playlist with hard cuts (an owner decision, below).
- A `posts` item that is not a JSON object fails the whole feed-audio job when the loop reaches it, as Python's
  `post.get` did; the podcast's helpers skip such items, as Python's `isinstance(post, dict)` guards did.

## Carry into plan 06 (cutover)

- **Legacy stitched podcast.** Restored feeds whose `podcast_segments` carry per-segment `audio_key`s
  (`podcast/seg_<n>.mp3`, the old stitched form) have no `episode.mp3` and must not be played: null their
  `podcast_status` during the restore so they regenerate as one render.
- **Legacy media files.** Supabase keys were `{user}/feeds/{feed}/…`; copy them to `feeds/{feed}/…` under `MEDIA_DIR`,
  or null the status columns.
- **Compose.** The API and the worker share `MEDIA_DIR` and `SIGNED_URL_KEY`; set `PUBLIC_API_BASE` to the prefix
  nginx strips; the frontend's CSP (`media-src 'self' blob: https://*.supabase.co`) already allows same-origin audio.
  Set `ELEVENLABS_API_KEY` on both services (the API answers 501 without it; the worker needs it to render).
- **Media needs a same-origin API.** `PUBLIC_API_BASE` is empty or a path; a cross-origin API base (an absolute
  `VITE_API_BASE`) is not supported for media, and the shipped CSP would block it anyway.
- **Restored `corpus_syntheses` rows stuck in `generating` on Celery task ids** read as `missing` under the Task 10
  stuck check. A row with non-empty `messages` heals to `complete` for free; a row with empty `messages` charges
  `summary` and dispatches a `generate_corpus_synthesis` LLM job on its first view, the same cutover cost as the plan
  04 `paper_summaries` item. Sweep them during the restore (heal the ones with messages, set the rest `error`) or
  accept the cost.
- **Restored `user_posts` rows stuck in `pending`** now surface as `error` on the first status poll (Task 11), and a
  follow-up on one whose last turn is a user turn can then be retried. A first answer (`replies = []`) stays a dead
  end. This supersedes plan 04's "no recovery path … mark them `error` during the restore" item; marking them `error`
  during the restore is still fine but no longer needed.
- **Future reprocess endpoint** (plan 02 carry): neither Python nor TS has one; an empty re-run keeps stale chunks
  while `chunk_count` is 0 (Python parity). Carried unchanged.
- **The remaining plan 02–04 cutover items**, restated:
  - Delete `server/test/fixtures/goldens/gen/*.py` together with `worker/`.
  - The compose worker service runs `command: ["node","dist/worker/main.js"]` with the API's volumes (`UPLOAD_DIR`,
    `FIGURES_DIR`, `MEDIA_DIR`, one volume each), the same `SIGNED_URL_KEY`, no inherited API healthcheck, and
    `stop_grace_period: 40s` or more.
  - Compose environment: `ENVIRONMENT`, `CORS_ORIGINS`, `SIGNED_URL_KEY`; fix the healthcheck port and start-period.
  - Auth provider versus the restore (restored data is re-keyed to the stub user); IP rate limits behind a proxy
    collapse to one bucket; the restore must be data-only or stamp `schema_migrations`.
  - Synchronous extraction has no hard limit; consider a `worker_thread` terminated at `JOB_TIME_LIMIT_SEC`.
  - Re-embed on an embed-setting change, the restore re-embed writing `metadata.embed_model`, and the `embed_model`
    backfill for Python-written chunks.
  - A soft-limit abort of `generate_feed` discards the posts already generated before the retry.
  - Restored `paper_summaries` rows stuck in `generating` on Celery task ids re-dispatch (and charge) on first view.
  - Double-encoded legacy `messages`: sweep the jsonb shapes (`jsonb_typeof(col) <> 'array'`) on `post_replies`,
    `persona_dms`, `paper_summaries`, `corpus_syntheses` and `user_posts.replies` before switching traffic.

## Carry into the frontend redo

- **Owner decision: feed Listen mode plays per-post clips with hard cuts.** Feed audio is one TTS file per post,
  played by `ListenView` as a playlist (Python parity). The owner's audio rule says stitched per-clip TTS with hard
  cuts reads as broken. A single continuous render needs a different design (for example one dialogue or narration
  call over the whole feed, which the 2000-character dialogue cap limits). Ask whether to keep the playlist for the
  frontend redo. Until then the smoke renders feed audio only with `SMOKE_FEED_AUDIO=1`.
- **Stale audio after `regenerate_post` or an append** (parity): the post loses or never gets `audio_key` while the
  feed stays `ready`, and `POST /audio` short-circuits. A frontend-redo or feed-rework item.
- **Reading-list ordering UX** (parity): the frontend gives up after 2 minutes, shorter than one 180 s retry, so a
  failed first attempt or a fallback ordering shows Retry.
- **The Archivist retry path is API-only**: `UserPostCard` offers a reply only on `complete`, so an `error` post shown
  in the UI still needs the frontend redo to expose the retry.
- **A failed first Archivist answer is a dead end** (parity): its `replies` is `[]`, so no follow-up can retry it; the
  user deletes and reposts. A product decision for the frontend redo.
- **Dead audio claims are recovered only through the POST** (deliberate change 13): a feed whose job died shows
  `generating` until the user presses play again after the reclaim window. A sweep is not needed for parity.
- **`GET /messages/groups/{id}` can now answer 429** for a stuck row whose user is out of `summary` budget (Task 10);
  `GroupChatView` polls this route and shows it as an error until the bucket refills.

## ElevenLabs voices (parity risk)

`tts.py`'s docstring calls every id a "first-gen preset voice", but several (`host_a` "Drew" `q0IMILNRPxOgtBTS4taI`,
`host_b` "Tyler", and the Liz, Matthew, Gregory and Marcos persona voices) do not look like the legacy premade ids and
may be Voice Library voices a key cannot use. Feed audio falls back to `DEFAULT_VOICE`; the podcast has no voice
fallback, so an unusable host voice fails every podcast with a 4xx. The smoke's per-voice statuses go in the table
above.

## Deferred minors

None blocks anything. Plan 06 should fix each one or consciously keep it.

- **Taken in plan 05** from earlier carryovers: the `UUID_RE` copies and the `retryLimit` merge (Task 1), the Focus 1
  tests asserting the key only (Task 1), `deleteFeedMedia` throwing on a non-UUID and `tokenQuery` living in
  `routes/figures.ts` (Task 9), the duplicated 503 dispatch block in `user-posts` (Task 11). Every other deferred minor
  in the plan 01–04 carryovers is still open and stays listed there.
- **New in plan 05.**
  - The stale-claim predicate is written twice in SQL, in `dispatchMedia` (`routes/feed.ts`) and `claimMedia`
    (`audio/feedAudio.ts`); the boundary tests pin both, but a change to one must change the other.
  - `dispatchMedia` reads `c.req.param('feed_id')!` on an untyped path.
  - `dispatchOrFail`'s `task_id = NULL` on a send failure is unobservable today (the row already has NULL there), so
    no test pins it.
  - The Archivist success path's `UPDATE user_posts SET task_id = <new>` is unconditional; a job that fails its final
    attempt first leaves the row pointing at a failed job, which the status route then clears.
  - A podcast render that finishes after the soft limit fired is still saved and marked `ready` (the work is done).
  - `podcast_segments` is written before synthesis and never cleared on failure.
  - `parseRange` is exported but tested only through the route.
  - Regenerating a root-owned golden file needs the file itself made writable for the image user, not only its
    directory.
  - A persona key for a truthy object `persona` goes through `pyStr` (JSON) where Python printed a repr; it only
    changes the spoken name.
  - The smoke script is typechecked but has not been run by its author.
- **From the final review (not fixed).**
  - `POST /feed/{id}/audio|podcast` writes nothing before the job claims, so every POST between a dispatch and the
    claim (a reload, a second tab, a busy queue) charges `audio` again and enqueues a job that then skips; on a
    stale claim that means one dead claim can be charged more than once. Python parity for NULL/failed rows; a
    guarded `<col>_claimed_at` stamp before the charge would make one request win.
  - The podcast's titles-query abort rethrow (`audio/podcast.ts`) has no test: the titles query is SQL and never
    sees the signal, so no fake reaches it. The retrieval rethrow is pinned.
  - The podcast's final `ready` write that matches no row (a delete between the pre-save claim check and the save)
    is covered by the same guard as feed audio but has no podcast-specific test; the window is one SQL round trip.
  - Change 22 is skipped when the newer follow-up's `task_id` write has not landed yet (`task_id` still NULL); the
    redelivery then answers the newer turn, as before.
  - A media job that loses its claim (change 18) may leave the one file it saved just before noticing in the
    feed's media directory; the next render of that index overwrites it and a feed delete removes it.
- **Tooling.** The eslint config is still broken; the linter was not run.
