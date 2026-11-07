# TS Port 02 — Storage, Jobs, Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local storage with signed URLs, a pg-boss job queue with a progress store, a worker entry point
with cron jobs, and the full paper-ingestion pipeline. Also add the `/papers`, `/figures` and `/media` routes.
After this plan, an uploaded PDF becomes chunks, embeddings and figures without Python, Celery or Redis.

**Architecture:** One `server/` package with two entry points. `src/api/main.ts` (exists) sends jobs.
`src/worker/main.ts` (new) runs them. Both share the `JobQueue` wrapper over pg-boss, which stores its tables in
the `pgboss` schema of the app database.

Each job reads its owner's settings once into an immutable `ProviderConfig` and passes it to every provider
call, so no state is shared between jobs. Provider code takes a `ProviderDeps` object (`fetch`, an Anthropic
client factory and `sleep`), which lets tests swap in fakes without touching the network. The pure text
pieces (PDF to markdown, chunker, quality check) are pinned by golden files generated from the Python code.

**Tech Stack:** Everything from plan 01, plus `pg-boss@12.38.0`, `mupdf@1.28.1` (MuPDF WASM, the same engine
as the PyMuPDF 1.28.0 inside the `ficino-worker` image), `js-tiktoken@1.0.21` and `@anthropic-ai/sdk@0.135.0`.

**Spec:** `docs/superpowers/specs/2026-10-29-typescript-port-design.md`. References:
- **C §x** is `ts-port-reference/api-contract.md`.
- **W §x** is `ts-port-reference/worker-inventory.md`.
- **S §x** is `ts-port-reference/schema-tests-data.md`.
- The plan 01 rulings and carry-forward are in `docs/superpowers/plans/2026-10-29-ts-port-01-carryover.md`.
- Where this plan says "port X", the Python file named is the source of truth for every string, number and
  branch not pinned here. Read it.

## Global Constraints

- **Workspace.** Work on branch `ts-port/02-ingestion` in a worktree. Never modify `api/`, `worker/`, `shared/`,
  `frontend/` or `tests/e2e/`. You may read them and run them inside the `ficino-worker` image to make goldens.
- **Plan 01 rules still apply.** ESM, strict TS, NodeNext, all code in `server/`, parameterized SQL only (`sql.unsafe` only for
  migration files and catalog-derived identifiers), wire literals copied exactly, free-text status columns,
  STUB/DEFAULT ids, and commits as `umzcio <umzcio@users.noreply.github.com>` ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Dependencies.** Pin exact versions (no `^`). New dependencies are only the four named in Tech Stack, each
  published at least 14 days before install. No `sharp`, no `openai` SDK (OpenAI and Voyage use `fetch`), no
  `p-limit` (use the `mapLimit` helper from Task 1).
- **No shared state across jobs.** Nothing reads or writes `process.env` after boot. Each entry point reads the
  env once into a frozen `env` object and passes it down. Keep no module-level mutable state beyond lazy
  constant caches, such as the tokenizer.
- **Ollama base URL.** `ollamaBaseUrl` comes from `config.ollamaBaseUrl` only. User settings can never set it
  (SSRF guard).
- **Router mounting.** Never mount a router at `/` with `use('*', requireUser)`, because that would gate
  `/health` and `/auth/login`.
- **Network exposure.** No new listeners. The worker opens no ports. Tests bind Postgres to 127.0.0.1 only
  (plan 01 harness).
- **Python strings and numbers.** Where Python semantics matter (code-point lengths and slices, `str.split()`,
  `str.strip()`, `str.isupper()`, `round()`, `\w`, `\s`), use the helpers from `src/shared/pystr.ts` (Task 1).
  Do not use raw `.length` or `.slice` on text that Python caps by character count.
- **Wire literals.** Job queue names, the `job_progress.meta` shape `{step, paper_id}` and status literals are
  copied from W §2 exactly.

## Review Focus

1. **Two users' jobs at the same time never cross keys.** With A's `process_paper` and B's running concurrently
   in one worker, every Anthropic or Ollama call for A's paper carries A's resolved settings and key, and none
   carries B's. Pinned in Task 12.
2. **Oversized upload with no or false `Content-Length`.** A chunked 60 MB body with no Content-Length gets 413
   `File exceeds 50MB limit` without the server buffering it all. Pinned in Task 5.
3. **Embedding mismatch fails loudly.** A provider that returns the wrong dimension or count leaves the paper
   in `error` with `No embedding provider available: …`, and no chunks are written. Every stored chunk records
   `metadata.embed_model`. Pinned in Tasks 7 and 12.
4. **Unreadable PDFs never hang a paper.** Garbage after `%PDF-`, an encrypted PDF, or a paper deleted
   mid-flight leaves the paper in `error` (or `skipped` when the row is gone), never in `extracting`. Pinned in
   Task 12.
5. **Over-time jobs stop spending.** When a job passes its soft time limit, the in-flight provider `fetch` is
   aborted, no further LLM calls start, and the paper ends in `error`. Pinned in Tasks 3 and 12.

---

### Task 1: Plan-01 carry-forward fixes, worker config, Python-semantics helpers

**Files:**
- Modify: `server/src/http/errors.ts`, `server/src/db/migrate.ts`, `server/src/config.ts`, `server/src/settings/stored.ts`, `server/package.json`
- Create: `server/src/shared/pystr.ts`, `server/src/shared/mapLimit.ts`
- Test: `server/test/http/errors.test.ts`, `server/test/db/migrate.test.ts`, `server/test/config.test.ts`, `server/test/shared/pystr.test.ts`, `server/test/shared/mapLimit.test.ts`

**Interfaces:**
- Produces: these new `Config` fields:

  | Field | Env var | Default | Rule |
  |---|---|---|---|
  | `workerDbPoolMax` | `WORKER_DB_POOL_MAX_SIZE`, falling back to `DB_POOL_MAX_SIZE` | 10 | same ≥2 guard as `dbPoolMax` |
  | `embedDim` | `EMBED_DIM` | 1024 | any other value throws `EMBED_DIM must be 1024 (chunks.embedding is vector(1024))` |
  | `jobTimeLimitSec` | `JOB_TIME_LIMIT_SEC` | 600 | below 120 throws `JOB_TIME_LIMIT_SEC must be at least 120` |
  | `ingestionConcurrency` | `WORKER_INGESTION_CONCURRENCY` | 1 | ≥1 |
  | `maxVisionPages` | `MAX_VISION_PAGES` | 100 | |
  | `contextMaxPaperChars` | `CONTEXT_MAX_PAPER_CHARS` | 200000 | |
  | `contextMaxTokens` | `CONTEXT_MAX_TOKENS` | 150 | |
