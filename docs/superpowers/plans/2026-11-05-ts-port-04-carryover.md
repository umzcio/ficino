# TS Port 04: decisions and carry-forward

Plan 04 is complete on `ts-port/04-conversations`. It covers:
- the API-side chat client and its LLM error grading;
- the conversation prompt builders and reply grounding;
- the `/personas`, `/replies`, `/messages` and `/user-posts` routes;
- the paper summary, corpus synthesis and Archivist jobs.

The full suite, the typecheck and the build pass. `test/worker/conversations-e2e.test.ts` runs every conversation surface in one process against fake providers:
- upload and ingest two papers;
- the summary (dispatch, status poll, read back);
- a group chat over both papers;
- an Archivist post and a follow-up;
- a feed, then a reply and a zap on post 0, and the conversations list;
- a persona DM and its thread.

Every chat the fakes answered had a recognised purpose. `scripts/ollama-conversations-smoke.ts` is a manual run against a real local Ollama and is not part of CI. Its result is below.

## Deliberate changes from Python

Each is pinned by a test, and each says what it costs if it turns out to be wrong.

1. **The API-side LLM path resolves settings with `providerConfig`**, the same per-call resolution the worker uses. Under `PUBLIC_DEPLOYMENT`, a non-empty operator env var therefore wins on replies, zaps and DMs too. Python's `get_llm_config` let a user override it there. Cost if wrong: a public-deployment user cannot point their synchronous calls at their own provider.
2. **A per-request LLM timeout is graded 503 `LLM provider unreachable. Try again in a moment.`** This is the answer Python gave for an httpx `ReadTimeout`. Python's 504 branch (`asyncio.TimeoutError`) had no source, because nothing wrapped `generate_response` in `wait_for`. The 504 mapping is kept for an explicit `LlmDeadlineError`, which nothing throws yet. In `PORTING.md`, `test_create_reply_main_persona_timeout_maps_to_504` is ticked against its replacement, `a TimeoutError from the provider is 503`. Cost if wrong: a client that keyed on 504 for timeouts sees 503.
3. **The organic-interjection candidate query orders by `sort_order`.** Python had no `ORDER BY`, so ties fell to heap order. Cost if wrong: a different persona wins a tie than Python would have picked.
4. **A follow-up whose dispatch fails marks the post `error` and returns 503 `Failed to dispatch Archivist response. Try again.`** This matches the create path. Python returned 500 and left the post `pending` forever. Cost if wrong: none for users; the post shows `error` instead of spinning (see the carry item on the dead end).
5. **The Archivist answers clearly when every in-scope chunk was embedded with another model.** Without this, plan 03's retrieval guard would make it say "No relevant passages found", which is quietly wrong. The job stores a canned reply and marks the post `complete`: `None of your papers are searchable with the current embedding model (<model>): <n> chunks in scope use a different one. Re-process your papers or switch the embedding model back.` A partly mismatched corpus answers normally and logs `embed_model_mismatch`. Cost if wrong: the user reads a configuration message where Python gave an empty answer.
6. **`GET /messages/papers/{id}` also treats a `generating` row on its own `completed` job as stranded** (Task 8). It re-dispatches, charges `summary` once, and logs `paper_summary_stuck_generating`. The worker commits `status='complete', task_id=NULL` before its handler returns. So a `generating` row pointing at its own completed job can only come from the send-before-upsert race: an `already_generating` job completes, then the upsert points the row at it. The plan's three-state `isStuckJobState` (failed, cancelled, missing) is unchanged; the extra state is added at the summary route only. Cost if wrong: one extra re-dispatch and summary charge in a case that should not occur legitimately.
7. **The final-attempt `error` mark is scoped to the job's own row** (final-review fix wave). When a summary or synthesis job exhausts its retries it sets `status='error', task_id=NULL` only `WHERE status = 'generating' AND (task_id = <this job> OR task_id IS NULL)`. Python's `UPDATE` matched on the paper or synthesis id alone, so after a double dispatch a failing J1 marked the row `error` while J2 still owned it (or had completed it), which re-dispatched and charged again on the next view. The status guard also keeps a row that J2 completed during J1's call `complete`. Pinned in `test/tasks/summary.test.ts` for both handlers, beside the existing tests that the job's own row (and an unowned `generating` row) still becomes `error`. Cost if wrong: a row owned by a job that has since died stays `generating` until the summary stuck check re-dispatches it (group chats have no stuck check yet; see plan 05).

