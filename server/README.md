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

### Environment variables added by plan 03

| Variable | Default | Meaning |
| --- | --- | --- |
| `RETRIEVAL_VECTOR_WEIGHT` | 0.7 | Weight of the vector score in hybrid retrieval (clamped to 0..1; unparsable values warn and use the default) |
| `RETRIEVAL_KEYWORD_WEIGHT` | 0.3 | Weight of the keyword (tsvector) score (clamped to 0..1) |
| `RETRIEVAL_MAX_VECTOR_DISTANCE` | 0.8 | Only sets the `match_type` label: a text-matching candidate nearer than this cosine distance is `hybrid`, otherwise `keyword`. It never drops a candidate (clamped to 0..1) |
| `RETRIEVAL_CANDIDATE_POOL` | 100 | Candidates fetched per leg before fusion |
| `RETRIEVAL_RERANK_MULTIPLIER` | 5 | Candidates sent to the reranker, as a multiple of the number wanted |
| `SEARCH_USE_NORMALIZED_POSTS` | true | `/search` reads posts from `feed_posts`; false falls back to the legacy scan of the last 20 feeds |

Retrieval only considers chunks whose `metadata->>'embed_model'` equals the configured embedding model, so changing
the embedding model hides old chunks until they are re-embedded.

The worker now runs five more queues (all one job at a time per process): `generate_feed` (2 retries, 30 s delay),
`regenerate_post`, `check_contradictions`, `check_post_feed` and `compute_preferences` (no retries; the last
three are fanned out by `generate_feed` and a failed send never fails the feed). Plan 04 (below) adds four more.

`/media/...` is new in the TS server: it serves feed audio and podcast files from `MEDIA_DIR` behind the same signed-URL
check as figures. Plan 05 adds byte ranges (below).

### Conversations (plan 04)

Plan 04 adds the routers for every conversation surface. Each is behind `requireUser`, and every read or write of user
data is scoped to the caller. The one exception is the summary status poll, which reads only the job state, as in Python.

| Router | Routes | Notes |
| --- | --- | --- |
| `/personas` | `GET /`, `GET /:key/stats`, `GET /:key/replies`, `GET`/`POST`/`DELETE /:key/dm`, `DELETE /:key/dm/:message_index` | The DM is a synchronous LLM call (`persona_dm` bucket) |
| `/replies` | `GET /conversations`, `GET /replied-posts/:feed_id`, `GET /:feed_id/:post_index`, `POST /`, `POST /zap`, `DELETE /:feed_id/:post_index/message/:message_index` | `POST /` runs the main reply, up to 3 @mentions and the organic interjection in parallel; `/` and `/zap` share the `reply` bucket |
| `/messages` | `GET /papers`, `GET /papers/tldrs`, `GET /papers/:paper_id`, `GET /papers/:paper_id/status/:task_id`, `GET /groups`, `POST /groups`, `GET /groups/:synthesis_id` | The first view of a paper dispatches its summary and charges `summary`; cached reads are free. An `error` row, or a `generating` row whose job is failed, cancelled, completed or missing, is re-dispatched |
| `/user-posts` | `GET /`, `GET /:post_id`, `GET /:post_id/status`, `POST /`, `POST /:post_id/replies`, `DELETE /:post_id` | The Archivist answers in the worker (`user_post` bucket). A failed dispatch marks the post `error` and returns 503 |

Synchronous LLM calls (DMs, replies, zaps) resolve the caller's provider settings per request, as the worker does. A
provider failure is graded: unreachable or timed out is 503, an upstream 4xx is 502, an upstream 5xx is 503, a malformed
provider body is 400, and anything else is 500. A failed main call writes nothing.

The worker runs four more queues, one job at a time per process:

| Queue | Retries | What it does |
| --- | --- | --- |
| `generate_paper_summary` | 2, 30 s delay | Writes `paper_summaries`; the final failed attempt marks the row `error` |
| `generate_corpus_synthesis` | 2, 30 s delay | Completes the `corpus_syntheses` placeholder; the final failed attempt marks it `error` |
| `respond_to_user_post` | 2, 180 s delay | Retrieves over the post's corpus and stores the Archivist reply and its sources |
| `respond_to_user_post_followup` | 2, 180 s delay | Answers the trailing user turn and appends the reply |