- Produces: `loadStoredSettings(sql: Sql | postgres.TransactionSql, …)`, with no cast needed at call sites.
- Produces (`pystr.ts`):
  - `PY_WS` (regex source for Python's `str.isspace` set)
  - `pyStrip(s)`
  - `pySplit(s): string[]`, matching no-arg `str.split()`
  - `pyLen(s)`
  - `pySlice(s, start, end?)`, by code points
  - `pyIsUpper(s)`
  - `pyRound(x: number, nd = 0): number`, Python's round-half-even on the exact binary value
  - `PY_WORD` (regex source for Python `\w`: `[\p{L}\p{N}_]`)
- Produces: `mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>`.
  Results come back in input order, and the first rejection rejects the whole call.

- [ ] **Step 1: Write the failing tests.**
  - errors: a 22P02 is logged with `pg_message` holding the Postgres error text. Capture it through a pino
    destination stream.
  - errors: an `HTTPException` thrown with a `res` that carries a `Retry-After: 7` header keeps that header on
    the `{detail}` response.
  - migrate: run two `migrate(sql)` calls concurrently on a scratch DB with separate pools. Both resolve. One
    returns every version, the other returns `[]`. `schema_migrations` lists each version exactly once.
  - migrate: when a migration file throws and the unlock then fails because the connection was killed, the
    error that reaches the caller is the migration's error.
  - config: every default in the Interfaces table, plus the `EMBED_DIM=768` throw and the
    `JOB_TIME_LIMIT_SEC=60` throw.
  - pystr:

    | Call | Expected |
    |---|---|
    | `pyRound(2.675, 2)` | 2.67 |
    | `pyRound(0.125, 2)` | 0.12 |
    | `pyRound(10.25, 1)` | 10.2 |
    | `pyRound(0.5)` | 0 |
    | `pyRound(1.5)` | 2 |
    | `pyRound(-2.5)` | -2 |
    | `pySplit(' a b\x1cc  ')` | `['a', 'b', 'c']` |
    | `pyLen('a😀')` | 2 |
    | `pySlice('😀abc', 0, 2)` | `'😀a'` |
    | `pyIsUpper('ABC 1')` | true |
    | `pyIsUpper('AbC')` | false |
    | `pyIsUpper('123')` | false |
    | `pyIsUpper('ÉCOLE')` | true |
    | `pyStrip('\x85 x 　')` | `'x'` |

    Get the expected values by running each case in `python3 -I -c` before writing it down. If any value above
    disagrees with real Python, Python wins and you fix the table.
  - mapLimit: never more than `limit` calls in flight; results come back in input order.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
  - migrate: in the outer `finally`, run the unlock inside a try/catch. If an error is already propagating,
    log the unlock failure and rethrow the original.
  - errors: rename the log key `msg` to `pg_message`. For an `HTTPException` with `err.res`, copy its headers
    onto the JSON response, but not `content-type` or `content-length`.
  - pystr: `pyRound` must handle ties on the exact decimal expansion. A safe way is to compare `x` against the
    two candidates using `toPrecision(17)` digits; any method that passes the table is fine.
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck`. Everything passes, including the existing 416 tests.
- [ ] **Step 5: Install dependencies.** Run `npm i -E pg-boss@12.38.0 mupdf@1.28.1 js-tiktoken@1.0.21 @anthropic-ai/sdk@0.135.0`.
  Add the scripts `dev:worker` = `tsx watch src/worker/main.ts` and `worker` = `node dist/worker/main.js`.
- [ ] **Step 6: Commit.** `fix(server): plan-01 carry-forward (pg_message, headers, migrate unlock), worker config, pystr`

---

### Task 2: Local storage (PDF, figures, media) and boot-time signing key

**Files:**
- Modify: `server/src/storage/local.ts` (it becomes a class), `server/src/app.ts` (`AppDeps`), `server/src/api/main.ts`, `server/src/routes/settings.ts` (the clear-everything path calls `deps.storage`), `server/test/helpers/client.ts`
- Test: `server/test/storage/local.test.ts`, `server/test/api/main-boot-failure.test.ts`

**Interfaces:**
- Consumes: `signResource` and `resolveSigningKey` from `src/shared/signedUrl.ts`, and `SIGNED_URL_DEFAULT_TTL` and `MEDIA_URL_TTL`.
- Produces: `class LocalStorage`. The constructor is
  `constructor(dirs: { uploadDir: string; figuresDir: string; mediaDir: string }, signingKey: Buffer, logger?: WarnLogger)`.
  Every id argument must be a UUID, or the method throws `Error('invalid id')`.

  | Method | Signature | Behavior |
  |---|---|---|
  | `savePdf` | `(paperId: string, bytes: Uint8Array): Promise<string>` | Writes `{uploadDir}/{paperId}.pdf`, creating the dir, and returns the absolute path. |
  | `pdfPath` | `(paperId: string): string` | |
  | `deletePdf` | `(paperId: string): Promise<void>` | Idempotent. |
  | `saveFigure` | `(paperId: string, filename: string, bytes: Uint8Array): Promise<string>` | Rejects a filename that isn't its own basename or starts with `.`, with `invalid figure filename: "<name>"`. Writes `{figuresDir}/{paperId}/{filename}` and returns the path. |
  | `deletePaperArtifacts` | `(paperId: string): Promise<void>` | Same behavior as today's free function. That function is removed. |
  | `figureImageUrl` | `(paperId: string, figureId: string, ttl = SIGNED_URL_DEFAULT_TTL): string` | Returns `/figures/{paperId}/{figureId}?token={signResource(key, figureId, ttl)}`. |
  | `saveAudio` | `(feedId: string, postIndex: number, bytes: Uint8Array): Promise<string>` | Writes `{mediaDir}/feeds/{feedId}/audio/post_{postIndex}.mp3` and returns the key `feeds/{feedId}/audio/post_{postIndex}.mp3`. |
  | `savePodcastEpisode` | `(feedId: string, bytes: Uint8Array): Promise<string>` | Key `feeds/{feedId}/podcast/episode.mp3`. |
  | `audioUrl` | `(feedId: string, postIndex: number, ttl = MEDIA_URL_TTL): string` | Returns `/media/{key}?token={signResource(key, 'media:' + key, ttl)}`. |
  | `podcastEpisodeUrl` | `(feedId: string, ttl = MEDIA_URL_TTL): string` | Same URL pattern as `audioUrl`. |
  | `mediaFilePath` | `(key: string): string \| null` | Returns null unless the key matches `^feeds/<uuid>/(audio/post_\d+\|podcast/episode)\.mp3$`. |
  | `deleteFeedMedia` | `(feedId: string): Promise<void>` | Removes `{mediaDir}/feeds/{feedId}` recursively. Errors are swallowed and logged. |

  All writes are atomic: write to `<path>.tmp-<random>`, then rename.
- Produces: `AppDeps` gains `storage: LocalStorage` and `signingKey: Buffer`. `testApp()` builds both. The key
  is `resolveSigningKey({ DATABASE_URL })`, and the dirs are a per-process temp dir under `os.tmpdir()`.
- **My call:** the media URL scheme and the `media:` resource prefix. This is new behavior: Python's local
  storage had no audio. The prefix keeps a media token from also working as a figure token.

- [ ] **Step 1: Write the failing tests.** Port the local half of `shared/tests/test_storage_local.py`:

  | Python test | TS check |
  |---|---|
  | `test_pdf_roundtrip` | |
  | `test_local_release_local_is_noop` | `pdfPath` is pure |
  | `test_local_delete_pdf_idempotent` | |
  | `test_local_save_figure_rejects_traversal` | `../x.png`, `a/b.png`, `.hidden.png` and `''` all throw |
  | `test_local_figure_image_url_is_signed` | `verifyToken` on the figure id succeeds; on another id it fails |
  | `test_local_storage_takes_injected_dirs_not_settings` | |

  Then add:
  - Audio and podcast save → url → `mediaFilePath` roundtrip.
  - A media token doesn't verify as the bare key, and a figure token doesn't verify as `media:…`.
  - `mediaFilePath('feeds/../../etc/passwd')` returns null.
  - Non-UUID ids throw.
  - Concurrent `savePdf` calls on the same id leave one complete file and no `.tmp-` leftovers.
  - main-boot-failure: `startApi({ ENVIRONMENT: 'production', DATABASE_URL: <test db>, AUTH_PROVIDER: 'none' })` with
    no `SIGNED_URL_KEY` rejects with the `SIGNED_URL_KEY is required` message, before it listens, and closes its pool.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** `startApi` calls `resolveSigningKey(env)` once, before `createApp`, and builds
  `LocalStorage` from config. In `PORTING.md`, mark `test_unknown_provider_raises` and the eight
  `test_storage_supabase.py` lines `n/a: supabase storage removed (spec Decisions: Storage)`.
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): local storage for PDFs, figures and media with signed URLs`

---

### Task 3: pg-boss queue, job registry, progress store

**Files:**
- Create: `server/migrations/0004_job_progress.sql`, `server/src/jobs/registry.ts`, `server/src/jobs/queue.ts`, `server/src/jobs/context.ts`, `server/test/helpers/queue.ts`
- Modify: `server/src/app.ts` (`AppDeps.queue`), `server/src/api/main.ts`, `server/test/helpers/db.ts` (`resetDb`), `server/test/helpers/client.ts`
- Test: `server/test/jobs/queue.test.ts`, `server/test/jobs/context.test.ts`

**Interfaces:**
- Produces the migration `0004_job_progress.sql`. The table is
  `job_progress(job_id uuid PRIMARY KEY, queue text NOT NULL, meta jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  plus an index on `created_at`.
- Produces: `QUEUES` in `registry.ts`, `as const`, keyed by queue name. The names are the Celery task names
  without the module prefix (W §1):

  | Queue | `retryLimit` | `retryDelay` (s) |
  |---|---|---|
  | `process_paper` | 2 | 30 |
  | `generate_feed` | 2 | 30 |
  | `regenerate_post` | 0 | |
  | `generate_audio_for_feed` | 0 | |
  | `generate_podcast_for_feed` | 0 | |
  | `respond_to_user_post` | 2 | 180 |
  | `respond_to_user_post_followup` | 2 | 180 |
  | `generate_paper_summary` | 2 | 30 |
  | `generate_corpus_synthesis` | 2 | 30 |
  | `propose_ordering` | 2 | 180 |
  | `generate_chapter` | 2 | 180 |
  | `check_contradictions` | 0 | |
  | `check_post_feed` | 0 | |
  | `compute_preferences` | 0 | |
  | `check_stale_papers` | 0 | |
  | `prune_expired` | 0 | |

  Also produces `type QueueName = keyof typeof QUEUES`.
- Produces in `queue.ts`:
  - `createBoss(databaseUrl: string, opts: { max: number; supervise: boolean; schedule: boolean }): PgBoss`. It
    uses schema `pgboss` and `migrate: true`.
  - `ensureQueues(boss: PgBoss, jobTimeLimitSec: number, overrides?: Partial<Record<QueueName, { retryLimit?: number; retryDelay?: number }>>): Promise<void>`.
    It creates or updates every queue in `QUEUES` with its retry policy (with any overrides applied on top) and
    `expireInSeconds = jobTimeLimitSec`. It is idempotent. Overrides exist for tests only.
  - `class JobQueue`. The constructor is `(boss: PgBoss, sql: Sql)`.
  - `send(queue: QueueName, data: Record<string, unknown>): Promise<string>`. It generates the id with
    `randomUUID()`, inserts the `job_progress` row (`job_id`, `queue`, `meta NULL`), then calls `boss.send`
    with that `id`, and returns the id.
  - `getJobState(jobId: string): Promise<JobState>`, where
    `JobState = { queue: QueueName | null; state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed' | 'missing'; progress: Record<string, unknown> | null; output: unknown }`.
    It looks up the queue through `job_progress`, then calls `boss.getJobById`. A non-UUID id, no progress
    row, or no pg-boss job gives `missing`.
- Produces in `context.ts`:
  - `type JobContext = { jobId: string; retryCount: number; signal: AbortSignal; logger: Logger; progress(meta: Record<string, unknown>): Promise<void> }`.
  - `makeJobContext(job: { id: string; retryCount: number; signal: AbortSignal }, sql: Sql, logger: Logger, softLimitMs: number): JobContext`.
    The signal is `AbortSignal.any([job.signal, AbortSignal.timeout(softLimitMs)])`. `progress` upserts
    `job_progress.meta` and `updated_at`.
  - The soft limit is `(jobTimeLimitSec - 60) * 1000`, matching Celery's 540/600.
- Produces: `AppDeps` gains `queue: JobQueue`. `startApi` runs `createBoss` (`max: 3`, `supervise: false`,
  `schedule: false`), then `boss.start()` and `ensureQueues`, and stops the boss in `close()`.
- Produces: `test/helpers/queue.ts`, which exports `testBoss()` (lazy, one per process) and `testQueue()`.
  `testApp()` uses them.
- Produces: after `resetDb()`, there are no rows in `pgboss.job` or `pgboss.schedule`, and the queues still exist.

- [ ] **Step 1: Write the failing tests.**
  - `send('check_stale_papers', {})` returns a UUID. `getJobState` gives `created`, with queue `check_stale_papers`.
  - A worker on a `retryLimit: 0` queue whose handler returns `{ ok: 1 }` leads to `completed` with
    `output` `{ ok: 1 }`.
  - A handler that calls `ctx.progress({ step: 'x' })` and then waits on a latch: while it is still running,
    the state is `active` with progress `{ step: 'x' }`.
  - A handler that throws `Error('boom')` on a 0-retry queue leads to `failed`, and the output's `message` is
    `'boom'`.
  - Retries keep the id. On a test-only queue created with `retryLimit: 1` and `retryDelay: 0`, a handler fails
    on the first attempt and returns `ctx.retryCount` on the second. The same job id ends `completed` with
    output 1.
  - `getJobState('nope')` and an unknown UUID both give `missing`.
  - `ensureQueues` runs twice without error.
  - context: with `softLimitMs = 50`, `ctx.signal` aborts within 500 ms and its reason is a `TimeoutError`.
  - resetDb: after `send()` then `resetDb()`, `getJobState` gives `missing`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** Run worker handlers in tests with `boss.work(name, { pollingIntervalSeconds: 0.5 }, …)`.
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): pg-boss job queue, registry and job_progress store`

---

### Task 4: Worker entry point, cron jobs, stale-paper alerts, pruning

**Files:**
- Create: `server/src/worker/main.ts`, `server/src/worker/handlers.ts`, `server/src/providers/deps.ts`, `server/src/tasks/alerts.ts`, `server/src/tasks/prune.ts`
- Modify: `server/test/PORTING.md` (add the worker-test section)
- Test: `server/test/worker/main.test.ts`, `server/test/tasks/alerts.test.ts`, `server/test/tasks/prune.test.ts`

**Interfaces:**
- Consumes: `QUEUES`, `createBoss`, `ensureQueues`, `JobQueue`, `makeJobContext` (Task 3), and `LocalStorage` (Task 2).
- Produces in `providers/deps.ts`:
  - `type AnthropicLike = { messages: { create(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{ content: Array<{ type: string; text?: string }> }> } }`
  - `type ProviderDeps = { fetch: typeof fetch; anthropic(apiKey: string, opts: { maxRetries?: number; timeoutMs?: number }): AnthropicLike; sleep(ms: number, signal?: AbortSignal): Promise<void> }`
  - `defaultProviderDeps(): ProviderDeps`, which uses `globalThis.fetch`, `new Anthropic({ apiKey, maxRetries, timeout })`
    and an abortable `setTimeout` sleep.
- Produces in `worker/handlers.ts`:
  - `type WorkerDeps = { sql: Sql; config: Config; env: Readonly<Env>; logger: Logger; storage: LocalStorage; queue: JobQueue; providers: ProviderDeps }`
  - `type Handler = (data: any, ctx: JobContext, deps: WorkerDeps) => Promise<unknown>`
  - `HANDLERS: Partial<Record<QueueName, Handler>>`. This task registers `check_stale_papers` and `prune_expired`.
- Produces in `worker/main.ts`:
  - `startWorker(env?: Env, overrides?: { providers?: Partial<ProviderDeps>; handlers?: Partial<Record<QueueName, Handler>>; queueOverrides?: Parameters<typeof ensureQueues>[2]; softLimitMs?: number }): Promise<{ close(): Promise<void> }>`.
    The overrides are for tests only.
  - The boot order: freeze a copy of the env, `loadConfig`, then `createSql(url, { max: workerDbPoolMax })`, then
    `migrate`, then `resolveSigningKey`, then `LocalStorage`, then `createBoss` (`max: 5`, `supervise: true`,
    `schedule: true`), then `start` and `ensureQueues`. Then it registers each handler with
    `localConcurrency` 1, or `config.ingestionConcurrency` for `process_paper`. Each job runs inside
    `makeJobContext`.
  - Schedules: `check_stale_papers` at `0 3 * * *` and `prune_expired` at `17 * * * *`, both `tz: 'UTC'`.
  - `close()` is idempotent. It calls `boss.stop({ graceful: true, timeout: 30000 })` and then `sql.end()`.
  - The direct-run block handles SIGTERM and SIGINT the same way `api/main.ts` does.
- Produces in `tasks/alerts.ts`:
  - `dedupeHash(...parts: string[]): string`, defined as sha256 of the sorted parts joined with `|`, as hex, sliced to 32.
  - `createAlert(sql: Sql, a: { userId: string; alertType: string; title: string; body: string; metadata?: Record<string, unknown>; dedupeHash: string | null }): Promise<void>`. Port the SQL from W §2.4.
  - `checkStalePapers(sql: Sql): Promise<{ status: 'complete'; stale_count: number }>`. Port it from
    `worker/tasks/alert_tasks.py:282-325`. The title, body and metadata are verbatim.
- Produces in `tasks/prune.ts`: `pruneExpired(sql: Sql): Promise<{ rate_limits: number; sessions: number; job_progress: number }>`. It deletes:
  - `rate_limits` rows where `window_ends_at < now()`
  - `sessions` rows where `expires_at < now()`
  - `job_progress` rows where `created_at < now() - interval '8 days'`. pg-boss deletes completed jobs after 7
    days, so these rows read as `missing` anyway.

- [ ] **Step 1: Write the failing tests.**
  - alerts golden vectors:
    - `dedupeHash('stale_paper', '33333333-3333-3333-3333-333333333333')` is `'1a3b13f0d7f786c976c28430304f3fef'`
    - `dedupeHash('contradiction', 'b', 'a')` is `'25523e845988b9444472da722ce05440'`
  - Stale-paper scan:
    - A `complete` paper uploaded 8 days ago with no feed gives one alert to its owner, with the verbatim
      title, body and metadata.
    - A feed of the same user in the same corpus suppresses it. So does a feed with `corpus_id NULL`.
    - Another user's feed does not suppress it.
    - A 6-day-old paper and a `pending` paper get no alert.
    - Running the scan twice still gives one alert.
  - prune: expired rows are removed and live rows stay.
  - worker main:
    - Run `startWorker` and `startApi` concurrently against one scratch DB. Both start, and both migrators
      complete (carry-forward). The scratch DB's `schema_migrations` has each version once.
    - `boss.getSchedules()` lists both crons.
    - A sent `check_stale_papers` job completes with output `{ status: 'complete', stale_count: 0 }`.
    - `close()` resolves, and calling it twice is fine.
  - Use `fileParallelism: false` (already set). Each test that boots a worker closes it in `afterEach`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update `PORTING.md`.** Append a `## worker/tests` section with one line per
  `grep -n "def test_" ../worker/tests/*.py`:
  - `test_auto_tagging`, `test_llm_hardening`, `test_settings_env_hygiene`,
    `test_wave3_task_fixes::{vision_*, claude_vision_*}` and `test_stale_papers` belong to plan02.
  - `test_event_loop` is `n/a: no LoopRunner in Node (W §4)`.
  - Every other line gets the plan that owns its task (generate_feed 03, archivist and summary 04, reading
    list and audio 05).
  - Tick `test_stale_papers` now, with `plan02/T4`.
- [ ] **Step 5: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 6: Commit.** `feat(server): worker entry, cron schedules, stale-paper alerts, pruning`

---

### Task 5: `/papers`, `/figures` and `/media` routes

**Files:**
- Create: `server/src/routes/papers.ts`, `server/src/routes/figures.ts`, `server/src/routes/media.ts`
- Modify: `server/src/app.ts` (mount `/papers`, `/figures`, `/media`)
- Test: `server/test/routes/papers.test.ts`, `server/test/routes/figures.test.ts`, `server/test/routes/media.test.ts`

**Interfaces:**
- Consumes: `deps.storage`, `deps.queue.send('process_paper', { paper_id })`, `requireUser`, `userRateLimit('paper_upload')`, `recordAudit`, `toPydanticIso`, `verifyToken`, and `LIMITS.LIBRARY` (500).
- Produces: the C §1.10 and C §1.7 routes, byte-compatible. Port them from `api/routers/papers.py` and `api/routers/figures.py`.
  - **`paperFromRow`** gives every `Paper` key. Timestamps use `toPydanticIso`. `authors` defaults to `[]` and
    `tags` to `[]`.
  - **Upload middleware order:** `requireUser`, then `userRateLimit('paper_upload')`, then a Content-Length
    pre-check, then `bodyLimit`, then multipart parsing.
    - The pre-check returns 413 when the declared length is greater than `max + 16384`.
    - `bodyLimit` comes from `hono/body-limit`, with `maxSize: max + 16384`. On overflow it returns 413 with
      the same detail.
    - Multipart parsing uses `c.req.parseBody()`, field `file`. A missing or non-File field gives 422
      `{"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required","input":null}]}`.
    - Then come the checks in Python order: extension, actual size, magic bytes, workspace, insert, save,
      update `file_path`, send the job.
  - **Upload enqueue failure:** if `queue.send` throws, the route logs `ingestion_task_dispatch_failed` and
    returns 500 text, and the paper row stays `pending`. This matches Python, where a failed `send_task` gave a 500.
  - **`GET /figures/:paper_id/:figure_id`:**
    - `token` is required, 10–200 characters, or 422.
    - The token is verified before the DB lookup, or 403.
    - Then the owner join (404), then the Python path checks, in order, with the exact details.
    - It serves `image/png` with the file's bytes, read with `fs/promises`.
  - **`GET /media/*` (new; my call):**
    1. The key is the path after `/media/`, and `token` is required.
    2. `verifyToken(key, 'media:' + key, token)`, else 403 `Invalid or expired media token`.
    3. `storage.mediaFilePath(key)` must be non-null, else 404 `Media not found`.
    4. The feed id from the key must be owned by the caller (`SELECT 1 FROM feeds WHERE id AND user_id`), else
       404 `Media not found`.
    5. The file must exist, else 404 `Media file missing`.
    6. Serve it as `audio/mpeg`.
  - **`DELETE /papers/:id`** also calls `storage.deletePaperArtifacts`, and the audit entry follows C §1.10 exactly.

- [ ] **Step 1: Write the failing tests.** Ports, ticking `PORTING.md`:
  - `test_signed_figures.py`: all 7 tests.
  - `test_upload_size_precheck.py`: all 3 tests.
  - `test_auth_scoping.py`: `test_list_papers_returns_only_own_papers`,
    `test_get_paper_rejects_cross_user_read` and `test_get_paper_figures_rejects_cross_user_read`.
  - `test_idor_followups.py::test_upload_paper_rejects_cross_user_workspace`.
  - `test_hydration_offloop.py::test_figures_image_url_hydrated_off_loop`. Its intent is that list URLs are
    signed per row, so assert each `image_url` verifies for its own figure id.

  Then add:
  - Upload happy path: returns 201 with `corpus_id: null`, `status: 'pending'`, and `uploaded_at` matching
    `/Z$/`. The file is on disk, `papers.file_path` is set, and `getJobState` of the sent job gives `created`
    on queue `process_paper` with data `{ paper_id }`.
  - `.PDF` is accepted; `x.txt` gives 400 `Only PDF files are accepted`; `%PDX` gives the magic-bytes 400; an
    unknown `workspace_id` gives 404 `Workspace not found`.
  - Rate limits under `basic`: after 50 uploads the next one is 429, and an invalid upload still uses up a slot.
  - **Review Focus 2:** a `ReadableStream` body with no Content-Length and 60 MB of data returns 413
    `File exceeds 50MB limit`. Assert the stream was not read to the end: count the pulled bytes, which must
    be less than 60 MB.
  - Delete: 204, the files are gone, the audit row matches, and the last paper in a corpus removes its feeds.
  - Media: roundtrip 200 `audio/mpeg`; another user gets 404; a bad token gets 403; a traversal key gets 404.
  - The plan-01 route sweep (`routes-auth.test.ts`) passes with the new routes.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): /papers, /figures and /media routes`

---

### Task 6: Per-job provider config and text generation

**Files:**
- Create: `server/src/providers/config.ts`, `server/src/providers/http.ts`, `server/src/providers/llm.ts`
- Test: `server/test/providers/config.test.ts`, `server/test/providers/llm.test.ts`

**Interfaces:**
- Consumes: `loadStoredSettings`, `buildDefaults`, `mergeSettings`, `isPublicDeployment`, `SETTINGS_TO_ENV` and `ProviderDeps`.
- Produces in `config.ts`:
  - `type ProviderConfig`, deep-frozen:

    ```ts
    {
      ollamaBaseUrl: string;
      llm: { provider: string; ollamaModel: string; claudeModel: string; anthropicKey: string };
      embed: { provider: string; ollamaModel: string; voyageModel: string; voyageKey: string; openaiModel: string; openaiKey: string; dim: number };
      vision: { provider: string; ollamaModel: string; claudeModel: string; anthropicKey: string };
      figureDetect: { provider: string; ollamaModel: string; anthropicModel: string; anthropicKey: string };
      context: { provider: string; ollamaModel: string; anthropicModel: string; anthropicKey: string; maxPaperChars: number; maxTokens: number };
      rerank: { provider: string; voyageModel: string; voyageKey: string; cohereModel: string; cohereKey: string };
    }
    ```
  - `providerConfig(stored: Record<string, unknown>, env: Env, config: Config): ProviderConfig`. It applies the
    `get_active` semantics (W §3.4):
    - Each value is the stored value when it is truthy and not overridden. Otherwise it is
      `env[ENV_NAME] ?? buildDefaults({})[key]`.
    - Under PUBLIC_DEPLOYMENT, a non-empty env var overrides the stored value.
    - `vision.provider` is stored `vision_provider`, else env `VISION_PROVIDER`, else the resolved `llm.provider`.
  - `loadJobSettings(sql: Sql, userId: string, env: Env, config: Config): Promise<{ settings: Readonly<Settings>; providers: ProviderConfig }>`.
    It reads the stored row once. `settings` equals what `resolveUserSettings` returns for the same row.
- Produces in `http.ts`:
  - `withRetry<T>(fn: (attempt: number) => Promise<T>, opts: { attempts: number; delaysMs: number[]; retryable(e: unknown): boolean; sleep: ProviderDeps['sleep']; signal?: AbortSignal }): Promise<T>`.
    It never retries once `signal` has aborted.
  - `fetchJson(deps, url, init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<unknown>`.
    On a non-2xx status it throws `HttpStatusError { status, body }`.
  - `isTransient(e)`: true for a network error, a timeout or a 5xx. False for a 4xx or for the job signal's own abort.
- Produces in `llm.ts`: `generateText(p: ProviderConfig, deps: ProviderDeps, req: { system: string; user: string; temperature: number; maxTokens: number; signal?: AbortSignal }): Promise<string>`.
  Port it from `worker/lib/claude_client.py:37-128`:
  - Ollama: `/api/chat` with timeout 300 s, 3 attempts and delays 2 s then 6 s on transient errors.
  - The Ollama payload and the thinking fallback are as in W §3.3. An empty response throws the Python message.
  - Anthropic (`provider === 'api'`) requires a key; the SDK default is 2 retries. It returns `content[0].text`.
  - Any other provider throws the Python RuntimeError text.

- [ ] **Step 1: Write the failing tests.**
  - Port `test_settings_env_hygiene.py` (4 tests) against `providerConfig`, which is pure:
    - A's key never shows up in B's config.
    - Unset keys fall back to the env.
    - The PUBLIC_DEPLOYMENT override wins.
    - A stored empty string falls back to the env and does not keep the old value.
  - More config cases:
    - `vision_provider` unset with `llm_provider: 'api'` resolves to `api`. Set explicitly to `'ollama'`, it stays `ollama`.
    - A stored `ollama_base_url` is ignored.
  - Port `test_llm_hardening.py` (5 tests) against `generateText`, with a fake `fetch` and an instant `sleep`.
  - An Ollama 503, then 503, then 200 succeeds on the third attempt, after sleeps `[2000, 6000]`.
  - An aborted signal throws immediately and doesn't retry.
  - `provider: 'api'` with no key throws.
  - The fake Anthropic factory receives the key and the model from the config.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** Tick the ported `PORTING.md` lines.
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): per-job provider config and text generation`

---

### Task 7: Embeddings

**Files:**
- Create: `server/src/providers/embed.ts`
- Test: `server/test/providers/embed.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `ProviderDeps`, `withRetry`, `fetchJson` and `mapLimit`.
- Produces:
  - `class EmbeddingUnavailableError extends Error`. It plays the role of Python's RuntimeError, and Task 12
    does not retry on it.
  - `embedTexts(p: ProviderConfig, deps: ProviderDeps, texts: string[], opts: { inputType: 'document' | 'query'; signal?: AbortSignal }): Promise<number[][]>`.
  - `embedModelId(p: ProviderConfig): string`, in the form `` `${provider}:${model}@${dim}` ``, for example
    `ollama:qwen3-embedding:latest@1024`.
- Behavior (port `worker/lib/embedder.py`, with two deliberate changes marked in the table):

  | Provider | Endpoint and body | Batching | Errors and retries |
  |---|---|---|---|
  | `ollama` | **Changed:** `POST {base}/api/embed`, body `{ model, input: string[], dimensions: dim }`. Read `embeddings`. | Batches of 16, up to 4 batches in flight | Timeout 120 s per batch; 3 attempts with delays 2 s, 6 s on transient errors |
  | `voyage` | `POST https://api.voyageai.com/v1/embeddings` with `output_dimension` and `input_type`. Sort the results by `index`. | Batches of 128, 0.5 s sleep between batches | Timeout 120 s; retry up to 5 times on 429 only, waiting `20 * (attempt + 1)` s |
  | `openai` | **Changed:** `POST https://api.openai.com/v1/embeddings`, body `{ model, input, dimensions: dim }`. Python sent no dimensions, so `text-embedding-3-small` returned 1536-d vectors and every paper failed the dim check. | Batches of 100, 1.0 s sleep between batches | |
  | anything else | | | throws `EmbeddingUnavailableError` with the Python message |

  Post-checks run for every provider. The vector count must equal `texts.length` and every vector must have
  `dim` entries. Otherwise it throws `EmbeddingUnavailableError` with the Python messages (`embedder.py:215-226`).
  A missing key for `voyage` or `openai` also throws `EmbeddingUnavailableError`.

- [ ] **Step 1: Write the failing tests.** All of these use a fake `fetch`:
  - Ollama: 40 texts make 3 requests of sizes 16, 16 and 8. Each body includes `dimensions: 1024`. The output
    order matches the input order even when the fake answers batches out of order.
  - Ollama: a 500 is retried, then succeeds.
  - Ollama: a 400 throws without retrying.
  - Voyage: a 429 waits 20 s, then 40 s, through the fake sleep.
  - Voyage: shuffled indices are re-sorted.
  - OpenAI: the body includes `dimensions`.
  - **Review Focus 3:**
    - A 768-d response throws `EmbeddingUnavailableError` and the message mentions the dimension.
    - A short count throws.
    - An unknown provider throws.
  - `embedModelId` matches the format above.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): embedding providers (ollama /api/embed, voyage, openai)`

---

### Task 8: PDF extraction with mupdf, pinned by PyMuPDF goldens

**Files:**
- Create: `server/src/ingest/pdf.ts`
- Create the fixture builder and fixture: `server/test/fixtures/build-sample-pdf.ts`, `server/test/fixtures/sample.pdf` (committed output)
- Create the golden scripts: `server/test/fixtures/goldens/gen/README.md`, `server/test/fixtures/goldens/gen/pdf_text.py`
- Create the goldens: `server/test/fixtures/goldens/sample.pymupdf.md`, `server/test/fixtures/goldens/sample.pages.json`, `server/test/fixtures/goldens/sample.raster.json`
- Create the manual comparison script: `server/scripts/compare-extraction.ts` (not in CI)
- Test: `server/test/ingest/pdf.test.ts`

**Interfaces:**
- Produces in `pdf.ts`. Every function is synchronous, because mupdf is WASM:
  - `type PdfDoc`, a wrapper that holds the mupdf `Document`.
  - `openPdf(bytes: Uint8Array): PdfDoc`. It throws `PdfOpenError` when the bytes don't open as a PDF, when
    the PDF needs a password, or when it has 0 pages.
  - `closePdf(doc: PdfDoc): void`
  - `pageCount(doc: PdfDoc): number`
  - `extractPagesText(doc: PdfDoc): string[]`, matching PyMuPDF `page.get_text()`.
  - `extractTextMarkdown(doc: PdfDoc): string`, a port of `extract_text_pymupdf` and its helpers
    (`pdf_extractor.py:44-245`).
  - `renderPage(doc: PdfDoc, index: number, dpi: number): { png: Uint8Array; width: number; height: number }`.
    It uses RGB with no alpha and the matrix `scale(dpi / 72)`.
  - `cropPage(doc: PdfDoc, index: number, dpi: number, box: [number, number, number, number]): { png: Uint8Array; width: number; height: number }`.
    It renders only the device-pixel `box`, through a `Pixmap` with that bbox and a `DrawDevice`. The pixels
    must equal that sub-rectangle of `renderPage`.
- How to get spans: `extractTextMarkdown` builds PyMuPDF-style spans from `StructuredText.walk`. A span is a
  run of consecutive characters in a line with the same font name, size and color. A span is bold when
  `font.isBold()` returns true or when the font name matches the Python `_is_bold_span` substrings. Body size
  and heading logic follow the Python exactly, using `pyRound`, `pyIsUpper`, `pySplit` and `PY_WORD`.
- Text options: start from the `toStructuredText` options `preserve-ligatures,preserve-whitespace` for
  both functions, which match PyMuPDF's `TEXTFLAGS_TEXT` and `TEXTFLAGS_DICT`. The goldens decide; adjust the
  options until they match.

- [ ] **Step 1: Build the fixture.**
  - `build-sample-pdf.ts` writes a 3-page PDF by hand: raw objects, base-14 fonts Times-Roman, Times-Bold,
    Helvetica and Helvetica-Bold, and no images.
  - The pages contain:
    - a 20 pt bold title
    - a bold `Abstract`
    - 10 pt body paragraphs, at least 600 words in total, with sentence punctuation
    - `1. Introduction` in bold at body size
    - `2.1 Methods and Materials` at 12 pt
    - an ALL CAPS 3-word line
    - a parenthetical bold line `(see below)`
    - a `## 3 Results`-style numbered heading at 11 pt
    - a vector bar chart (filled rectangles) with the caption `Figure 1: Mean scores by group.`
    - a `References` section
    - one line with non-ASCII text: `Café naïve — 東京 ñ`
  - Run it with `npx tsx test/fixtures/build-sample-pdf.ts` and commit the output `sample.pdf`.
- [ ] **Step 2: Generate the goldens from Python.**
  - `pdf_text.py` takes a PDF path and an output directory. It writes:
    - `extract_text_pymupdf(path)` to `.pymupdf.md`
    - `extract_pages_text(path)` to `.pages.json`
    - for each page at 150 dpi, `{width, height}` plus the RGB value at 5 fixed pixel positions, to `.raster.json`
  - Run it from the repo root. `README.md` records this exact command:

    ```bash
    docker run --rm --user 10001 --network none \
      -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
      -v "$PWD/server/test/fixtures:/fx" -w /src/worker \
      -e PYTHONPATH=/src/worker:/src/shared \
      ficino-worker python -I /fx/goldens/gen/pdf_text.py /fx/sample.pdf /fx/goldens
    ```

  - The goldens are committed. The Python scripts are deleted at cutover along with `worker/` (add this to the
    carryover).
- [ ] **Step 3: Write the failing tests.**
  - `extractTextMarkdown(sample)` equals `sample.pymupdf.md` byte for byte.
  - `extractPagesText` equals `sample.pages.json`.
  - `renderPage` at 150 dpi gives the golden width, height and probe pixels. Allow each channel to differ by ±2.
    Document the reason in the test: anti-aliasing can differ by WASM build.
  - `cropPage(doc, 0, 150, [10, 20, 110, 70])` is 100×50, and its pixels equal that region of `renderPage`.
  - `openPdf` throws `PdfOpenError` on `%PDF-` followed by junk, on an empty buffer, and on an encrypted PDF.
    Build the encrypted PDF in the test with mupdf's `PDFDocument.saveToBuffer` encryption options.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement until the goldens pass.**
  - If byte equality on the markdown proves impossible for a reason you can name (a known mupdf.js vs PyMuPDF
    difference), stop and report `DONE_WITH_CONCERNS` with the diff. Do not loosen the test yourself.
- [ ] **Step 6: Compare against real papers by hand.**
  - `scripts/compare-extraction.ts <dir> <out>` runs `extractTextMarkdown` on each PDF and writes `<name>.ts.md`.
    Run `pdf_text.py` the same way to get `<name>.py.md`.
  - Run both on the PDFs in `<docker-volumes>/ficino_paper_uploads/_data`, writing to
    `<scratch>/extract-compare/`.
  - In the task report, give per-file line counts and the number of differing lines.
  - Never commit those files. They are private papers, and this repo is public.
- [ ] **Step 7: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 8: Commit.** `feat(server): mupdf text extraction and rendering, pinned to PyMuPDF goldens`

---

### Task 9: Chunker and extraction quality check

**Files:**
- Create: `server/src/ingest/chunker.ts`, `server/src/ingest/qualityCheck.ts`
- Create: `server/test/fixtures/goldens/gen/chunker.py`, `server/test/fixtures/goldens/gen/quality.py`, `server/test/fixtures/goldens/chunker-inputs.json`, `server/test/fixtures/goldens/chunker.json`, `server/test/fixtures/goldens/quality.json`
- Test: `server/test/ingest/chunker.test.ts`, `server/test/ingest/qualityCheck.test.ts`

**Interfaces:**
- Produces:
  - `type Chunk = { section: string; content: string; chunk_index: number; token_count: number }`
  - `chunkMarkdown(markdown: string, maxTokens = 800): Chunk[]`, a port of `worker/lib/chunker.py`.
    It counts tokens with `js-tiktoken` `cl100k_base`, via a lazy module-level encoder.
  - `countTokens(text: string): number`
  - `checkExtractionQuality(text: string): { ok: boolean; reason: string }`, a port of `worker/lib/quality_check.py`.
    Python returns a `(bool, reason)` tuple; this returns an object with the same two values.
- **My call:** `countTokens` treats special-token strings such as `<|endoftext|>` as plain text
  (`encode(text, [], [])`). Python's default `encode` raised on them, which failed the whole ingestion.
  Python crashed on these inputs, so no compatibility is lost.

- [ ] **Step 1: Write the inputs.** `chunker-inputs.json` holds at least 12 cases, each `{ name, markdown, max_tokens }`:
  - `sample.pymupdf.md` at 800 and at 100 tokens
  - few sections (fewer than 2 headings)
  - `## Methods and Materials`, `## 3 Results` and `# Abstract`
  - a single paragraph over `max_tokens`, so the sentence split runs
  - a single sentence over `max_tokens`
  - CJK text with no spaces
  - emoji
  - text with many `\n\n\n` gaps
  - an empty string
  - headings only
  - mixed `#` and `##`
- [ ] **Step 2: Generate the goldens.**
  - `chunker.py` writes `chunker.json` as `[{ name, chunks }]`.
  - `quality.py` writes `quality.json` as `[{ text, ok, reason }]` for at least 10 texts:
    - clean English
    - mostly symbols
    - `�` garbage
    - control characters
    - short text
    - Cyrillic
    - Greek-heavy math
    - CJK
    - repeated characters
    - the sample markdown
  - Use the Task 8 docker command, adding `-e TIKTOKEN_CACHE_DIR=/cache -v <scratch>/tiktoken-cache:/cache`
    and dropping `--network none` for the first run, so tiktoken can download `cl100k_base`.
- [ ] **Step 3: Write the failing tests.**
  - Each golden case matches deep-equal.
  - `countTokens('<|endoftext|>')` is greater than 0 and doesn't throw.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement.** Python `re` semantics:
  - `re.match` is a prefix match.
  - `\s` and `\w` are Unicode-aware: use `PY_WS` and `PY_WORD` with the `u` flag.
  - Lookbehind splits stay the same.
  - Caps count code points (`pyLen`).
- [ ] **Step 6: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 7: Commit.** `feat(server): chunker and quality check, pinned to Python goldens`

---

### Task 10: Metadata extraction and contextual prefixes

**Files:**
- Create: `server/src/ingest/metadata.ts`, `server/src/ingest/contextualize.ts`
- Test: `server/test/ingest/metadata.test.ts`, `server/test/ingest/contextualize.test.ts`

**Interfaces:**
- Consumes: `generateText`, `ProviderConfig`, `ProviderDeps`, `withRetry`, `fetchJson`, `mapLimit` and `fenceUntrusted`.
- Produces in `metadata.ts`:
  - `type PaperMetadata = { title: string | null; authors: string[] | null; year: number | null; doi: string | null; tags: string[] }`
  - `extractMetadata(p: ProviderConfig, deps: ProviderDeps, markdown: string, signal?: AbortSignal): Promise<PaperMetadata>`.
    Port it from `worker/lib/metadata_extractor.py`:
    - Use the rendered `METADATA_PROMPT` text: the `{{ }}` become `{ }` (W §9.4).
    - Use the same system string and the first 2000 code points.
    - Parse and validate the response the same way, including the fallbacks.
    - Keep at most 3 tags.
- Produces in `contextualize.ts`: `generateContexts(p: ProviderConfig, deps: ProviderDeps, paperText: string, chunks: Chunk[], signal?: AbortSignal): Promise<string[]>`.
  Port it from `worker/lib/contextualizer.py`:
  - `provider` is `none`, `ollama` or `anthropic`.
  - Ollama runs serially, with temperature 0.2 and `num_predict` `maxTokens`.
  - Anthropic runs at most 8 at a time. The system is two blocks, and the paper block carries
    `cache_control: { type: 'ephemeral' }`.
  - The paper is capped at `maxPaperChars`.
  - A per-chunk failure becomes `''`.
  - It returns one string per chunk.

- [ ] **Step 1: Write the failing tests.** All of these use fakes:
  - The metadata prompt sent to the LLM equals a snapshot of the rendered Python prompt. Get the snapshot by
    running `python3 -I -c` with `METADATA_PROMPT.format(...)` in the `ficino-worker` image, and store it in
    `test/fixtures/goldens/metadata-prompt.txt` (add `gen/metadata_prompt.py`).
  - Parsing:
    - fenced JSON works
    - garbage gives all nulls and `tags: []`
    - 5 tags are cut to 3
    - the year string `"2024"` becomes 2024
    - a non-numeric year becomes null (match Python)
  - contextualize:
    - `none` gives `''` per chunk and makes no calls
    - with Ollama, a failure on chunk 2 of 3 gives `['a', '', 'c']`
    - the Anthropic body contains `cache_control` on the second system block
    - at most 8 Anthropic calls run concurrently
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): paper metadata extraction and contextual prefixes`

---

### Task 11: Figure detection, vision extraction, figure orchestration

**Files:**
- Create: `server/src/providers/vision.ts`, `server/src/providers/figureDetect.ts`, `server/src/ingest/figures.ts`
- Modify: `server/src/settings/schema.ts` (the `figure_detect_anthropic_model` default)
- Test: `server/test/providers/vision.test.ts`, `server/test/providers/figureDetect.test.ts`, `server/test/ingest/figures.test.ts`

**Interfaces:**
- Consumes: `renderPage`, `cropPage`, `extractPagesText`, `pageCount`, `ProviderConfig`, `ProviderDeps`, `withRetry` and `mapLimit`.
- Produces in `vision.ts`. Port it from `worker/lib/vision_extractor.py`:
  - `isVisionAvailable(p: ProviderConfig): boolean`
  - `extractWithVision(doc: PdfDoc, p: ProviderConfig, deps: ProviderDeps, maxPages: number, signal?: AbortSignal): Promise<string>`
  - It renders at 200 dpi, runs pages serially, and stops at `maxPages`.
  - Anthropic uses `maxRetries: 0` plus its own 3 attempts with delays 2 s and 6 s, on connection errors, 429
    and 5xx.
  - Ollama uses 3 attempts on transient errors, and an empty response throws.
  - The page join format and the prompts are copied from Python.
- Produces in `figureDetect.ts`. Port it from `worker/lib/figure_detector.py`:
  - `FIGURE_TYPES`
  - `isFigureDetectAvailable(p: ProviderConfig): boolean`. The provider values are `anthropic` (requires a key),
    `ollama` and `none`.
  - `detectFiguresOnPage(p: ProviderConfig, deps: ProviderDeps, png: Uint8Array, pageNumber: number, pageText: string, signal?: AbortSignal): Promise<Detection[]>`.
    Any error returns `[]` and is logged. The only exception is the job signal's abort, which rethrows.
  - `parseDetectorResponse(text: string): Detection[]`, which includes `_sanitize_figure` and `_coerce_type`.
    The area threshold is exactly `0.005`.
  - `type Detection = { bbox: [number, number, number, number]; type: string; caption: string; figure_number: string; data_claim: string; referenced_paragraph: string; confidence: number }`
- Produces in `figures.ts`:
  - `type ExtractedFigure = { page: number; filename: string; image_bytes: Uint8Array; extraction_type: 'vlm_detected'; width: number; height: number; figure_index: number; figure_type: string; caption: string; figure_number: string; data_claim: string; referenced_paragraph: string; bbox: { page: number; x0: number; y0: number; x1: number; y1: number }; detector_confidence: number }`
  - `extractFigures(doc: PdfDoc, p: ProviderConfig, deps: ProviderDeps, signal?: AbortSignal): Promise<ExtractedFigure[]>`.
    Port it from `pdf_extractor.py:248-388`:
    - It returns `[]` when detection isn't available.
    - Pages run at most 4 at a time. Each page is rendered once at 150 dpi, then detected, then cropped right
      away. This is **my call**: Python rendered every page into memory before detecting. Here, only the crops
      stay in memory.
    - The padding is `0.04`, clamped to `[0, 1]`. Crop coordinates are the `Math.trunc` of the padded
      normalized box times the page pixel size.
    - `figure_index` and `fig_p{page}_{index}.png` are assigned in page order, after all pages finish.
    - The `MAX_FIGURES_PER_PAPER = 50` cap applies after assignment.
- **My call (carry-forward):** the `figure_detect_anthropic_model` default changes from `claude-sonnet-4-6` to
  `claude-sonnet-5-5`, matching the spec's model refresh.

- [ ] **Step 1: Write the failing tests.**
  - Port the `test_wave3_task_fixes.py` vision tests: the Ollama retries, the Claude retries, and
    `max_retries=0` on the Claude vision client. Assert the factory receives `maxRetries: 0`.
  - `parseDetectorResponse` cases:
    - strict JSON works
    - fenced JSON works
    - prose gives `[]`
    - a bbox overshoot of 1.02 is clamped
    - an `x1 <= x0` bbox is dropped
    - an area of 0.004 is dropped and 0.006 is kept
    - type aliases (`scatterplot` → `chart_scatter`, `table` → `table_image`) map, and unknown types become `other`
    - caption is capped at 2000, figure number at 40, data claim at 1000 and referenced paragraph at 2000 (in code points)
    - confidence `"x"` becomes 0.5, and 3 becomes 1
  - `extractFigures` on `sample.pdf`, with a fake detector:
    - It returns one bbox `[0.1, 0.5, 0.6, 0.8]` on page 2 and nothing elsewhere.
    - The result is one figure, `fig_p2_0.png`, whose width and height equal `trunc(0.66 * W) - trunc(0.06 * W)`
      by `trunc(0.84 * H) - trunc(0.46 * H)`, where W and H come from the golden raster. Its bytes are a
      valid PNG.
  - The cap: a fake that returns 60 detections in total keeps 50, and their indices are 0..49 in page order.
  - With the provider `none`, the fake detector is never called and the result is `[]`.
  - The `figure_detect_anthropic_model` default is `claude-sonnet-5-5`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** Tick the ported `PORTING.md` lines.
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): figure detection, vision extraction and figure crops`