**Non-UUID ids.** The new routes answer a non-UUID path or body id with 404, or with the empty shape, where Python returned 500 on the uuid cast. This follows plan 01's 22P02 mapping and plan 03's `/feed` routes. A 32-hex unhyphenated id, which Python's `UUID()` accepts, is also 404 now. Cost if wrong: none for the frontend, which only sends hyphenated ids.

## Rulings made during execution

They go beyond what the plan specified, so treat them as reviewable.

1. **R1: Task 9's `retrieveChunks(ctx, …)` means a `RetrievalCtx`** (`sql`, `config`, the resolved `ProviderConfig`, `deps`, `logger`, `signal`) assembled in the handler, as plan 03's feed task does. That is the real signature. Cost if wrong: none; the compiler would catch it.
2. **R2: the Ollama smoke is run once by the implementer** against `127.0.0.1:11434`, and its outcome is recorded here even if it fails. Cost if wrong: none; it can be rerun.
3. **`sanitizeInline` uses Python whitespace semantics** (`[PY_WS]+` and `pyStrip`, not JS `\s` and `.trim()`). This is a plan-03 file, fixed in Task 2 with a test, because the global constraints require Python `\s` and `strip` semantics and `dmChunksText` depends on it. Cost if wrong: one line in a shared helper; the plan-03 feed goldens re-run in the full suite and still pass.
4. **Goldens pin the code-point caps on conversation prompts** (the 500 cap on interjections, and code-point slicing on reply, zap and mention posts). A reviewer's minor finding, folded into the same Task 2 fix round. Cost if wrong: a regenerated golden file.
5. **`stripRoleMarkers` stays a superset of Python's**: it also strips U+FEFF. It was a reviewed security choice in plan 03 and only ever strips more. Cost if wrong: a role marker with a BOM is stripped where Python kept it, so prompt bytes differ only on hostile or odd input.
6. **Deliberate change 6 above** (Task 8): the `completed` own-job case.
7. **The `getJobState` throw goes down the stuck branch**, with its own test. The caught error is logged with `task_state: 'unknown'`. Cost if wrong: a transient queue read error re-dispatches a summary that might still finish.
8. **`pyFormatChunks` is narrower than `str.format`** (Task 9). The plan's error list was wrong for Python 3.11. The implementer matched real Python, fuzzed against `str.format` on 24k pairs:
   - `{x` raises "expected '}' before end of string";
   - `{chunks.a}` raises an AttributeError;
   - `!r`, `!s`, `:>5` and `[0]` succeed.

   The one narrowing: a conversion, attribute, index or non-empty format spec on `{chunks}` throws `ValueError: Unsupported replacement field…`. The Archivist prompt is operator-authored DB text, and no sensible prompt uses those forms. Failing loudly beats a half-port of `repr` and format specs. Cost if wrong: such a prompt fails every Archivist job with status `error` instead of rendering.
9. **A post whose follow-up dispatch failed stays `error`, with its trailing user turn** (Task 10). Further follow-ups then answer 409 for good. The user can read the post and delete it. This is the same dead end Python left (as `pending`), now visible instead of a spinner. A retry path would be a new feature, outside the plan. Cost if wrong: after a queue outage, a user must start a new post. See the carry item below.

## Ollama smoke

Run on 2026-11-05 with `qwen3.8:27b` and `qwen3-embedding:latest` on `127.0.0.1:11434`, using `test/fixtures/sample.pdf` (a synthetic 3-page fixture) in a throwaway pgvector container on 127.0.0.1. No listener was started and no port was published beyond that container's loopback mapping, which was removed on exit. Every step completed, and the feed kept 1 of its 2 posts (see the notes):

| Step | Status | Time | Notes |
| --- | --- | --- | --- |
| Ingestion | `complete`, 6 chunks | 4.0 s | |
| Summary | dispatch `generating`, then status `complete`, then GET `complete` | 8.0 s | 9 bubbles, starting `tldr`, `intro`; the prompt asks for 8 types, and the parser keeps every object with `content` |
| DM (skeptic) | 200 | 1.4 s | In character, grounded in the fixture's numbers (nine groups, 4 to 11 members) |
| Feed (`posts_per_generation` 2) | `complete`, `post_count` 1 | 8.0 s | Two `persona_post_missing_content` drops: the `{"posts":[...]}` versus `{"post_type","content"}` contradiction that plan 03 recorded (W §9.8) |
| Reply (skeptic, post 0) | 200 | 1.9 s | Answers the post and the user's question |
| Zap (hype on skeptic) | 200 | 1.8 s | Takes up the skeptic's point about the missing balance-score formula |
| Archivist post | `complete`, 5 sources | 7.0 s | A structured answer citing the fixture paper |

