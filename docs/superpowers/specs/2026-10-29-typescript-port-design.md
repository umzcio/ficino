# Ficino TypeScript Port — Design

Date: 2026-10-29. Status: approved by the owner in chat ("lock it in, write the plan").

## Intent

Ficino's backend (FastAPI `api/`, Celery `worker/`, `shared/`, about 16k lines of Python plus 6k of tests)
gets rewritten in TypeScript. The SaaS deployment (Railway + Supabase) was shut down on 2026-10-23 because it
cost too much for how little it was used, and over concerns about Railway's security. Ficino will be
self-hosted on <host> and reachable only over the tailnet. For now the owner is the only user; internal UM folks
may come later.

The work happens in this order, and the order is part of the decision:

1. **Straight port (this design).** Same behavior and the same HTTP contract, so today's React frontend runs
   unchanged against the new backend.
2. **Feed rework.** The owner's complaint is that the posts are "all similar / the same, not clever". This step
   adds a decision-model quality gate (Kev), a reranker and a better PDF parser. It gets its own design.
3. **shadcn UX redo** of the frontend. It gets its own design.

## Goals

- Every route in `ts-port-reference/api-contract.md` behaves the same: paths, status codes, `detail`
  strings, response shapes and side effects.
- Every background job in `ts-port-reference/worker-inventory.md` runs on Postgres. Redis and Celery are
  removed.
- The existing Playwright suite (`tests/e2e`, `ci` project first, then the full suite against a real
  Ollama) passes against the TS backend with the frontend unchanged. **This is the acceptance gate.**
- The owner's archived data (`<archive>/`) is restored and usable, re-embedded
  locally.

## Non-goals

- No feed or prompt redesign, no new product features, no frontend changes (except deleting dead Supabase
  code at cutover, if wanted).
- No multi-tenant SaaS features. Supabase auth and storage are dropped.
- No public internet exposure.

## Anti-goals (a failure even if it "works")

- One job's provider settings or API key leak into another job running at the same time. Today this only
  holds because Celery runs one task per process and mutates `os.environ`
  (`worker/lib/settings.py:110-149`). In Node, the resolved settings are passed per job.
- Search returns quietly wrong results because stored and query embeddings come from different models.
- Python app code survives "temporarily". The only Python left is inside off-the-shelf model servers
  (Ollama, vLLM, Kev).

## Decisions (made by the owner, or proposed and approved in chat)

| Area | Decision |
|---|---|
| Runtime | Node 24 LTS in the image (`node:24-alpine`). Host tooling may run Node ≥22.18. ESM, strict TS. |
| HTTP | Hono + `@hono/node-server`, Zod for request validation. |
| DB access | `postgres` (postgres.js), raw parameterized SQL ported close to verbatim from asyncpg. No ORM. |
| Migrations | Numbered `.sql` files in `server/migrations/` plus a small runner. `0001_baseline.sql` is the cleaned schema from `infra/postgres/init.sql`. |
| Jobs | pg-boss on the same Postgres, with a `job_progress` table for the `meta.step`/`post_progress` data the frontend polls. Job ids are stable across retries. |
| Layout | One package, `server/`, with two entry points (`api`, `worker`) sharing code. No separate shared package. |
| LLM | `@anthropic-ai/sdk`; Ollama via `fetch`. The existing thin wrappers are ported as-is. |
| PDF | `mupdf` npm (the same engine as PyMuPDF), behind an extractor interface so MinerU or PaddleOCR-VL can be added later. |
| Python-only extras | Marker and the local cross-encoder are dropped. They were never installed in the shipped image. |
| Auth | `none` and `basic` providers. Sessions and rate-limit counters live in Postgres. `supabase` is removed. |
| Storage | Local disk with HMAC-signed URLs, **including audio and podcast** (new; local storage could not do audio before). |
| Postgres | The newest GA major that has a `pgvector/pgvector` image. Today that's `pg18`: PG19 is at RC1, with GA planned for 2026-11-19, and no pgvector pg19 image exists yet. Development and tests run on pg18. The cutover plan re-checks and moves to pg19 if it's out by then. The archive is a PG17 dump and loads into either. |
| Embeddings | Default `qwen3-embedding:latest` (Qwen3-Embedding-8B) via Ollama's `/api/embed` with `dimensions: 1024`, so `vector(1024)` doesn't change. Verified on this host 2026-10-29. |
| Model defaults | Updated during the port: `qwen3.8:27b` (Ollama LLM), `claude-sonnet-5-5` / `claude-haiku-5-5` (API). |
| Per-AI-job interfaces | embed, rerank, generate, vision/extract, speak (and decide, in step 2). Each takes a resolved per-job settings object. |
| Logging / tests | pino; Vitest against a real `pgvector/pgvector:pg18` via testcontainers. |
| Deploy | Compose on <host>: postgres, api, worker, web, plus a Tailscale sidecar (own tailnet node, like zBrain/Sturnella). Register it in `<infra>/services.yaml` first. |

