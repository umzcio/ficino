# TS Port 02: decisions and carry-forward

Plan 02 (ingestion: storage, job queue, worker, providers, PDF extraction, chunking, figures, the `process_paper` job) is complete on `ts-port/02-ingestion`. The full suite, the typecheck and the build pass. A docker smoke test (API and worker containers on a private network, Postgres pg18) showed the worker picking up an uploaded PDF and the paper leaving `pending` (see the Task 13 report).

## Rulings made during execution

Each ruling says what it costs if it turns out to be wrong. They go beyond what the plan specified, so treat them as reviewable.

1. **`testApp()` stays synchronous.** The test job queue is built over a lazily started pg-boss, and start is awaited inside the queue on first use. Files that never touch the queue never start pg-boss, so every existing test call site is unchanged. Cost if wrong: a small indirection in `JobQueue` or the test helper.
2. **Task 3 review minors were promoted into a fix round** (progress upsert for cron jobs with no `job_progress` row, stopping a partly started boss, `sql.end` skipped when `boss.stop` throws, a shared mutable `MISSING` object). They were failure-path correctness and cheap. Cost if wrong: one fix round.
3. **Task 5 review minors were promoted into a fix round** (a test that asserted nothing, the token check coming before the DB lookup, 500s on inputs Python handled, empty `workspace_id` fallback, canonical `paper_id` signing). Cost if wrong: one fix round.
4. **Default model names differ from Python's call-site literals on purpose.** This is a model refresh allowed by the spec, and the `figure_detect` Ollama default is a listed bug fix. The local cross-encoder rerank model (`rerank.localModel`) is dropped by the spec; plan 03 handles the rerank providers. Cost if wrong: a default to change.
5. **OpenAI embeddings get `withRetry`** (3 attempts, 2 s then 6 s, on transient errors or 429). The spec's "same behavior" outranks the plan table's silence, and Python's openai SDK retried 429, 5xx and connection errors by default. Cost if wrong: a few seconds of extra latency on hard failures.
6. **`cropPage` renders the full page and copies the box rows into a box-sized pixmap**, so crops equal Python's crop of a full render by construction. The spec outranks the plan's bbox-pixmap technique. Cost if wrong: one extra full-page render per detected figure page. (Superseded in part by ruling 8.)
7. **Metadata failure paths return `authors: []`**, as Python does, rather than the brief's "all nulls". Task 12 ports Python's truthiness check for the UPDATE. Cost if wrong: a type tweak.
8. **A render-once handle in `pdf.ts`.** A page is rendered once, the PNG goes to the detector and the crops are copied from the same pixmap, which is disposed in `finally`. Each page's detections are sliced to `MAX_FIGURES_PER_PAPER` before cropping. This matches Python's crop-from-one-raster. Cost if wrong: up to 4 live page pixmaps (about 6 MB each) in the WASM heap.
9. **The crop x1 is `trunc(0.64 * W)`, not 0.66.** The plan had a typo (0.6 plus 0.04 padding); Python is the source of truth. Cost: none.
10. **Ollama vision does not retry 4xx.** Python's `except HTTPStatusError` retried 4xx despite its docstring. This follows the shared `isTransient` and the LLM path; retrying a 4xx is waste. Cost if wrong: a lost retry on a flaky 4xx.
11. **`extractFigures` must not reject until every in-flight page callback has settled**, otherwise `processPaper`'s `closePdf` in `finally` could race a page still using the document (WASM use-after-free). Cost if wrong: a few milliseconds of extra wait on abort.
12. **postgres.js double-encodes a JSON string passed into jsonb.** Writes go through `sql.json`. The final review audited every jsonb write on the branch (alert metadata, `job_progress.meta`, plan-01 audit and settings). Future jsonb writes must use `sql.json`, not `JSON.stringify`.

## Carry into plan 03

- `/feed/status` maps `JobState` to the wire status using C section 5.2.
- The summary stuck check treats the job states `failed`, `cancelled` and `missing` as stuck.
- The uuid5 feed id is derived from the job id.
- Handlers must not return a lone `{ value: x }` object: `unwrapOutput` unwraps it.
- Rerank providers (Cohere, Voyage) are plan 03's; the local cross-encoder is dropped.

