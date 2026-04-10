# Ficino — Claude Code Build Prompt

You are building **Ficino** (ficino.ai) — a production-ready, fully shipped AI-powered academic discourse engine. This is not a prototype or MVP. Every feature must be complete, tested, and working before you move to the next one.

---

## Read First

Before writing any code, read and internalize these two files completely:

1. **`FICINO.md`** — full product context, tech stack, project structure, design decisions, known problem areas
2. **`ficino-prototype.jsx`** — the UX prototype showing the exact UI, persona design, post types, color scheme, and visual language

These are your source of truth. Do not deviate from architecture or design decisions without flagging it first.

---

## Guiding Principle: Build, Test, Verify — Then Move On

You do not move to the next feature until the current one is **provably working**. After implementing each feature or module, you must:

1. Write automated tests covering the implementation
2. Run those tests and confirm they pass
3. Spin up the relevant Docker services
4. Use a browser testing agent (Playwright) to open the actual running app and verify the feature works end-to-end in a real browser
5. Only after all tests pass and the browser agent confirms correct behavior do you proceed

If a test fails or the browser agent finds a bug, fix it before moving on. No exceptions.

---

## Testing Stack

Add the following to the project from the start — testing is not optional:

### Backend Testing
- **pytest** + **pytest-asyncio** for all Python code
- **httpx** for FastAPI endpoint testing (async test client)
- **factory_boy** for test data factories
- **pytest-docker** to spin up Postgres + Redis for integration tests
- Every module in `worker/lib/` must have a corresponding `tests/test_<module>.py`
- Every FastAPI router must have integration tests covering success, validation error, and failure paths
- Celery tasks must have unit tests with mocked external calls (Claude API, OpenAI API) and integration tests against real Postgres/Redis

### Frontend Testing
- **Vitest** for unit and component tests
- **React Testing Library** for component behavior
- **Playwright** for end-to-end browser testing
- Every component must have a Vitest test
- Critical user flows must have Playwright e2e tests (see Browser Agent section below)

### Browser Testing Agent
After each feature is implemented, run a **Playwright agent** that:
- Spins up the full Docker Compose stack (`docker compose up -d`)
- Waits for all services to be healthy
- Opens the app in a real Chromium browser
- Executes the specific test scenario for the feature just built
- Takes screenshots at key steps and saves them to `tests/screenshots/`
- Asserts on visible UI elements, not just network responses
- Tears down cleanly after

Playwright test files live in `tests/e2e/`. Each feature gets its own e2e test file.

---

## Build Order — Complete Features Only

Build in this order. Each item is a complete, tested, browser-verified feature before moving to the next.

### 1. Infrastructure
- `docker-compose.yml` with all five services: frontend, api, worker, postgres, redis
- Dockerfiles for frontend, api, worker
- `.env.example` with all environment variables documented
- `infra/postgres/init.sql` — full schema (see schema spec below)
- Health check endpoints on api (`/health`) and worker
- **Test**: `docker compose up` starts cleanly, all services healthy, `/health` returns 200
- **Browser agent**: opens `localhost:3000`, confirms app loads without errors

### 2. PDF Ingestion Pipeline
- `worker/lib/marker_extractor.py` — Marker primary extraction → markdown
- `worker/lib/quality_check.py` — gibberish detection, routes to fallback
- `worker/lib/vision_extractor.py` — Claude Vision page-by-page fallback → markdown
- `worker/lib/pdf_extractor.py` — PyMuPDF figure extraction (bitmap + rasterized fallback)
- `worker/lib/chunker.py` — section-aware chunking, 800 token max, section labels preserved
- `worker/lib/embedder.py` — OpenAI text-embedding-3-small, batched
- `worker/tasks/ingestion_tasks.py` — full orchestration with status updates and extraction path logging
- **Tests**: unit tests for each lib module with real PDFs (include 3 test PDFs in `tests/fixtures/`: one clean, one font-encoded garbage, one scanned). Integration test for full ingestion pipeline end-to-end.
- **Browser agent**: uploads a real PDF via the UI, watches status update from pending → complete, confirms chunks appear in corpus panel