## Known bugs: fix during the port, don't reproduce

Each fix gets a test that pins the corrected behavior:
- `generate_chapter`: a planned figure slot throws outside the per-slot `try` and fails the whole chapter
  (`worker/tasks/reading_list_tasks.py:330-350`).
- `regenerate_post` always fails on figure posts.
- The Ollama figure-detection default leaves self-host with no figures (`FIGURE_DETECT_PROVIDER` defaults to
  `anthropic`). The self-host default becomes `ollama`.
- Local storage can't do audio or podcasts. It gains `{MEDIA_DIR}/feeds/{feed_id}/...`.

Everything else listed under "surprises" in the reference docs is reproduced, unless a plan marks it as a
deliberate change.

## Constraints

- The wire format is `ts-port-reference/api-contract.md`. The API serves at root, and nginx strips
  `/ficino/api`.
- The schema stays compatible with the restored data: no CHECK or enum constraints on status columns, the
  same table and column names, `vector(1024)`.
- CSRF double-submit (`ficino_csrf` / `X-CSRF-Token`) is enforced under `none` and `basic`.
- The e2e harness reaches into containers by name (`ficino-postgres`, `ficino-api`, needing `sh`, `base64`,
  `/app/figures`, user `ficino` uid 10001). The TS images keep those names and tools, or the `E2E_*`
  overrides get used.
- The Python code stays in the repo and runnable until the cutover plan deletes it.
- Exposure rules in `/projects/AGENTS.md` and `<infra>/README.md` apply to anything that listens.

## Roadmap (one implementation plan per slice; each ends with working, tested software)

1. **Foundation**: `docs/superpowers/plans/2026-10-29-ts-port-01-foundation.md`. Package, config, DB and
   migrations, test harness, shared pure modules, settings schema, app factory and middleware (errors, CSRF,
   security headers, CORS), auth (none/basic, Postgres sessions), rate limits, audit, and the job-free
   routers: health, auth, users, workspaces, settings, alerts, annotations, bookmarks, likes, tags,
   citations.
2. **Storage, jobs, ingestion**: local storage (PDF, figures, media) and signed URLs, the pg-boss queue and
   job-progress store, the worker entry, mupdf extraction, chunker (`js-tiktoken` cl100k), embed providers
   (Ollama `/api/embed` + dimensions, Voyage, OpenAI), contextualizer, figure detection, vision fallback,
   quality check, `process_paper`, the stale-paper cron, papers and figures routes.
3. **Retrieval, search, feed**: hybrid retrieval SQL, rerank interface (none/voyage/cohere), persona library
   and prompts (copied as rendered text), `generate_feed`, `regenerate_post` (fixed), the `/feed` routes
   including the `/feed/status` state mapping, `/search`, preferences, and the alert tasks.
4. **Conversations**: API-side LLM service and error grading, replies, zap, persona DMs, paper summaries and
   the `/messages` routes (including the stuck-job check), group-chat synthesis, archivist user posts.
5. **Reading lists and audio**: propose ordering, `generate_chapter` (fixed), ElevenLabs TTS and dialogue,
   feed audio and podcast on local media storage.
6. **Cutover**: compose on <host> with the Tailscale sidecar, services.yaml/CHANGELOG/audit, restore script
   (re-key to the stub user, copy files, `feed_posts` backfill, re-embed), the full e2e suite on the TS
   stack, deleting the Python services and Redis, and docs.

Plans 2–6 are written when the plan before them lands, so each builds on what the last one taught.

## Left to the builder

The internal module structure inside each slice beyond what its plan pins, logging fields, and helper names
not named in a plan's Interfaces blocks.

## Reference material

- `docs/superpowers/specs/ts-port-reference/api-contract.md`: every route, middleware, auth, rate limits and
  job-state mapping, with file:line refs and 27 porter pitfalls.
- `docs/superpowers/specs/ts-port-reference/worker-inventory.md`: every task, lib module, provider, prompt
  location and the feed pipeline, with 28 pitfalls.
- `docs/superpowers/specs/ts-port-reference/schema-tests-data.md`: schema, the init.sql vs prod diff, restore
  mapping, tests and deploy, with 20 pitfalls.
- `docs/superpowers/specs/ts-port-reference/rekey-test.sql`: tested SQL that re-keys the restored data to
  the stub user.
