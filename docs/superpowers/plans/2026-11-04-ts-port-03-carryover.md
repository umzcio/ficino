# TS Port 03: decisions and carry-forward

Plan 03 (retrieval, the persona feed generator, the alert and preference jobs, the `/feed` routes and `/search`) is complete on `ts-port/03-feed`. The full suite, the typecheck and the build pass. `test/worker/feed-e2e.test.ts` runs the whole path in one process (upload, ingest, generate, read, search, regenerate, fan-out jobs) against fake providers. `scripts/ollama-feed-smoke.ts` is a manual run against a real local Ollama; it is not part of CI. Its original run planned 12 slots (the user's `posts_per_generation` of 12 overrides the request's `num_posts`, as in Python) and produced 2 posts on a 6-chunk paper; the other 10 were dropped with `slot_skipped_no_fresh_chunks`. The script now sets `posts_per_generation` to 4 first and reports that planned count.

## Deliberate changes from Python

Each is pinned by a test, and each says what it costs if it turns out to be wrong.

1. **`regenerate_post` on a figure post reuses its own figure** (looked up owner-scoped), else regenerates as a plain post. Python could pick any figure. Cost if wrong: a regenerated figure post shows the same figure again.
2. **Retrieval only considers chunks whose `metadata->>'embed_model'` equals the configured embedding model.** `generate_feed` and `regenerate_post` log one `embed_model_mismatch` warning with `{expected, excluded_chunks}`. Cost if wrong: chunks embedded with another model are invisible to retrieval until re-embedded (see the plan 06 item below).
3. **Personas are loaded once per job**, with no module-level cache. A persona edited mid-job is not seen by that job. Cost if wrong: none for users.
4. **A blank or whitespace first author makes the short cite fall back to the title.** Cost if wrong: a cite string differs from Python in that edge case.
5. **`rerank_provider=local` widens the SQL candidate set, then passes the order through** with a `rerank_local_unavailable_passthrough` warning. The local cross-encoder is dropped by the spec. Cost if wrong: weaker ranking for users who selected `local`.
6. **Any throw in `generate_feed` is retried by pg-boss** (2 retries, 30 s delay). Python's behavior varied by where it threw. The derived feed id and the idempotent-skip path make the retry safe (pinned by the retry end-to-end test). Cost if wrong: a slower failure.
7. **Append mode on a feed the user does not own throws `Feed <id> not found` before any settings, embedding or LLM work.** Python continued, spent LLM calls, and wrote `feed_posts` rows under the other user's feed id (an index overwrite across tenants). Only a bypassed API can reach this path. Cost if wrong: a divergence from Python on an unreachable path.

## Rulings made during execution

They go beyond what the plan specified, so treat them as reviewable.

1. **`FeedFigure` and `Contradiction` live in `src/feed/types.ts`.** One types module, rather than also exporting them from `prompts.ts`. Cost if wrong: none.
2. **`src/tasks/feed.ts` stays one file of about 630 lines.** The contradiction job imports its figure loader and helpers from it, and splitting mid-plan was churn. Cost if wrong: a larger file to read.
3. **Concurrent appends keep Python's colliding post ids and index-row overwrite.** `feeds.posts` loses nothing (the concat happens in SQL), but the search index can miss one of two simultaneous "generate more" slices until a re-index. Cost if wrong: that missing search hit.
4. **A non-UUID `append_to_feed_id` or `feed_id` is a 404 `Feed not found`** where Python returned a 500, following the plan-01 22P02 mapping. Cost if wrong: none.
5. **The plan's `::numeric` rationale in the hybrid retrieval SQL was wrong** (on pg18, `real * numeric` gives double). The requirement still holds because untyped postgres.js binds resolve `real * real`. No code consequence.
6. **`/search` rank and `generated_at` follow Python's wire shapes**: `rank` is `pyRound(x, 4)`, `generated_at` goes through `toPydanticIso` (a `Z` suffix), and the legacy scan has no `rank` key. Whitespace-only `q` returns three empty arrays and no `query` key. Cost if wrong: none; these are the contract.
8. **An embed-model mismatch that excludes every in-scope chunk fails `generate_feed`.** It throws `No chunks embedded with <expectedModel>: <n> chunks in scope use a different embedding model. Re-process your papers or switch the embedding model back.` before the persona query embed and any LLM spend, and `/feed/status` shows it as `error`. A partly mismatched corpus still completes with the `embed_model_mismatch` warning only. Final: Ruling: when countEmbedModelMismatch excludes every in-scope chunk, generate_feed throws a clear error (names the expected model and the excluded count, says to re-process papers or switch the embedding model back) before persona retrieval/LLM spend — "quietly empty" is the anti-goal's sibling; the frontend shows `error` from /feed/status — cost: pg-boss retries it twice (~1 min) before the error shows; a partially-mismatched corpus still completes with the warning only
9. **Re-embed on an embed-setting change (or a re-embed action) is carried to plan 06** alongside the restore re-embed. Final: Ruling: re-embed-on-embed-setting-change (or a re-embed action) carried to plan 06 alongside the restore re-embed — no re-embed path exists yet — cost: until then a user who switches embed provider must switch back or re-upload

## Carry into plan 04

- The `/personas` router.
- The summary stuck check: the job states `failed`, `cancelled` and `missing` count as stuck.
- The persona DM (`respond_to_user_post`, `respond_to_user_post_followup`), including its `persona_dm` rate limit.
- The queues with no handler yet: `generate_paper_summary`, `generate_corpus_synthesis`, `propose_ordering`, `generate_chapter`.