`scripts/ollama-conversations-smoke.ts` is a manual run of the summary, a DM, a reply, a zap and an Archivist post
against a real local Ollama (see its header); it is not part of CI.

### Reading lists and audio (plan 05)

Plan 05 serves the last two product slices; after it every route in the API contract is served and every queue in
`src/jobs/registry.ts` has a handler.

| Router | Routes | Notes |
| --- | --- | --- |
| `/reading-lists` | `GET /`, `GET /:list_id`, `POST /`, `PUT /:list_id/reorder`, `PUT /:list_id/apply-ordering`, `POST /:list_id/chapters/:chapter_index/generate`, `DELETE /:list_id` | `POST /` creates the list and one chapter per paper (the first `unlocked`) and dispatches `propose_ordering`; it and chapter generation charge `feed_generation`. A chapter's progress is polled at `GET /feed/status/:task_id` |
| `/feed` | `POST /:feed_id/audio`, `POST /:feed_id/podcast` | 501 `Audio TTS not configured` without `ELEVENLABS_API_KEY`. A `ready` feed or a fresh `generating` claim answers 202 without a charge; NULL, `failed` or a `generating` claim older than the reclaim window (`JOB_TIME_LIMIT_SEC`, 20 minutes at the default) is charged to the shared `audio` bucket and dispatched |

The worker runs the four remaining queues:

| Queue | Retries | What it does |
| --- | --- | --- |
| `propose_ordering` | 2, 180 s delay | Asks the LLM for a reading order with one rationale per paper; a malformed or mismatched answer falls back to the stored order with empty rationales |
| `generate_chapter` | 2, 180 s delay | Builds the chapter's feed from its papers (figure slots as in `generate_feed`), marks the chapter `complete` and unlocks the next one in one transaction |
| `generate_audio_for_feed` | none | Claims `audio_status`, renders each post to its own mp3 in its persona's voice (ElevenLabs text-to-speech, falling back to the default voice) and ends `ready`; any throw ends `failed` |
| `generate_podcast_for_feed` | none | Claims `podcast_status`, writes a two-host script with the LLM and renders it in ONE ElevenLabs text-to-dialogue call into ONE file. A script over 2000 code points fails the podcast; it is never split |

Media lives on local disk under `MEDIA_DIR`:

- feed audio: `{MEDIA_DIR}/feeds/{feed_id}/audio/post_<n>.mp3` (one file per post, `n` the post's index);
- podcast: `{MEDIA_DIR}/feeds/{feed_id}/podcast/episode.mp3`.

Every feed delete path (clear-feeds, clear-papers, clear-everything, the delete of a workspace's last paper) removes
`{MEDIA_DIR}/feeds/{feed_id}/`. `GET /feed/:feed_id` returns `audio_url` (per post) and `podcast_audio_url` as
`${PUBLIC_API_BASE}/media/feeds/...?token=...`, because the frontend assigns them to `audio.src` as-is. `/media`
answers a single byte range (`Range: bytes=a-b`, `bytes=a-` or `bytes=-n`) with 206 and `Content-Range`, an
unsatisfiable one with 416, and always sends `Accept-Ranges: bytes`; HEAD carries `Content-Length` without a body.

#### Environment variables added by plan 05

| Variable | Default | Meaning |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | (none) | Operator key for ElevenLabs; never a user setting. Without it the audio routes answer 501 |
| `ELEVENLABS_MODEL_ID` | `eleven_turbo_v2_5` | The single-voice text-to-speech model (feed audio) |
| `ELEVENLABS_DIALOGUE_MODEL_ID` | `eleven_v3` | The text-to-dialogue model (podcast) |
| `PUBLIC_API_BASE` | `/ficino/api` | The path the browser reaches this API under, prefixed to media URLs |

`PUBLIC_API_BASE` supports only same-origin deployments: it must be empty or a path (matching a relative
`VITE_API_BASE`), never an origin; set it to the prefix the reverse proxy strips. The API and the worker must share
`MEDIA_DIR` and `SIGNED_URL_KEY`.

`scripts/elevenlabs-audio-smoke.ts` is a manual run of a reading list, a chapter and its podcast against a real local
Ollama and, with `ELEVENLABS_API_KEY` set, the real ElevenLabs API (feed audio only with `SMOKE_FEED_AUDIO=1`); see its
header for the cost. It is not part of CI.

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
