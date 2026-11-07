# TS Port 06: cutover record and carry-forward

Plan: `2026-11-06-ts-port-06-cutover.md`. After plan 06 the TypeScript server is the only backend; the Python services
are recoverable at the git tag `python-final`. Host steps (registration, proxy, auth key, the real restore) were the
controller's and live in its private runbook, so no host name, tailnet name, path or archive id appears here.

## 1. What plan 06 delivered

**Deploy files (Tasks 1-2).** The server image's `HEALTHCHECK` gained interval, timeout, start-period and retry flags.
`docker-compose.yml` is the generic stack (project `ficino`: `postgres` on `pgvector/pgvector:pg18`, `api` and `worker`
from one `ficino-server:local` image with shared `uploads`/`figures`/`media` volumes, `web` as `ficino-web:local`) and
publishes nothing. `.env.example` documents every server setting in one file (the usual ones first, the rest
commented out at their defaults; `.env.secrets.example` is gone) and is read by the api and worker only;
`postgres.env.example` holds `POSTGRES_PASSWORD`, the one setting Postgres reads. `frontend/.dockerignore` keeps host
build output out of the web context. A host-only, gitignored
`docker-compose.override.yml` makes the stack reachable, built from one of two tracked examples: `deploy/loopback/`
(web on `127.0.0.1:8080`) or `deploy/tailnet/` (a Tailscale sidecar in kernel mode, Serve config in `serve.json`, and
`web` in the sidecar's network namespace with the owner-gated nginx template in `deploy/web/tailnet/`).
`deploy/README.md` explains the layering. `npm run test:deploy` renders every layer and runs the nginx template in
throwaway containers.

**e2e and CI (Tasks 3-4).** `docker-compose.e2e.yml` (project `ficino-e2e`, images `ficino-server:e2e` and
`ficino-web:e2e`, web on `127.0.0.1:${FICINO_E2E_PORT:-3070}`) carries its dummy env inline. `scripts/e2e-stack.sh`
drives it (`up [--ollama] | ci | full | down | logs`) and writes a JSON report per run. The Playwright harness
defaults now point at the e2e containers and port, so a bare run can never seed fixtures into a real deployment; the
full suite can seed one real sample paper. CI runs the `ci` project on that stack on ubuntu-24.04 and runs the
deploy checks in their own job.

**Re-embed (Task 5).** `chunkEmbedText` is shared by ingestion and the re-embed. `reembedUserChunks` re-embeds a
user's chunks in batches with the model their settings resolve to (`loadJobSettings`, nothing mutates `process.env`),
writing each chunk's vector and `metadata.embed_model` in one `UPDATE`. The CLI is `node dist/db/reembed-cli.js`
(`npm run reembed` in a checkout).

**Restore (Tasks 6-10).** A pg_dump COPY-block parser and a synthetic archive builder (the only fixtures the restore
tests use); post-load cleanup (`cleanupRestoredData`); a data-only, single-transaction database restore re-keyed to the
stub user with catalog-driven foreign-key and leftover-id checks; a checksum-verified copy of the archive's storage
objects into the TS layout; and the `node dist/restore/cli.js db | files | verify` CLI. The runbook, in generic form, is
in `server/README.md`.

**Plan-01 process fixes (Task 11).** `parseBool` throws on an unrecognised value, CSRF rejections are logged, and the
first registration is serialized.

**Signals and the porting ledger (Task 12).** SIGTERM/SIGINT shutdown of the api and the worker is pinned by tests that
spawn the real entries; `server/test/PORTING.md` has no open line.

**Python removal (Task 13).** `api/`, `worker/`, `shared/`, `infra/`, the golden generators, the Python CI jobs and
their configs were deleted; the local annotated tag `python-final` points at the last commit that had them.
`server/test/fixtures/goldens/README.md` records the goldens' provenance.

**Docs (Task 14).** `README.md`, `AGENTS.md`, `FEATURES.md`, `server/README.md` and `tests/e2e/SKIPS.md` describe the
TS-only, self-host stack; pre-existing host-specific values in older docs were replaced with placeholders; this file.

## 2. Deliberate changes

1. **`parseBool` throws.** An unrecognised boolean env value (for example `ALLOW_REGISTRATION=ture`) stops the process
   at boot instead of silently meaning the default. Unset or blank still means the default.
2. **CSRF rejections are logged** as `csrf_rejected` with the method, the path and which half (cookie, header) was
   present; never the token values.
3. **First registration is serialized.** The user count, the email check, the hash and the inserts run in one
   transaction under a Postgres advisory lock, so two simultaneous first sign-ups cannot both become the first user.
4. **Image healthcheck flags.** `HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5` on
   `/health`; compose's api healthcheck repeats them, and the worker disables the inherited one.
5. **Deploy nginx (tailnet).** 403 unless `Tailscale-User-Login` equals `FICINO_OWNER_LOGIN` (an empty or unset login
   never matches); listens on `127.0.0.1:80` only; the client address comes from Serve's `X-Forwarded-For`
   (`set_real_ip_from 127.0.0.1`), so the api's per-IP limits see the tailnet peer; 300 s proxy timeouts for long LLM
   calls; `/` redirects to `/ficino/`.
6. **Restore cleanup rules** (Task 7, in this order): paper and figure paths rewritten to `/app/uploads/<paper>.pdf` and
   `/app/figures/<paper>/<file>`; double-encoded jsonb arrays decoded; `figure_url` dropped from every post and the
   leading user id stripped from `audio_key`; a legacy stitched podcast (segments with `audio_key`s) cleared;
   `user_posts` `pending` set to `error`; `corpus_syntheses` `pending`/`generating` healed to `complete` when they
   hold messages, else set to `error`; `paper_summaries` `generating` only counted; chunks without `embed_model` tagged
   with the source model; `feed_posts` rebuilt from the cleaned posts; any remaining jsonb shape violation aborts.
7. **Postgres reads only `postgres.env`** (final review). The plan gave `postgres` the project `.env`, which carries
   `SIGNED_URL_KEY`, the provider and ElevenLabs keys and the database URL; the base now gives it only
   `postgres.env` (`POSTGRES_PASSWORD`, from `postgres.env.example`), and `.env` reaches the api and worker only.
8. **`restore files` never overwrites a file in place** (final review). A target with the planned bytes is kept as
   `already in place`; one with other bytes (or that is not a regular file) is kept as `target differs` and named on
   stderr, so a re-run after the api regenerated media leaves the new render alone. `--force` replaces differing
   targets. The copy is now checked against the manifest size (and md5) rather than the source's size at copy time.
9. **The dump parser is stricter** (final review). A `COPY … FROM stdin` header with trailing whitespace is read; any
   other `COPY … FROM stdin` line it cannot read throws, and so does a `\.` outside a block (a header it missed).
10. **`scripts/e2e-stack.sh ci|full` check the port** (final review): they refuse to run unless the running
    `ficino-e2e-web` publishes `127.0.0.1:$FICINO_E2E_PORT`, so the suite can never be aimed at another stack.
11. **The persona system preamble no longer prescribes a `{"posts": [...]}` reply** (found in production right after
    the cutover). The Python preamble said `Your output is JSON: {"posts": [{"text": ..., "type": ...}]}`, which
    contradicts every user prompt's single-object format. Anthropic followed the user prompt; the default local model
    followed the preamble about half the time, and those posts were dropped (`persona_post_missing_content`). The
    sentence now reads `Your output is a single JSON object in exactly the format the request specifies.`, the one
    deliberate divergence from the Python constant (recorded in `server/test/helpers/preamble.ts`; this resolves the
    worker inventory's W §9.8 note). A reply that still arrives wrapped (`{"posts": [post, ...]}` or `{"post": post}`,
    first element a plain object) is unwrapped with a `persona_post_unwrapped` warning, and inside an unwrapped post
    a non-empty `text` stands in for a missing or falsy `content`.
12. **A thread that follows its prompt is kept.** The thread prompt asks for `thread_posts` and no `content`, but
    validation required `content` (Python too), so such threads were dropped. A thread with a usable `thread_posts`
    list and no `content` now gets the joined thread as its `content` (the feed search text; the UI renders
    `thread_posts`).
13. **`num_posts` is bounded** (security review). Python accepted any integer for `POST /feed/generate`'s `num_posts`,
    and a `persona_key` request skipped the 1..50 `posts_per_generation` cap, so a huge value (or a long digit string,
    which became `Infinity`) drove the synchronous post planner until the worker ran out of memory. The route now
    answers 422 outside 0..50 (`0` still means the default), and the worker clamps every `generate_feed` job: a
    missing, non-finite or below-1 count is the default 12, anything else is truncated and capped at 50. One constant,
    `MAX_POSTS_PER_GENERATION` in `server/src/shared/constants.ts`, is both bounds and the setting's max. The shipped
    UI always sends 3, so nothing visible changes.
14. **Request bodies are capped** (security review). Python set no body size limit on its JSON routes, and neither
    did the port: every `body(schema)` route buffers the whole body before validating it, so a large body cost memory
    in proportion to its size (only the reverse proxy's upload-sized limit stood in front). Every request body is now
    capped at `MAX_JSON_BODY_KB` (default 1024 KiB) with hono's `bodyLimit`: a declared `Content-Length` over the cap
    is rejected before the body is read, and a chunked body is cut off once it passes the cap. Either way the answer
    is 413 `{"detail":"Request body too large"}`. `POST /papers` is exempt and keeps its own `MAX_UPLOAD_SIZE_MB` cap.
    No shipped client sends a JSON body anywhere near the cap.
15. **Model output sets only the post's text fields** (security review). Python started every finished post from the
    model's whole JSON object and only overwrote some keys, so a reply steered by a hostile paper could store its own
    `figure_url`, `figure_id`, `figure_caption`, `audio_url`, `audio_key`, `deleted`, `regenerated`, `_task_id` or
    engagement counts, and claim `post_type: "figure"` with no figure; the browser then loaded the model's URLs.
    `startPost` in `server/src/feed/slots.ts`, the first step of `finishPost`, `finishRegeneratedPost` and
    `finishChapterPost`, now builds a new post from the fields the prompts ask for (`post_type`, `content`,
    `paper_ref`, `thread_count`, `thread_posts`, `quoting_handle`, `quoting_content`, `replying_to`); persona, id,
    time, sources, category, figure fields and engagement counts come from the worker only. The model's `post_type`
    still wins, except `figure` without a figure the worker picked, which falls back to the slot type (`post` for a
    figure slot). Model-supplied engagement counts are no longer kept, so two chapter goldens' `likes`/`retweets`
    now read the server default. Posts already stored are unchanged.
16. **Contextualization is capped per paper** (security review). Python made one contextualizer call per chunk with
    no ceiling, and `chunk_max_tokens` (user-settable, down to 100) sets how many chunks a paper has, so one
    text-dense upload could drive thousands of Anthropic calls on the operator's key, or hours of a shared Ollama,
    until the soft time limit. `CONTEXT_MAX_CHUNKS` (default 200, at least 1) now caps it: a paper with more chunks
    than that is stored with no contextual prefixes and no contextualizer call is made; the worker logs
    `contextualizer_chunk_cap_hit` with the chunk count, the cap and the provider. The whole paper is skipped rather
    than its first 200 chunks contextualized, so a paper's chunks are either all prefixed or none are (a half-prefixed
    paper would rank its front chunks differently from the rest), and an oversized upload, whose text the prompt
    truncates at `CONTEXT_MAX_PAPER_CHARS` anyway, costs no calls at all. Papers at or under the cap, and every paper
    when `CONTEXT_PROVIDER` is `none`, behave as before.
17. **An ingestion soft-limit timeout is not retried** (security review). Python's `process_paper` sent every
    exception, the soft time limit's included, to `self.retry` (two retries), except that the contextualizer step
    caught it and carried on without prefixes; the port retried every soft-limit abort, so one over-long upload ran
    the whole pipeline, provider calls and all, up to three times. When the job's soft limit (not a pg-boss abort)
    stops `process_paper`, the paper is still marked `error` with the abort's message, and the job now returns
    `{status: "error"}` instead of rethrowing, as the embedding-unavailable path already did, so pg-boss completes it
    without a retry; the worker logs `ingestion_soft_limit_not_retried`. Every other failure, a pg-boss abort included,
    still rethrows and is retried. `JobContext.softLimitHit()` tells the two aborts apart.
18. **PDF work is bounded** (security review). Python's PyMuPDF extraction, rendering and figure detection had no
    page or size limit; Celery's hard time limit killed a runaway child, which the single-threaded TS worker cannot
    do, so a crafted or oversized PDF could hold its event loop for the whole job. Four bounds now apply, and output
    under them is byte-identical (the PyMuPDF goldens are unchanged):
    - `MAX_PDF_PAGES` (default 500, at least 1): `openPdf` rejects a document with more pages with a `PdfOpenError`
      (`PDF has N pages; the limit is M`), so the paper is marked `error` before any text is read; like other
      open errors the job is retried.
    - Raster cap: a page whose render would pass 25 million pixels or 10,000 px on a side (at 150 dpi, a page over
      about 33 in square) is drawn at a lower uniform scale that fits, decided before the pixmap is allocated, and
      the worker logs `pdf_render_scaled_down`. Figure crops and vision
      extraction use the scaled raster as is. Python allocated such a pixmap at full size or failed the paper.
    - Page checkpoints: the markdown pass, the per-page text pass and figure detection call
      `JobContext.checkpoint()` before each page. It throws the job's abort reason, or a `TimeoutError` once the
      soft limit's time has passed by the clock (its timer cannot fire during synchronous work), and
      `softLimitHit()` counts that case, so such a timeout is final like item 17. One huge page can still run
      past the limit; only isolation (section 7) bounds that.
    - `FIGURE_DETECT_MAX_PAGES` (default 60, at least 1): figure detection reads and sends to the detector only
      the first that-many pages and logs `figure_detect_page_cap_hit` with the page count and the cap; Python
      scanned every page. Figures past the cap are not extracted.

## 3. Rulings made during execution

- **Task 1.** The deploy-test helpers strip `COMPOSE_*` variables from the inherited env and resolve paths against the
  repo, so the checks render the same from any shell or directory. The postgres healthcheck allows 10 retries (a
  first-boot initdb can be slow). `.env.example` leaves `SIGNED_URL_KEY` (and `postgres.env.example`
  `POSTGRES_PASSWORD`) empty so an unedited copy fails closed.
- **Task 2.** The nginx template gained one fail-closed line beyond the plan's text: with the owner login unset, a
  request whose header was the literal placeholder got through, so the template now refers to the login in a way that
  makes nginx refuse to start when it is unrendered. The web service's networks are cleared with `!reset {}`.
- **Task 3.** The e2e env lives inline in `docker-compose.e2e.yml` (no env file); the old `.env.ci` was deleted in
  Task 13 once nothing read it. Extra arguments after `ci`/`full` pass through to Playwright.
- **Task 4.** No Compose install step: the runner image's Compose already has `config --no-env-resolution`. e2e
  artifacts are uploaded on failure only.
- **Task 5.** Chunks whose metadata is not a jsonb object are skipped and counted as remaining (so the run exits 1)
  rather than looping; the CLI stops cleanly on the first SIGINT/SIGTERM.
- **Task 6.** An unparseable `COPY ... FROM stdin;` header throws instead of dropping rows.
- **Task 7.** `jsonbDecoded` reports non-zero columns only; JSON-null chunk metadata is tagged; the `feed_posts` rebuild
  skips non-object posts and feeds without a user, with a warning, as the Python backfill did.
- **Task 8.** The restored tables come from the catalog; preconditions are checked again inside the transaction; a
  stub session blocks replacing the stub user; the orphan check covers every `user_id`/`corpus_id` table; dump blocks
  for tables that are not restored, or for generated columns, abort.
- **Task 9.** Keys with dot-leading or empty segments are unsafe; a duplicate target or an unknown checksum aborts;
  each target is verified as a temp file before the rename; the chown walk skips symlinks.
- **Task 10.** The manifest may be a list or a single-key wrapper, with the checksum under `etag`/`eTag` at the top
  level or under `metadata`; `files` copies, then exits 1 if a restored row is still missing its file; `embed model`
  passes only when every group equals the target; quoted values in database errors are elided on stderr.
- **Task 11.** The bcrypt hash runs inside the registration lock (refusals cost no hash, as in Python); a blank boolean
  means the default.
- **Task 12.** The double-signal test holds a request open so the second signal lands mid-shutdown (an idle api exits
  in under 50 ms); the spawned entries get a minimal env and temporary data directories.
- **Task 13.** `.env.ci` deleted (Python-era, unused); the tag sits on the commit before the deletion.
- **Task 14.** Archive ids in the reference docs became `<feed-a>`..`<feed-f>` and `<orphan-pdf>` (the plan named
  placeholders for two feeds; the doc had six); the docs site link stays in `README.md` while the hosted-service links
  are gone; frontend lint is listed as CI runs it, though the eslint config is a known deferred minor.
- **Final review.** Deliberate changes 7-10 above. The tailnet override keeps its own `postgres.env` entry (the host
  points it outside the repo; the base's `./postgres.env` then stays absent). The commented defaults in `.env.example`
  keep their notes on separate lines, because compose reads `KEY=  # note` as the value `# note`; a deploy check now
  fails if the server reads a variable the file does not list. New tests pin what mutations showed unpinned: each
  re-embed batch is one `UPDATE` and a failed write never splits tag from vector; every source id kind (and upper
  case) trips the remaining-id check; the owner's `audit_log.resource_id` is re-keyed; the in-transaction
  precondition re-check; an orphan corpus holding data; the CSRF log's exact fields and empty-value presence.

## 4. Carry-item dispositions

| From | Item | Disposition |
|---|---|---|
| 01 | Compose env (`ENVIRONMENT`, `CORS_ORIGINS`, `SIGNED_URL_KEY`), healthcheck port and start period | Fixed: Task 1 (image + compose); host env in the private runbook |
| 01 | Auth provider vs the restore | Kept `none`; data re-keyed to the stub user (Task 8); owner-login gate in the web nginx (Task 2). `basic` would need a set-password CLI: carried to whenever a second user is added |
| 01 | IP rate limits behind Serve | Fixed in the deploy nginx (realip from `X-Forwarded-For`, Task 2); `clientIp` unchanged |
| 01 | Restore data-only or stamp `schema_migrations` | Data-only into a schema the runner migrated (Task 8) |
| 01 | Close/SIGTERM tests | Fixed: Task 12 |
| 01 | First-user registration race | Fixed: Task 11 |
| 01 | CSRF failure logging | Fixed: Task 11 |
| 01 | `parseBool` silent fallback | Fixed: Task 11 (deliberate change) |
| 02 | Delete the golden generators with `worker/` | Done: Task 13 (tag `python-final`) |
| 02 | Worker command, shared volumes, same key, no inherited healthcheck, `stop_grace_period` ≥ 40 s | Fixed: Task 1 (45 s) |
| 02 | Synchronous extraction has no hard limit (`worker_thread`) | Partly fixed: page, raster and figure-page caps plus per-page time checks (section 2, item 18); isolation kept: the feed rework replaces the extractor behind the same interface |
| 02/05 | Reprocess endpoint (empty re-run keeps stale chunks) | Kept out of scope; the re-embed does not re-extract |
| 03 | Re-embed on an embed-setting change | Kept as CLI only (Task 5): after switching the embedding model, run `reembed`; no settings hook, no new route |
| 03 | Restore re-embed writes `embed_model` | Fixed: Task 5, run by the restore runbook |
| 03 | `embed_model` backfill for Python-written chunks | Fixed: provenance tag (Task 7), then the re-embed |
| 03 | Soft-limit abort discards the partial feed slice | Kept: far from the limit with the default model |
| 04 | Restored `paper_summaries` stuck in `generating` | Kept: counted by the restore; first view re-dispatches (an `error` row would too) |
| 04/05 | Restored `user_posts` stuck in `pending` | Swept to `error` (Task 7); plan 05's status heal also covers it |
| 04 | Double-encoded legacy `messages` / jsonb shape sweep | Fixed: decoded or aborted (Task 7); `verify` re-checks (Task 10) |
| 04 | Final-attempt crash leaves summaries, syntheses, Archivist rows stuck | Closed by plan 05 (group-chat stuck check, Archivist status heal) |
| 05 | Legacy stitched podcast | Fixed: Task 7 clears it; files not copied (Task 9) |
| 05 | Legacy media keys `{user}/feeds/{feed}/…` | Fixed: keys re-keyed (Task 7), files copied to `MEDIA_DIR/feeds/…` (Task 9) |
| 05 | `MEDIA_DIR`, `SIGNED_URL_KEY`, `PUBLIC_API_BASE`, `ELEVENLABS_*` on api and worker | Fixed: Task 1 shared env file and volumes; values in host env |
| 05 | Media needs a same-origin API | Kept `/ficino/` base, same origin on the node (Task 2) |
| 05 | Restored `corpus_syntheses` stuck in `generating` | Fixed: healed or set `error` (Task 7) |
| 05 | ElevenLabs voices risk and the unrun smoke | Run by the controller with the owner's new key; results below |
| spec | PG19 re-check | pgvector has no pg19 image: stays on `pgvector/pgvector:pg18`; a later major is a dump/restore |
| spec | Frontend dead Supabase/Turnstile/Railway code | Skipped: recorded for the frontend redo |
| all | Deferred minors in carryovers 01-05 | Kept as listed there; none blocks. Named: the broken eslint config, `startApi`'s `undefined` spread, the SaaS `CORS_ORIGINS` code default (`.env.example` sets it; the e2e compose sets it inline), the frontend's Node 20 build image |

## 5. Acceptance gate results

Filled by the controller. Each run is on a fresh `scripts/e2e-stack.sh up`; the full suite is desktop + mobile with
real local models (`up --ollama`, then `full`). Expected totals: `ci` 124, full 256; failed 0; every skipped test
traceable to a `tests/e2e/SKIPS.md` entry (unlisted skips 0). A total that differs or an unlisted skip fails the gate,
the same as a failed test. The first CI run on the pushed `main` is recorded outside the repo.

| Run | Total | Passed | Skipped | Failed | Flaky | Unlisted skips | Duration |
|---|---|---|---|---|---|---|---|
| `ci`, before the restore | 124 | 120 | 4 | 0 | 0 | 0 | 4.2 min |
| full 1, before the restore | 256 | 225 | 31 | 0 | 0 | 0 | 12.6 min |
| full 2, before the restore | 256 | 225 | 31 | 0 | 0 | 0 | 13.1 min |
| full 3, before the restore | 256 | 225 | 31 | 0 | 0 | 0 | 12.5 min |
| `ci`, after the cutover | 124 | 120 | 4 | 0 | 0 | 0 | 4.2 min |
| full 1, after the cutover | 256 | 225 | 31 | 0 | 0 | 0 | 13.0 min |
| full 2, after the cutover | 256 | 225 | 31 | 0 | 0 | 0 | 12.8 min |
| full 3, after the cutover | 256 | 224 | 31 | 1 | 0 | 0 | 13.6 min |

Before the three counted full runs, a first full run failed 4 tests (W4-01 on desktop, R2 Section 5.1-5.3 on mobile).
Both were test assumptions, not product bugs: the group-chat modal labels a paper by its metadata title when the
local model extracts one (the spec picked papers by filename), and the mobile feed virtualizes posts, so the figure
post was not mounted below the fold. The sample-paper seed also raced figure detection on the local vision model
(up to the worker's 300 s per page). One test-only commit fixed all three; the skip set was identical in every run.

The after-cutover runs include the two feed fixes (deliberate changes 11 and 12), merged after the restore. The one
failure in after-cutover full 3 (AUG-12 on mobile, a test timeout with a blank page) was the browser, not the app:
`index.html` loads the Google Fonts stylesheet render-blocking before the module script, the request to Google hung,
so the app's script never ran; the trace shows the font request pending and the lazy chunks never requested, and the
web's nginx never received them. The runbook needs one green after-cutover full run; runs 1 and 2 are.

## 6. ElevenLabs smoke

Filled by the controller (`server/scripts/elevenlabs-audio-smoke.ts` with the owner's key; never the key itself).

Not run at the cutover: the owner adds the new ElevenLabs key later. Until then podcast and feed audio fail
cleanly; after the key is added, the api and worker are recreated and this smoke fills the table.

| Item | Result |
| --- | --- |
| Ordering (rationales or fallback) | pending |
| Chapter 0 (`posts_per_generation` 2) | pending |
| Podcast: status, segments, code points, bytes, `text-to-dialogue` calls (must be 1), range read | pending |
| Feed audio (`SMOKE_FEED_AUDIO=1` only): rendered, skipped, bytes, range reads | pending, or not run |
| `host_a` `q0IMILNRPxOgtBTS4taI` (Drew) | pending |
| `host_b` `rPMkKgdwgIwqv4fXgR6N` (Tyler) | pending |
| Persona voices and `DEFAULT_VOICE` | pending (only if feed audio ran) |

## 7. Carry into the feed rework and the frontend redo

- **Root base path.** Serve the app at `/` instead of `/ficino/`; persona avatar URLs stored with the prefix need a
  migration, and `PUBLIC_API_BASE`, the web nginx and the Vite `base` move together.
- **Frontend dead code and CSP.** Remove the Supabase, Turnstile and Railway code paths and dependencies, then tighten
  the CSP (it still allows `*.supabase.co`).
- **Node 24 frontend build.** The frontend image still builds on Node 20.
- **Floating `qwen3-embedding:latest` tag.** A pull that changes the weights keeps the same `embed_model` id, so the
  re-embed sees nothing to do while new and old vectors mix. Pin a digest-backed tag, or include the digest in the id,
  and re-embed after the change.
- **Re-embed trigger in Settings.** The re-embed is a CLI only; a Settings action (or a prompt after an embedding-model
  change) belongs to the frontend redo.
- **`worker_thread` extraction.** The bounds landed (section 2, item 18: page cap, raster cap, figure-page cap and a
  time check between pages), but synchronous MuPDF work still runs on the worker's one thread with no hard time
  limit, so a single pathological page can hold the event loop past the soft limit. The feed rework's extractor
  should run in a worker thread (or child process) that is terminated on the job's deadline or abort.
- **The soft-limit slice.** A soft-limit abort still discards the partial feed slice.
- **The rest of the preamble still contradicts the per-type prompts.** It says threads use `[1/n]` numbering (the
  thread prompt says not to number) and quotes carry `"quoting": "@handle"` (the quote prompt asks for
  `quoting_handle`). Neither drops posts today; the feed rework should give the preamble and the per-type formats one
  source.
- **Figure detection on the local vision model is slow.** It ignores `think: false`, and the requests have no output
  cap, so a chart-heavy page can take minutes and hit the 300 s per-page timeout (the sample paper takes 3-5 GPU
  minutes). Capping `num_predict` is a product call for the feed rework.
- **Joined thread content is cut at 2000 characters.** A long thread's search text (`feed_posts`) loses its tail and
  logs `post_shape_content_truncated`; the thread itself renders and is spoken in full.
- **Google Fonts blocks the first paint.** `frontend/index.html` loads the Cormorant Garamond stylesheet from
  Google render-blocking, before the app's module script; when that request hangs the app stays blank. Self-host the
  font or load the stylesheet non-blocking in the frontend redo.
- **Plan 05's frontend-redo list** (`2026-11-06-ts-port-05-carryover.md`, "Carry into the frontend redo") carries over
  unchanged.