## Carry into plan 04

- The `_get_paper_ids` archivist PORTING lines were reassigned to plan 04.

## Carry into plan 05

- `/media` has no `Range` support (Safari seeking and audio scrubbing). Add it.
- Storage audio and podcast URLs are relative (`/media/...`). The unchanged frontend `ListenView` sets `audio.src` without an API-base prefix, so hydration must emit a URL the frontend can use as-is.
- A future reprocess endpoint: an empty re-run keeps stale chunks while `chunk_count` is 0 (Python parity).

## Carry into plan 06 (cutover)

- Delete `server/test/fixtures/goldens/gen/*.py` together with `worker/`.
- The compose worker service must use `command: ["node","dist/worker/main.js"]`, with the same volumes as the API for uploads, figures and media, the same `SIGNED_URL_KEY`, and no inherited API healthcheck (the image's `HEALTHCHECK` probes port 8000 and would mark the worker unhealthy).
- The API and worker share `MEDIA_DIR`, `UPLOAD_DIR` and `FIGURES_DIR`; mount one volume per directory.

## Plan-01 items closed by plan 02

See the updated list in `2026-10-29-ts-port-01-carryover.md`: 22P02 `pg_message`, cron pruning, `AppDeps` instead of singletons, harness resets pg-boss, concurrent-migrator test and unlock masking, the single env to config type, `HTTPException` headers, and the `figure_detect_anthropic_model` default (now `claude-sonnet-5-5`).

## Deferred minors

Small test-tightening and parity notes; none blocks anything.

- Task 1: `pyIsUpper` ignores Other_Uppercase and Other_Lowercase (such as the Roman numeral and circled letters); migrate logs unlock failures with `console.error`; `mapLimit` does not guard a NaN limit; the pystr and mapLimit tests were written after the code.
- Task 2: the LocalStorage "logs them" test never asserts on the warning; the boot-failure test does not prove "before listening"; `testApp` spreads `Partial<Config>` into dirs and never removes the temp root; LocalStorage test boilerplate repeats; `deleteFeedMedia` throws on a non-UUID while `deletePaperArtifacts` no-ops.
- Task 3: the retry test mutates the real `check_contradictions` queue policy (restored in `finally`); the test boss swallows `error` events; `ensureQueues` test checks one queue.
- Task 4: no worker test that a throwing handler reaches pg-boss (the Task 12 junk-PDF test covers it); the `test_default_for_matches_defaults` PORTING owner is unverified.
- Task 5: enqueue failure is logged twice; figure path checks do not follow symlinks (Python's `resolve()` did); `tokenQuery` lives in `routes/figures.ts` and is imported by `media.ts`.
- Task 6: the Anthropic "no text content" message has no Python counterpart; JS truthiness differs from Python for stored `[]` and `{}` in `providerConfig`; vision precedence is coded twice in `config.ts`; `http.ts` `body.slice` may split a surrogate pair; the "per-request timeout is retried" test reaches the `NetworkError` branch, not the `TimeoutError` name branch.
- Task 7: vector entries are not checked finite (Python has the same gap); no retry-exhaustion tests and no voyage per-batch count test.
- Task 8: MuPDF warnings are now routed through `mupdf.setLog` to the logger (done); crop pixel origin is not asserted against raster probes (also Task 11).
- Task 9: no guard that the sentence-split golden yields more than one chunk; the Greek case is rejected by word length, not the `\w` path.
- Task 10: no tests for the `maxPaperChars` cap or astral code-point caps; the metadata abort test only proves the pre-aborted path; `pyStr` and lower-casing diverge on pathological LLM output and JSON NaN; `PaperMetadata.authors` null is unreachable.
- Task 11: `pyFloat` and `JSON.parse` reject nan and inf that Python accepts; `pyStr` differs from Python `str()` for lists, dicts and large floats; the base64 helper is duplicated in `vision.ts` and `figureDetect.ts`; the `figure_extracted` log drops confidence; the fix diff contains unrelated prettier changes to test fixtures.
- Task 12: `figures.ts` may report a timeout instead of the original non-abort error when both happen; no test for a paper row deleted mid-job. The abort test's timing margin was widened in Task 13.