### 3. Paper Upload UI
- `PaperUpload.tsx` — drag-drop PDF upload, progress indicator, status polling
- `CorpusPanel.tsx` — live list of papers with status badges (pending, extracting, chunking, embedding, complete, error), chunk counts, extraction path tag (marker_clean / vision_fallback)
- FastAPI `/papers` router — upload, list, delete, status endpoints
- **Tests**: component tests for upload states, integration tests for upload endpoint
- **Browser agent**: drags a PDF onto the upload zone, watches the status badge progress through all states, confirms paper appears in corpus panel with correct chunk count

### 4. Feed Generation
- `worker/lib/retrieval.py` — hybrid search (vector + BM25), cross-paper by default
- `worker/lib/contradiction.py` — classify retrieved chunks as supports/contradicts/extends
- `worker/lib/persona.py` — persona system prompt construction with retrieved chunks
- `worker/tasks/persona_tasks.py` — full orchestration: RAG → contradiction → Claude → JSON feed
- FastAPI `/feed` router — generate, get, list feeds
- **Tests**: unit tests for retrieval with known chunk fixtures, eval set of 20 chunk pairs with known contradiction relationships (test contradiction detection accuracy), integration test for full feed generation
- **Browser agent**: clicks Generate with a paper in corpus, watches feed populate post-by-post, confirms all post types render correctly (post, thread, quote, reply), confirms paper tags are present

### 5. Figure Extraction & Figure Posts
- `worker/lib/figure_describer.py` — Claude Vision figure → description + claim mapping
- Figure posts rendered inline in feed with `FigureCard.tsx` matching prototype exactly
- `infra/figures/` volume for figure image storage, served via FastAPI static route
- **Tests**: figure extraction tests against PDFs with known figures, Vision description mocking, FigureCard component rendering tests
- **Browser agent**: confirms figure post renders with the extracted image, "EXTRACTED FIGURE" label, expandable on click, caption below

### 6. Cross-Paper Discourse
- Enable cross-paper retrieval across full corpus (not just single paper)
- Contradiction detection triggers persona replies across papers
- Persona reply chains reference specific papers and authors by name
- **Tests**: integration test with 2+ papers in corpus, assert generated feed contains at least one cross-paper quote or reply
- **Browser agent**: uploads 2 papers on related topics, generates feed, confirms personas argue across papers with paper tags from different sources in the same thread

### 7. Auth & User Management
- Clerk integration — sign up, sign in, session management
- User corpus isolation — users only see their own papers and feeds
- Protected routes on all API endpoints
- Protected frontend routes
- **Tests**: auth middleware tests, corpus isolation tests (user A cannot access user B's papers)
- **Browser agent**: creates two accounts, uploads different papers to each, confirms corpus isolation holds

### 8. Corpus Organization
- Tag system for papers — users can add/remove tags
- Feed generation can be scoped to a tag subset
- Tags visible in CorpusPanel
- **Tests**: tag CRUD tests, feed scoping tests
- **Browser agent**: tags two papers differently, generates feed scoped to one tag, confirms only that paper's content appears

### 9. Feed History & Bookmarks
- Feed history — list of past generated feeds per user
- Bookmarks — users can bookmark individual posts
- Bookmarked posts accessible from bookmark nav item
- **Tests**: history and bookmark CRUD tests
- **Browser agent**: generates two feeds, confirms both appear in history, bookmarks a post, navigates to bookmarks, confirms post is there

### 10. Retrieval Debug View
- Dev-only route `/debug/retrieval` — for a given post, shows the top-k chunks that were retrieved, which paper they came from, contradiction classification, and final score
- Hidden in production (env flag), always available in development
- **Tests**: debug endpoint returns correct chunk metadata
- **Browser agent**: in dev mode, clicks a post to open debug view, confirms chunk sources and scores are displayed

### 11. Rate Limiting & Cost Controls
- Per-user feed generation limits (configurable via env)
- Rate limit headers on all endpoints
- Graceful error UI when limit is hit
- Generation cost estimation shown before triggering (estimated Claude API calls × token estimate)
- **Tests**: rate limit enforcement tests, limit reset tests
- **Browser agent**: hits rate limit, confirms graceful error message in UI, not a crash

### 12. Production Hardening
- Structured logging (JSON) across all services
- Sentry error tracking integration (api + worker + frontend)
- Postgres connection pooling (asyncpg pool, not per-request connections)
- Redis connection pooling
- Celery worker concurrency configured via env
- Frontend bundle optimization (code splitting, lazy loading heavy components)
- Security headers (CORS properly locked down, CSP, X-Frame-Options)
- Input validation and sanitization on all upload endpoints (file type, file size limits)
- **Tests**: security header tests, file validation tests, load test with locust (100 concurrent users, upload + generate flow)
- **Browser agent**: full smoke test of entire app — upload, generate, view figures, bookmark, view history, sign out, sign in

---

## Database Schema

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  generation_count_today INTEGER DEFAULT 0,
  generation_reset_at TIMESTAMPTZ DEFAULT NOW()
);