## Carry into plan 05

- `POST /feed/{id}/audio` and `POST /feed/{id}/podcast`. Their `rate_limit_audio` charge comes only on dispatch, and they return 501 when there is no ElevenLabs key.
- The queues `generate_audio_for_feed` and `generate_podcast_for_feed` have no handler yet.
- From plan 02, still open: `/media` `Range` support, relative audio URLs and the frontend `ListenView`, and `storage.deleteFeedMedia` on every feed delete path.

## Carry into plan 06 (cutover)

- Re-embed on an embed-setting change (or a re-embed action), alongside the restore re-embed (ruling 9). Until then a provider switch needs a switch back or a re-upload.
- The restore re-embed must write `metadata.embed_model`, or restored chunks stay invisible to retrieval (deliberate change 2).
- Rows in `chunks` written by the Python worker carry no `embed_model` unless the Python side also sets it. Check this before switching traffic, or run a one-off backfill of `metadata.embed_model`.
- A soft-limit abort of `generate_feed` discards the posts already generated, and pg-boss retries from scratch. Persisting the partial slice, or skipping the retry on abort, is worth considering.
- The plan 02 cutover items still apply (delete the golden generators with `worker/`, worker compose command, shared volumes, `stop_grace_period`).

## Deferred minors

Small test-tightening and parity notes; none blocks anything.

- Task 1: `pyUuid` edge parity (Python replaces every `urn:`/`uuid:` and strips all braces; the TS version is case-sensitive about the URN prefix); `randInt` with `hi < lo` and `choices` with a length mismatch are not guarded; the retrieval int fields reuse the `int()` helper, so a blank, `5.0` or `1e3` value does not throw as Python's `int()` does; `pyStr` of arrays uses `JSON.stringify` and the `pystr` test using `[1]` passes by coincidence; no RED run was recorded.
- Task 2: `buildShortCite` returns `Unknown` where Python emits `None` for a null title and null filename; `planFeedPosts` drops Python's `preferences_blended_*` info logs; golden loops have no per-case labels, the `sort_order` test is partly tautological, and there is no NBSP or U+3000 short-cite golden; `eligiblePersonaKeys` with a non-empty set is only tested through the planner.
- Task 3: `formatChunksForPrompt` renders missing content as `None` where Python would raise a KeyError (unreachable for database chunks).
- Task 4: the `thread_posts_type` log uses JS type names; an unhashable `post_type` is coerced where Python raises a TypeError; no golden for a think-only reply that cleans to empty; `parsePostJson` drops Python's three warnings (it takes no logger); NaN and Infinity JSON fall through to the plain-text wrap; `contradiction_classify_unexpected` logs the untruncated result.
- Task 5: warning payloads are unasserted; null content sends `''` where Python sends `None`; the Voyage and Cohere `fetchJson` calls are duplicated; `Number('')` gives 0 in `applyScores` where Python's `float('')` raises.
- Task 6: a NULL-embedding chunk with a matching `embed_model` scores NULL, sorts first and reads as 0; `countEmbedModelMismatch` with empty paper ids is untested; a null `paper_title` in the boost path is untested; `toLowerCase` differs from `str.lower` on edge cases.
- Task 7: `pickFigure`'s fourth parameter defaults to `figure` (callers pass it explicitly); `pickFigure`'s `skip` carries no reason, so the two Python skip logs are rebuilt by the caller; `truthy({})` is true where Python is falsy; a null handle falls back where Python prints `None`; an obfuscated test literal; no combined figure-and-chunk `paper_ref` test.
- Task 8: `writeFeedPostsIndex` uses a cross-join `WITH ORDINALITY` (a `ROWS FROM` zip would be tighter); `truthy({})` for `deleted`; the Focus-1 test does not assert interleaving; `sql.json(... as never)` casts.
- Task 9: a missing-figure fallback keeps an LLM-returned `post_type` of `figure` through `setdefault` (Python does the same); the TTL and figure `paper_ref` fallback are unasserted; the posts cast is unchecked.
- Task 10: a string `"[]"` in `posts` is skipped where Python completes; a non-string `paper_ref` is ignored; the header comment in `alerts.ts` is stale; the `no_pairs` path, the post-feed rerun dedupe, the 8-paper cap and the sampling are untested.
- Task 11: a comment on the Map-to-Record conversion overstates key preservation; the exactly-5 threshold, the null `user_id` fallback and a cross-feed annotation are untested; import order in `handlers.ts`.
- Task 12: a failed job whose output has no string `message` reports `[object Object]` (plan-mandated `String(output)`); the "other users' papers" test does not isolate the `user_id` filter.
- Task 13: a null `post_count` compares as 0 (check whether the column is nullable); `feedFromRow` is exported but only used in its file; a figure-query failure keeps the persisted URLs where Python returns a 500.
- Task 14: the private home-directory path in the smoke script and `goldens/gen/README.md` is fixed (neutral `$SCRATCH` placeholders), and so is the hard-coded planned count in the smoke script (it now sets `posts_per_generation` and reports it). Still open: legacy search sends null content as `''` where Python sends `None`; the scoped-corpus search test asserts only 200, so the paper `user_id` filter is not isolated; there is no backslash-escape test; `/search` error `type` strings for a missing `q` are zod's (`too_small`) rather than pydantic's (`string_too_short`), which the frontend does not read; the smoke script takes per-slot drop reasons from the pino log, not from its own output.