An earlier run of the same script also completed every step. In that run the Archivist produced `Author (2024)`, which the scrubber stripped and logged as `archivist_hallucinated_citation` (Review Focus 5 working on real output). That run printed the summary bubbles under the wrong key (`persona` instead of `type`), so the script was fixed and rerun; the table is the rerun.

## Carry into plan 05

- **`propose_ordering` and `generate_chapter` stay in plan 05.** Plan 03's carryover listed them under plan 04, but they are reading-list jobs. They, `generate_audio_for_feed` and `generate_podcast_for_feed` are the queues with no handler yet.
- **The follow-up dead end (ruling 9).** A possible fix: accept `error` when the last turn is `user`, and re-dispatch without appending. The follow-up failure test does not yet pin the kept user turn.
- **Group chats have no stuck check.** A synthesis whose worker died on its final attempt, or whose job was cancelled or lost, spins forever. This matches Python and lies outside Review Focus 2's summary scope. The final review recommends adding one in plan 05, modelled on the summary route's stuck check (`isStuckJobState`, plus `completed`).
- **From the final review, also for plan 05** (each is listed under the deferred minors below; these are the ones to do there):
  - a shared `isUuid` helper: `UUID_RE` is copied into six or more route files;
  - distinct-model assertions in the Review Focus 1 tests (Tasks 4 and 6): give users A and B different models and assert the model on each call, not only the key;
  - one source for the queue retry policy: `worker/main.ts` (the `retryLimit` lookup in the handler loop) duplicates the override merge in `jobs/queue.ts` (`ensureQueues`). Either read `retryLimit` from the job's own metadata, or resolve both through one shared policy function.
- The plan 03 carry items for plan 05 still apply: the `/feed/{id}/audio` and `/podcast` routes, `/media` `Range` support, and `storage.deleteFeedMedia` on every feed delete path.

## Carry into plan 06 (cutover)

- **Restored `paper_summaries` rows stuck in `generating` with Celery task ids re-dispatch on first view.** pg-boss reports the id as `missing`, which counts as stuck. Each one costs a `summary` charge and an LLM call when its paper is first opened after the cutover. Sweeping them to `error` during the restore changes nothing, since an `error` row also re-dispatches on view.
- **Restored `user_posts` rows stuck in `pending` have no recovery path, as in Python.** Their Celery job will never run, and follow-ups 409. Mark them `error` during the restore, or accept them as dead.
- **Double-encoded legacy `messages`.** `GET /replies/{feed_id}/{post_index}` does not `json.loads` a jsonb string, as Python did. Check restored `post_replies` for string-typed `messages` before switching traffic.
- **A final-attempt worker crash never runs the job's catch block**, so the summary and synthesis rows stay `generating`. For summaries, the API stuck check recovers them; for group chats, see the plan 05 item.
- **The same holds for the Archivist, in live operation and not only for restored data.** A crash on the Archivist's final attempt (process killed, out of memory, a lost lease) never runs its catch, so the `user_posts` row stays `pending` forever, and follow-ups 409. Nothing re-dispatches it. Add a stuck check like the summary one, or accept it as dead.
- **Sweep jsonb shapes before switching traffic.** Run `SELECT count(*) … WHERE jsonb_typeof(col) <> 'array'` on `post_replies.messages`, `persona_dms.messages`, `paper_summaries.messages`, `corpus_syntheses.messages` and `user_posts.replies`. Python `json.loads`-ed a string-typed value; the TS port does not, and where it spreads a decoded value (for example `[...messages, newTurn]` in `routes/replies.ts`) a string becomes one element per character. Fix or re-encode every row the sweep finds.
- The plan 03 cutover items still apply: the re-embed path, the restore re-embed writing `metadata.embed_model`, the `embed_model` backfill for Python-written chunks, and the plan 02 items.

## Known Python-parity behaviours, not changed

The final review raised these and declined to judge them. Each matches Python and stays as is; they may surface in plans 05 and 06 or in the frontend redo.