-- Corpora (named collections of papers per user)
CREATE TABLE corpora (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Papers
CREATE TABLE papers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  corpus_id UUID REFERENCES corpora(id) ON DELETE SET NULL,
  title TEXT,
  authors TEXT[],
  year INTEGER,
  doi TEXT,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  extraction_path TEXT,
  error_message TEXT,
  chunk_count INTEGER DEFAULT 0,
  figure_count INTEGER DEFAULT 0,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Tags
CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE paper_tags (
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
  tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);

-- Chunks
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_type TEXT NOT NULL DEFAULT 'text',
  chunk_index INTEGER NOT NULL,
  token_count INTEGER,
  embedding vector(1536),
  search_vector tsvector,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON chunks USING GIN (search_vector);

CREATE OR REPLACE FUNCTION chunks_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chunks_search_vector_update
  BEFORE INSERT OR UPDATE ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_search_vector_trigger();

-- Figures
CREATE TABLE figures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  extraction_type TEXT NOT NULL,
  description TEXT,
  claim_summary TEXT,
  figure_index INTEGER NOT NULL,
  processed_at TIMESTAMPTZ
);

-- Feeds
CREATE TABLE feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  corpus_id UUID REFERENCES corpora(id) ON DELETE SET NULL,
  tag_filter TEXT[],
  posts JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  generation_duration_ms INTEGER,
  paper_count INTEGER,
  post_count INTEGER
);

-- Bookmarks
CREATE TABLE bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  post_index INTEGER NOT NULL,
  post_snapshot JSONB NOT NULL,
  bookmarked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, feed_id, post_index)
);
```

---

## Code Style & Constraints

- **Python**: 3.11+, type hints on every function signature, Pydantic v2 models for all data shapes
- **FastAPI**: async endpoints throughout, dependency injection for DB sessions and auth
- **No ORM**: raw SQL with asyncpg for all database access
- **React**: functional components, TypeScript strict mode, no class components, no `any` types
- **Error handling**: every worker task handles failures gracefully, updates paper status to `error` with message, max 2 Celery retries
- **Secrets**: never hardcoded, always from environment variables
- **Docker**: `docker compose up` from repo root is the only setup step beyond `.env`
- **Logging**: structured JSON logs with request IDs, paper IDs, and task IDs on every log line
- **Tests**: no skipped tests, no `# type: ignore` without a comment explaining why

---

## Prototype Reference

`ficino-prototype.jsx` is the design spec. Match it exactly:
- Background `#080a0f`, borders `#1e2028`
- Gold accent `#c8a96e` for tabs, tags, buttons, figure labels
- Five personas with initials avatars and distinct accent colors
- Post types: post, thread, quote, reply, figure
- Figure posts: extracted figure card with EXTRACTED FIGURE label, expand on click, italic caption
- Sidebar: Active Corpus panel + Personas panel
- Feed header: "ficino" wordmark + BETA pill + Generate button

---

## Playwright Browser Agent — How to Run

After each feature, run:

```bash
docker compose up -d
npx playwright test tests/e2e/<feature>.spec.ts --headed
```

Each e2e spec must:
1. Wait for all services healthy before starting
2. Use real interactions (click, type, drag-drop) — not direct API calls
3. Assert on visible text and UI state
4. Save screenshots to `tests/screenshots/<feature>/`
5. Clean up test data after each run

---

## Ask Before Proceeding If:

- A test is failing and you've spent more than 2 attempts fixing it — describe the failure and ask
- A dependency has a breaking change that requires architectural deviation
- PDF extraction produces unexpected output on the test fixtures
- You want to propose a schema change not covered above

Otherwise: build it, test it, open it in a browser, confirm it works, then move on.
