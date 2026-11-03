# ficino-server

The TypeScript port of Ficino's backend (Hono + postgres.js + zod). It serves the same wire contract as the
Python FastAPI service, so the React frontend works unchanged. The Python `api/` and `worker/` services remain
in place and keep running until the cutover plan; nothing here replaces them yet.

## Commands

Run from `server/` (Node >= 22.18; the image uses Node 24).

| Command | What it does |
| --- | --- |
| `npm run dev:api` | Starts the API with file watching (`DATABASE_URL` required; `PORT`, default 8000; binds to 127.0.0.1 unless `API_HOST` is set) |
| `npm test` | Runs the vitest suite against a throwaway Postgres |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev:worker` | Starts the ingestion worker with file watching |
| `npm run worker` | Runs the built worker (`node dist/worker/main.js`; needs `npm run build`) |
| `npm run build` | Emits `dist/` (entries: `dist/api/main.js`, `dist/worker/main.js`; `src/` only, never `test/` or `scripts/`) |
| `npm run migrate` | Applies `migrations/NNNN_*.sql` to `DATABASE_URL` (the API also migrates on startup) |

The container image is built from `server/Dockerfile` and listens on 8000 inside the container (`API_HOST=0.0.0.0` is set in the image only).
The image also sets `ENVIRONMENT=production` so a bare `docker run` fails closed (no dev CORS; `SIGNED_URL_KEY` required). For a local `docker run`, pass `-e ENVIRONMENT=development` to get dev CORS.

## Worker

The worker is a separate process from the API and runs from the same image. The default CMD starts the API;
start the worker with `node dist/worker/main.js` (compose: `command: ["node","dist/worker/main.js"]`). It migrates
the database at boot, starts pg-boss (queues, retries, the cron schedules) and runs one handler per queue. Both
processes need the same `DATABASE_URL`, the same `SIGNED_URL_KEY` (or `ENVIRONMENT=development`) and the same
volumes for `UPLOAD_DIR`, `FIGURES_DIR` and `MEDIA_DIR`: the API writes the uploaded PDF and the worker reads it.
The mupdf `.wasm` ships in the image through `node_modules/mupdf` (production dependencies are kept); the Dockerfile
fails the build if it is missing.

### Environment variables added by plan 02

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEDIA_DIR` | `/app/media` | Where feed media (audio, podcasts) is stored; served by `/media` |
| `WORKER_DB_POOL_MAX_SIZE` | `DB_POOL_MAX_SIZE`, else 10 | Worker connection pool (at least 2) |
| `WORKER_INGESTION_CONCURRENCY` | 1 | Concurrent `process_paper` jobs (at least 1) |
| `JOB_TIME_LIMIT_SEC` | 600 | Per-job expiry (at least 120); the soft limit that aborts provider calls is this minus 60 s |
| `EMBED_DIM` | 1024 | Embedding width; only 1024 is accepted (`chunks.embedding` is `vector(1024)`) |
| `MAX_VISION_PAGES` | 100 | Pages sent to the vision fallback / figure detector per paper |
| `CONTEXT_MAX_PAPER_CHARS` | 200000 | Paper text given to the contextualizer |
| `CONTEXT_MAX_TOKENS` | 150 | Max tokens per chunk context |
| `SIGNED_URL_KEY` | (none) | Signs figure and media URLs; required unless `ENVIRONMENT=development` |

Provider choices (`EMBED_PROVIDER`, `LLM_PROVIDER`, `FIGURE_DETECT_PROVIDER`, `VISION_PROVIDER`, the model names, the
API keys, `OLLAMA_BASE_URL`) are per-user settings with these environment variables as defaults. The default
figure-detect Anthropic model is `claude-sonnet-5-5`. Set `FIGURE_DETECT_PROVIDER=none` to skip figure extraction.

`/media/...` is new in the TS server: it serves feed audio and podcast files from `MEDIA_DIR` behind the same signed-URL
check as figures. It has no `Range` support yet.

## Tests

Docker must be available. `test/globalSetup.ts` starts `pgvector/pgvector:pg18` with the docker CLI, published
on 127.0.0.1 only (never 0.0.0.0), migrates it, and removes it afterwards. Each DB test file calls
`resetDb(testSql())` in `beforeEach`. If a run is killed, clean up with `docker ps --filter name=ficino-ts-test`.

### Goldens

Ingestion output is pinned to files produced by the Python worker, under `test/fixtures/goldens/`: the PyMuPDF text,
page text and 150 dpi raster probes of `test/fixtures/sample.pdf`; the chunker and quality-check cases; the metadata and
contextualizer prompts. To regenerate them, build the fixture with `npx tsx test/fixtures/build-sample-pdf.ts`, then run
the scripts in `test/fixtures/goldens/gen/` inside the `ficino-worker` image as described in
`test/fixtures/goldens/gen/README.md` (no network, goldens dir temporarily writable for uid 10001). Review the diff
before committing: a changed golden means the TS output no longer matches Python. The `gen/*.py` scripts are deleted
with `worker/` at the cutover.

## Porting convention

`test/PORTING.md` lists every Python test in `api/tests` and `shared/tests`, one line each.

- Ported: tick the box and append ` — plan01/T<N>`.
- Not applicable: tick it and append ` — n/a: <reason>`.
- Owned by a later plan: leave unticked and append ` — plan0X`.

Wire literals (paths, status codes, `detail` strings) are copied exactly from the contract in
`docs/superpowers/specs/ts-port-reference/api-contract.md`.