- **Frontend poll gap after deliberate change 6.** When the status poll reports `complete` but the follow-up `GET /messages/papers/{id}` re-dispatches, `PaperChat` shows the new `generating` snapshot and does not start a second poll, so the user waits for a reload.
- **`cancelled` and `missing` jobs read as `generating` on the summary status poll** (`GET /messages/papers/{id}/status/{task_id}`); only the summary GET's stuck check treats them as stranded.
- **Send before insert.** The summary and group-chat routes send the job before they upsert the `generating` placeholder, so a fast job can run before its row exists.
- **Anthropic SDK errors grade 500.** `llmErrorToHttp` maps network, timeout and HTTP status errors; an SDK error of another class falls through to 500 `Internal error. See server logs.`
- **No abort on client disconnect.** A synchronous reply, zap or DM keeps its LLM call running after the client goes away.
- **No regenerate for a group chat in `error`.** The only way out is to create a new group.
- **Unbounded group input.** `POST /messages/groups` puts no length limit on `name` or on the `paper_ids` list.
- **The summary status route is unscoped.** It checks the user is signed in, not that the paper or task is theirs (it returns only a status).
- **Archivist error, then complete.** Every failed attempt marks the post `error`, and a later retry can still mark it `complete`, so a poller can see `error` and stop early.
- **`sort_order` ties.** Personas sharing a `sort_order` still fall to heap order within the tie, even with deliberate change 3's `ORDER BY`.
- **`isTransient` is a superset.** The provider retry predicate retries every 5xx, network error and per-request timeout. That is a superset of what Python retried, kept as plan 03 shipped it.

## Test infrastructure: container labels and the sweep

`test/globalSetup.ts` starts one throwaway `pgvector/pgvector:pg18` container per run, published on 127.0.0.1 only. A run killed before teardown leaves it behind, so the next run sweeps stale ones first. The rules live in `test/helpers/sweep.ts` (`shouldSweep`, unit-tested in `test/helpers/sweep.test.ts`):

- Every container gets the labels `ficino-ts-test`, `ficino-ts-test.owner-pid` (the creating process's pid), `ficino-ts-test.owner-pidns` (`readlink /proc/self/ns/pid`, for example `pid:[4026531836]`) and `ficino-ts-test.owner-host` (the hostname). The sweep finds containers by the `ficino-ts-test` label, not by name.
- If the namespace and hostname labels both match the sweeping process, the pid is checked: a dead owner's container is removed, and a live owner's is kept.
- Otherwise the pid means nothing here. This covers another PID namespace (such as a sandboxed run with the docker socket mounted), another host, the older pid-only labels and an unparsable pid. Such a container is removed only once it is more than 12 hours old (docker's `.Created`), since no run lasts that long. The hostname matters because the initial PID namespace has the same inode on every Linux host.
- The manual smoke scripts (`scripts/ollama-*-smoke.ts`) apply the same labels, so the next test run removes a killed smoke run's container.

## Deferred minors

None blocks anything. Plans 05 and 06 should fix each one or consciously keep it. Grouped by kind:

- **Tests that assert less than their names say.**
  - The Review Focus 1 tests (Tasks 4 and 6) assert the key, not the model. Give users A and B distinct `anthropic_model` values and assert `c.model`.
  - The concurrency tests do not prove that the requests overlapped.
  - The deliberate-change-3 test is one-directional and depends on heap layout.
  - The `TimeoutError` reply test reaches the `NetworkError` branch.
  - Log event names are mostly unasserted.
  - The persona DM delete-by-index test asserts the response rather than the stored row (the single-turn port added in Task 11 does check it), and the cross-user reply-delete assertion is indirect.
  - No test pins the persona DM's rate-limit-before-validator order.
  - Several minor branches are untested: the summary cancel path from `created`, `archivist_persona_prompt_load_failed`, the `*_error_mark_failed` swallow, the `apiLlm` stub-user fallback, and the 120 s Ollama `timeoutMs`.
- **Duplication and structure.**
  - `UUID_RE` is copied into at least six route files; a shared `isUuid` would stop the spread.
  - The 503 dispatch-failure block is duplicated in the `user-posts` create and follow-up handlers.
  - The `retryLimit` override merge is duplicated in `worker/main.ts` and `jobs/queue.ts`, a drift risk.
  - `errorText` is not reused at one call site in `replies.ts`.
  - `summaryParse.ts` also holds prompts, and the summary status helpers live in `feed/status.ts`.
  - `startApi`'s spread of `defaultProviderDeps()` lets an explicit `undefined` override clobber a default.
- **Parity edges, on bad data or odd input only.**
  - `JSON.parse` rejects `NaN` and `Infinity`, which Python accepts, so such output becomes the fallback bubble.
  - The `interjection_prepare_failed` log text differs from Python's `str(e)`.
  - `threadLines` and `convoText` interpolate non-string content without `pyStr`.
  - JS and Python truthiness differ for `[]` and `{}` chunk ids.
  - No golden separates `PY_WS` from JS `\s` in the citation-scrub regexes; add `Doe\x1c(2019)` and `Doe﻿(2019)`.
  - `getInteger` loses precision above 2^53, in a log-only message.
- **Tooling.** The eslint config is broken; this predates plan 04, and the linter was not run.
