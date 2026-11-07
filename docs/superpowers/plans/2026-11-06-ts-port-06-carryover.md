# TS Port 06: cutover record and carry-forward

Plan: `2026-11-06-ts-port-06-cutover.md`. After plan 06 the TypeScript server is the only backend; the Python services
are recoverable at the git tag `python-final`. Host steps (registration, proxy, auth key, the real restore) were the
controller's and live in its private runbook, so no host name, tailnet name, path or archive id appears here.

## 1. What plan 06 delivered

**Deploy files (Tasks 1-2).** The server image's `HEALTHCHECK` gained interval, timeout, start-period and retry flags.
`docker-compose.yml` is the generic stack (project `ficino`: `postgres` on `pgvector/pgvector:pg18`, `api` and `worker`
from one `ficino-server:local` image with shared `uploads`/`figures`/`media` volumes, `web` as `ficino-web:local`) and
publishes nothing. `.env.example` documents every server setting in one file (`.env.secrets.example` is gone), and
`frontend/.dockerignore` keeps host build output out of the web context. A host-only, gitignored
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

## 3. Rulings made during execution

- **Task 1.** The deploy-test helpers strip `COMPOSE_*` variables from the inherited env and resolve paths against the
  repo, so the checks render the same from any shell or directory. The postgres healthcheck allows 10 retries (a
  first-boot initdb can be slow). `.env.example` leaves `POSTGRES_PASSWORD` and `SIGNED_URL_KEY` empty so an
  unedited copy fails closed.
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
| 02 | Synchronous extraction has no hard limit (`worker_thread`) | Kept: the feed rework replaces the extractor behind the same interface |
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
| all | Deferred minors in carryovers 01-05 | Kept as listed there; none blocks. Named: the broken eslint config, `startApi`'s `undefined` spread, the SaaS `CORS_ORIGINS` code default (compose sets it), the frontend's Node 20 build image |

## 5. Acceptance gate results

Filled by the controller. Each run is on a fresh `scripts/e2e-stack.sh up`; the full suite is desktop + mobile with
real local models (`up --ollama`, then `full`). Expected totals: `ci` 124, full 256; failed 0; every skipped test
traceable to a `tests/e2e/SKIPS.md` entry (unlisted skips 0). A total that differs or an unlisted skip fails the gate,
the same as a failed test. The first CI run on the pushed `main` is recorded outside the repo.

| Run | Total | Passed | Skipped | Failed | Flaky | Unlisted skips | Duration |
|---|---|---|---|---|---|---|---|
| `ci`, before the restore | pending | | | | | | |
| full 1, before the restore | pending | | | | | | |
| full 2, before the restore | pending | | | | | | |
| full 3, before the restore | pending | | | | | | |
| `ci`, after the cutover | pending | | | | | | |
| full 1, after the cutover | pending | | | | | | |
| full 2, after the cutover | pending | | | | | | |
| full 3, after the cutover | pending | | | | | | |

## 6. ElevenLabs smoke

Filled by the controller (`server/scripts/elevenlabs-audio-smoke.ts` with the owner's key; never the key itself).

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
- **`worker_thread` extraction.** Synchronous MuPDF extraction has no hard time limit; the feed rework's extractor
  should run off the main thread.
- **The soft-limit slice.** A soft-limit abort still discards the partial feed slice.
- **Plan 05's frontend-redo list** (`2026-11-06-ts-port-05-carryover.md`, "Carry into the frontend redo") carries over
  unchanged.