---

### Task 12: `process_paper` job

**Files:**
- Create: `server/src/tasks/ingestion.ts`, `server/src/ingest/store.ts`, `server/test/helpers/fakeProviders.ts`
- Modify: `server/src/worker/handlers.ts` (register `process_paper`)
- Test: `server/test/tasks/ingestion.test.ts`, `server/test/ingest/store.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–11.
- Produces in `store.ts`:
  - `storeChunks(sql: Sql, paperId: string, userId: string, chunks: Array<Chunk & { contextual_prefix: string }>, embeddings: number[][], embedModel: string): Promise<number>`.
    In one transaction, it deletes the paper's chunks, then inserts them all with one `INSERT … SELECT FROM unnest(…)`.
    The embedding is passed as pgvector text (`[a,b,…]`) and cast with `::vector`. An empty prefix becomes
    NULL. `metadata` is `{"embed_model": embedModel}`. It keeps the Python `ON CONFLICT (paper_id, chunk_index) DO UPDATE`.
  - `storeFigure(sql: Sql, paperId: string, f: ExtractedFigure, imagePath: string): Promise<void>`. Port it from
    `worker/lib/db.py:253-326`, including the legacy `description` and `claim_summary` derivation from W §2.1 step 12.
- Produces in `tasks/ingestion.ts`: `processPaper(data: { paper_id: string }, ctx: JobContext, deps: WorkerDeps): Promise<Record<string, unknown>>`.
  Port it from `worker/tasks/ingestion_tasks.py:63-480`, following W §2.1 steps 1–15. These parts are pinned:
  - **Owner and settings.** It reads the owner with `SELECT user_id FROM papers WHERE id`.
    - **My call:** a missing row returns `{ status: 'skipped', paper_id, reason: 'paper not found' }`. Python
      ran as the stub user and failed on the missing file.
    - Otherwise it calls `loadJobSettings(owner)` once, and passes the same `providers` object to every call.
  - **Progress.** It calls `ctx.progress({ step, paper_id })`, with these steps in this order: `extracting`,
    `quality_checking`, `metadata`, `chunking`, `contextualizing`, `embedding`, `extracting_figures`.
  - **Status.** `papers.status` moves through `extracting`, `chunking`, `embedding`, then `complete`. On
    `complete` it also sets `processed_at = NOW()`, `extraction_path`, `chunk_count` and `figure_count`
    (the stored count).
  - **Extraction mode.**
    - `auto` gives `pymupdf_clean`. If the quality check fails and vision is available, it re-extracts with
      vision and the path is `vision_fallback`.
    - `pymupdf` gives `pymupdf_forced`.
    - `vision` gives `vision_forced` when vision is available, and `pymupdf_clean` when it isn't.
    - The Marker path is gone: `auto` never yields `marker_clean`.
  - **Embedding failure.** An `EmbeddingUnavailableError` sets `status = 'error'` with
    `error_message = 'No embedding provider available: ' + message`. The job then returns
    `{ status: 'error', paper_id, error }` and is not retried.
  - **Any other error,** including an abort of `ctx.signal`, sets `status = 'error'` and
    `error_message = String(message)`, then rethrows so pg-boss retries per `QUEUES`.
  - **Figures.** Per-figure save or store errors are counted and swallowed. The summary logs match Python,
    including `figure_extraction_total_failure` when at least 3 were attempted and none were stored.
  - **Fan-out.** It always sends `check_contradictions` with `{ paper_id }`. If `auto_generate_on_upload` is on
    and the paper has a `corpus_id`, it also sends `generate_feed` with `{ corpus_id, user_id }`. Send
    failures are logged and swallowed.
  - **Result.** It returns `{ status: 'complete', paper_id, extraction_path, chunk_count, figure_count: figures.length }`.
  - **Embed text.** For each chunk, `` `${prefix}\n\n${content}` `` with Python `.strip()` applied, or just
    the content when the prefix is empty.
- Produces in `fakeProviders.ts`: `fakeProviders(opts): { deps: ProviderDeps; calls: Array<{ kind: 'ollama-chat' | 'ollama-embed' | 'anthropic'; apiKey?: string; model?: string; body: unknown }> }`.
  - It routes Ollama `/api/chat` and `/api/embed`.
  - Embeddings are deterministic `dim`-length vectors seeded by the text.
  - Chat replies come from `opts.chat(body)`, and detector replies from `opts.detect(pageNumber)`.
  - An optional `delayMs` interleaves concurrent calls.

- [ ] **Step 1: Write the failing tests.** All of these use the real DB, a temp storage dir, `sample.pdf` and fake providers.
  - Happy path (`auto` mode, Ollama, detector fake with one figure on page 2):
    - The paper is `complete` with `extraction_path` `pymupdf_clean`.
    - `chunk_count` equals the chunk rows; the rows have non-null embeddings and `metadata->>'embed_model'` `ollama:qwen3-embedding:latest@1024`.
    - `search_vector` is filled (by the trigger).
    - The title, authors, year and doi come from the metadata fake.
    - Up to 3 tags are linked.
    - One figure row exists, and its PNG is on disk under `figuresDir/<paper>/fig_p2_0.png`.
    - `figure_count` is 1.
    - `job_progress.meta.step` ends at `extracting_figures`.
    - A `check_contradictions` job was sent with `{ paper_id }`, and no `generate_feed` job.
  - With `auto_generate_on_upload: true` stored and a `corpus_id`, a `generate_feed` job is sent with `{ corpus_id, user_id }`.
  - Port `test_auto_tagging.py`: a tag insert failure is swallowed and the paper still completes.
  - Quality fallback: a fake quality check can't be injected, so build the scanned-page case instead. Use a PDF
    with no text layer, built in the test from a page containing only a filled rectangle, with
    `extraction_mode` `auto` and vision on through Ollama. The path is `vision_fallback`, and the vision fake
    was called once per page.
  - **Review Focus 3:** a fake embed that returns 768-d vectors leaves the paper `error` with
    `No embedding provider available:`, 0 chunk rows, and a result of `{ status: 'error' }` that is not thrown.
  - **Review Focus 4:**
    - Junk after `%PDF-` throws, and the paper is `error` with a message.
    - A deleted paper row returns `skipped`.
    - Through a real worker run (`startWorker` with fake providers), junk PDF bytes end with job `failed`
      after 3 attempts, and the paper is `error`. Pass `queueOverrides: { process_paper: { retryDelay: 0 } }`.
  - **Review Focus 5:** a fake Ollama chat that hangs until aborted, with `softLimitMs = 200`. `processPaper`
    rejects within 2 s. The paper is `error`. After the abort, no further fake calls are recorded.
  - **Review Focus 1:**
    - Set up user A with `{ llm_provider: 'api', anthropic_api_key: 'sk-A', figure_detect_provider: 'anthropic' }`
      and user B the same with `'sk-B'`.
    - Run both `processPaper` calls with `Promise.all`, through a shared fake Anthropic factory with a 20 ms
      delay per call.
    - Every recorded call for A's paper used `sk-A`, every call for B's used `sk-B`, and both completed.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** Register `process_paper` in `HANDLERS` and tick the ported `PORTING.md` lines.
- [ ] **Step 4: Run the suite.** `npm test && npm run typecheck` passes.
- [ ] **Step 5: Commit.** `feat(server): process_paper ingestion job`

---

### Task 13: Image, docs, carry-forward

**Files:**
- Modify: `server/Dockerfile`, `server/README.md`, `server/.dockerignore`, `docs/superpowers/plans/2026-10-29-ts-port-01-carryover.md`
- Create: `docs/superpowers/plans/2026-11-02-ts-port-02-carryover.md`
- Test: a docker smoke test (run by hand and recorded in the report)

- [ ] **Step 1: Image.** The image still builds with `CMD ["node","dist/worker/main.js"]` available as an
  override. Keep the API as the default CMD. Make sure the mupdf `.wasm` file ends up in the image.
  - Smoke test: `docker build -t ficino-server:plan02 server` must succeed.
  - Then start throwaway containers on a private network with no published ports: pg18, the API and the worker.
  - Check `wget -qO- http://127.0.0.1:8000/health` inside the API container.
  - Upload `sample.pdf` with `wget --post-file` or a tiny `node -e` script inside the API container, with
    `ENVIRONMENT=development` and `AUTH_PROVIDER=none`.
  - Configure `FIGURE_DETECT_PROVIDER=none` and an embed provider. Ollama isn't reachable from the private
    network, so the paper is expected to end `error` with the embedding message. That is the pass condition:
    it proves the worker picked up the job end to end.
  - Remove all the containers afterwards.
- [ ] **Step 2: README.** Document:
  - the worker command
  - the new env vars from Task 1's Config table
  - the goldens and how to regenerate them
  - that `/media` is new
- [ ] **Step 3: Carryover.** Write `2026-11-02-ts-port-02-carryover.md` with:
  - every ruling made during execution
  - for plan 03:
    - `/feed/status` maps `JobState` using C §5.2
    - the summary stuck check uses `failed`, `cancelled` or `missing`
    - the uuid5 feed id uses the job id
  - for plan 06:
    - delete `test/fixtures/goldens/gen/*.py` along with `worker/`
    - the compose worker service uses `node dist/worker/main.js`
  - In the plan-01 carryover, mark the items closed here as done.
- [ ] **Step 4: Final check.** `npm test && npm run typecheck && npm run build` passes.
- [ ] **Step 5: Commit.** `docs(server): worker image, README and plan-02 carryover`
