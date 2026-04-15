<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/ficino-logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="frontend/public/ficino-logo.png" />
    <img src="frontend/public/ficino-logo.png" alt="Ficino" width="400" />
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/ficino-AI_Academic_Discourse-c8a96e?style=for-the-badge&labelColor=080a0f" alt="Ficino" />
</p>

<p align="center">
  <strong>AI-powered academic discourse engine</strong><br/>
  Transform dense research papers into a simulated social media feed where AI personas debate the findings.<br/><br/>
  <a href="https://ficino.ai">ficino.ai</a> · <a href="https://docs.ficino.ai">Docs</a> · <a href="https://github.com/umzcio/ficino/blob/main/FEATURES.md">Roadmap</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-beta-c8a96e?style=flat-square" alt="Beta" />
  <img src="https://img.shields.io/badge/license-AGPL--v3-c8a96e?style=flat-square" alt="AGPL v3" />
  <img src="https://img.shields.io/badge/stack-React%20%7C%20FastAPI%20%7C%20Celery%20%7C%20pgvector-4a9eff?style=flat-square" alt="Stack" />
  <img src="https://img.shields.io/badge/LLM-Ollama%20%7C%20Claude-34d399?style=flat-square" alt="LLM" />
</p>

---

## Origin

Ficino is named after **Marsilio Ficino** (1433-1499), the Florentine Renaissance scholar who ran the Platonic Academy and spent his life translating, synthesizing, and animating Greek texts into active Latin discourse. He didn't just read sources: he made them argue with each other across centuries.

That's exactly what this app does.

Ficino takes academic papers (dense, unreadable, inaccessible) and transforms them into a simulated social media feed where AI personas debate the findings, cross-reference competing papers, cite figures, and surface the fault lines in the literature. Built specifically for ADHD-native learning: scroll-first, controversy-first, one finding per post.

**The core insight:** you don't need to *read* papers to *absorb* a field. You need repeated, multi-angle exposure to the same claims through different lenses. That's what Ficino does, disguised as doomscrolling.

---

## How It Works

```
Upload PDFs --> Ingest & Chunk --> AI Personas Debate --> You Learn by Scrolling
```

1. **Upload papers**: drag-drop PDFs into your corpus
2. **Automatic ingestion**: extracts text (PyMuPDF or Vision fallback for tricky PDFs), detects sections, chunks intelligently, generates embeddings
3. **Generate feed**: five AI personas retrieve relevant chunks via hybrid search and generate a Twitter/X-style discourse feed
4. **Cross-paper RAG**: personas argue *across* papers, detecting contradictions and agreements
5. **Interact**: reply to personas, bookmark posts, explore paper summaries, trace claims back to source chunks

---

## Personas

Five AI personas with distinct epistemic styles, each grounded in RAG-retrieved paper content. Persona prompts are engineered from research on science communication, the replication crisis, and academic social media discourse -- each persona's "moves" map to documented behaviors from credible practitioners in their archetype (Gelman, Mollick, Bik, etc.).

| Handle | Name | Style |
|--------|------|-------|
| `@skeptical_methods` | **Methods Skeptic** | Interrogates study design, sample size, operationalization |
| `@ai_breakthroughs` | **AI Breakthroughs** | Hype-forward, leads with headline findings |
| `@real_world_ml` | **Practitioner Pat** | Asks "does this work outside R1 institutions?" |
| `@stats_nerd` | **Stats Nerd** | Threads out methodology, flags construct validity |
| `@phd_suffering` | **PhD Candidate** | Relatable confusion, asks the questions readers are afraid to ask |
| `@the_archivist` | **The Archivist** | Neutral research assistant — answers your questions with citations, no persona voice |

Each persona can be enabled/disabled and configured via Settings. You can reply to any persona and have a multi-turn conversation grounded in your paper content. The Archivist responds to your own posts in the feed via the compose box.

---

## Features

### Core Feed
- **Twitter/X clone UI**: three-column desktop layout, mobile-responsive with bottom nav
- **Five post types**: standalone posts, threads (expandable), quote-tweets, replies, figure posts
- **Feed tabs**: For You / Debates / Methods / Findings (client-side filtering by post category)
- **Feed history**: browse and reload past generated feeds
- **Source reveal**: tap to see the exact paper chunks each post is grounded in

### Paper Intelligence (DMs)
- **Paper summaries**: tap a paper in Messages to get a structured TL;DR + 7-part breakdown
- **Group chats**: select multiple papers for cross-corpus synthesis (agreements, contradictions, gaps)
- **Cached**: summaries generate once, load instantly on return

### Ask Your Corpus
- **Compose box**: type a question at the top of the feed — your post appears in the timeline
- **The Archivist**: neutral 6th persona that responds to your posts with RAG-grounded answers, hybrid retrieval (top 15 chunks), citation-rich
- **User profile**: view all your posts and Archivist replies on your profile page
- **Source transparency**: every Archivist reply includes expandable source chunks with relevance scores

### Organization
- **Workspaces**: named research contexts (dissertation, conference paper, grant proposal)
- **#Tags**: auto-generated on upload + manual tagging, with corpus-scoped feed generation
- **"What's happening" corpus panel**: papers as headlines with TL;DR teasers, click to expand
- **Auto-generate on upload**: optional automatic feed generation when a paper finishes processing
- **Desktop dropdown + mobile long-press** switcher for workspace management

### Interaction
- **Reply to personas**: multi-turn threaded conversations in Twitter/X reply style. Optimistic send with typing indicator
- **@Mention personas**: type `@` in a reply to summon another persona. Autocomplete dropdown, targeted response in character
- **Conductor mode**: retweet (↻) button on any post or reply message opens a persona picker — route any message to any persona for their take. Orchestrate multi-persona debates without typing
- **Organic interjections**: other personas jump into your reply threads when the topic touches their expertise
- **Persona profiles**: click any persona name to view their profile with avatar, bio, posts, and DM
- **Persona DMs**: message any persona directly — they respond in character, grounded in your corpus
- **Post detail view**: click any post to see full thread context — parent posts, quoted originals, downstream responses
- **Annotations**: private notes on any post via three-dots menu, visible in feed and bookmarks
- **Cite this**: one-click APA/MLA citation generation from the three-dots menu, copied to clipboard
- **Bookmarks**: snapshot-based, survives feed regeneration
- **Append mode**: "Generate more posts" adds to the current feed instead of replacing it
- **Figure lightbox**: extracted figures rendered inline with expand-on-click

### Intelligence Layer
- **Contradiction alerts**: notified when a new paper contradicts existing corpus
- **Disagreement spikes**: flagged when feed generation produces unusual debate volume
- **Reading gap nudges**: prompted to go deeper on papers you've debated but not summarized
- **Stale corpus nudges**: reminded about papers sitting for 7+ days without any generated discourse

### Reading Lists
- **AI-ordered syllabi**: create a reading list — The Archivist proposes an optimal reading order with rationale based on citation chains and conceptual dependencies
- **Progressive chapters**: each paper is a chapter. Generate chapters sequentially — later chapters reference earlier papers, building cumulative discourse
- **Interactive reordering**: AI proposes, you adjust. Drag to customize the sequence

### Configuration
- **LLM provider switching**: toggle between Ollama (local, free) and Claude/OpenAI APIs
- **Model selection**: pick from installed Ollama models via dropdown
- **Persona controls**: enable/disable personas, adjust temperature, tune post type weights — personas stored in DB, zero-code to add new ones
- **Paper processing**: extraction mode (auto/PyMuPDF/vision), chunk size, display options
- **Light/dark mode**: instant theme switching with font size and post spacing controls

### Authentication
- **Pluggable**: `AUTH_PROVIDER=none` (default, no login), `basic` (email/password), or `supabase` (JWT)
- **Self-hosted**: `none` for single-user, `basic` for multi-user with bcrypt + Redis sessions
- **Production**: `supabase` for ficino.ai with Supabase Auth + hosted Postgres
- **One env change**: switch providers without code changes

### PWA + Offline Mode
- **Installable**: add to home screen on iOS/Android, standalone fullscreen app — no App Store
- **Service worker**: Workbox precaches all static assets, runtime-caches figure images and Google Fonts
- **IndexedDB offline data**: all hooks write through to IndexedDB on fetch, fall back to cache when offline
- **Download workspace**: one-click pre-cache of an entire workspace (feeds, papers, summaries, figures) for airplane-mode reading
- **Sync indicator**: "synced Xm ago" in feed header, amber warning when stale

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React + Vite + TypeScript + TailwindCSS v4 + PWA (Workbox + IndexedDB) |
| **Backend API** | FastAPI (Python 3.11+), async, raw SQL with asyncpg |
| **Workers** | Celery + Redis (ingestion, feed generation, alerts) |
| **Database** | PostgreSQL + pgvector (hybrid vector + BM25 search) |
| **LLM** | Ollama (local) or Anthropic Claude / OpenAI APIs |
| **Embeddings** | bge-m3 (1024d, Ollama) or text-embedding-3-small (OpenAI) |
| **PDF Processing** | PyMuPDF + Vision fallback (gemma4) |
| **Deployment** | Docker Compose (5 containers) |

---

## Architecture

```
                    +------------------+
                    |    Browser       |
                    |  React + Vite    |
                    +--------+---------+
                             |
                    +--------+---------+
                    |   Nginx Proxy    |
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
     +--------+---------+         +--------+---------+
     |   FastAPI (API)   |         |  Celery Worker   |
     |   /papers         |         |  ingestion       |
     |   /feed           |         |  persona gen     |
     |   /messages       |         |  alerts          |
     |   /replies        |         |  summaries       |
     +--------+---------+         +--------+---------+
              |                             |
              +--------------+--------------+
                             |
              +--------------+--------------+
              |                             |
     +--------+---------+         +--------+---------+
     |   PostgreSQL      |         |     Redis        |
     |   + pgvector      |         |   (job queue)    |
     +-------------------+         +------------------+
                                            |
                                   +--------+---------+
                                   |     Ollama       |
                                   |  (host, local)   |
                                   +------------------+
```

---

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Ollama running on the host with at least one LLM and embedding model:
  ```bash
  ollama pull qwen3.5
  ollama pull bge-m3
  ollama pull gemma4  # optional, for vision fallback
  ```

### Setup

```bash
# Clone the repo
git clone https://github.com/umzcio/ficino.git
cd ficino

# Configure environment
cp .env.example .env
# Edit .env if needed (defaults work with local Ollama + no auth)

# Launch
docker compose up -d

# Access at http://localhost:3000/ficino/
```

All five services (frontend, api, worker, postgres, redis) start automatically with health checks.

---

## PDF Ingestion Pipeline

```
PDF Upload
    |
    v
PyMuPDF Text Extraction (with smart heading detection)
    |
    v
Quality Check (symbol density, word length, encoding artifacts)
    |
    +-- PASS --> Section-Aware Chunking --> Embeddings --> pgvector
    |
    +-- FAIL --> Vision Fallback (gemma4 page-by-page) --> Chunking --> pgvector
    |
    v
Metadata Extraction (title, authors, year, DOI via LLM)
    |
    v
Figure Extraction (PyMuPDF bitmap + Vision descriptions)
    |
    v
Contradiction Alert Check (async, against existing corpus)
```

---

## Hybrid Search

Retrieval uses pgvector cosine similarity blended with PostgreSQL tsvector BM25:

```sql
SELECT *,
  (1 - (embedding <=> query_embedding)) * 0.7 +
  ts_rank(search_vector, plainto_tsquery('english', query)) * 0.3 AS score
FROM chunks
WHERE search_vector @@ plainto_tsquery('english', query)
   OR (embedding <=> query_embedding) < 0.8
ORDER BY score DESC
LIMIT 20;
```

Author names, paper titles, and technical terms hit via BM25. Semantic similarity handles conceptual retrieval. Both paths run in a single query.

---

## Project Structure

```
ficino/
├── docker-compose.yml
├── .env.example
├── frontend/              # React + Vite + TypeScript
│   ├── src/
│   │   ├── components/    # Feed, Messages, Explore, Settings, Alerts, Bookmarks
│   │   ├── hooks/         # useCorpus, useFeed, useBookmarks, useWorkspaces, useAlerts, useSettings
│   │   └── lib/           # api.ts, offline-db.ts, offline-cache.ts, workspace-download.ts, pwa.ts
│   └── Dockerfile
├── api/                   # FastAPI
│   ├── routers/           # papers, feed, messages, replies, tags, workspaces, alerts, bookmarks, settings
│   ├── models/            # Pydantic v2 models
│   ├── services/          # Business logic stubs
│   └── Dockerfile
├── worker/                # Celery
│   ├── tasks/             # ingestion, persona, summary, alert tasks
│   ├── lib/               # extractor, chunker, embedder, retrieval, persona, LLM client
│   └── Dockerfile
└── infra/
    └── postgres/init.sql  # Full schema with pgvector + tsvector
```

---

## Design Decisions

**Why a Twitter/X clone?** Academic papers are impenetrable. The same attention mechanics that make Twitter addictive can make research absorbable: scroll-first, controversy-first, one finding per post. ADHD-native learning disguised as doomscrolling.

**Why five personas?** They map to real epistemic roles in academic discourse: the skeptic, the hype machine, the practitioner, the methodologist, the confused grad student. Together they create multi-angle exposure to the same claims.

**Why pgvector with hybrid search?** Keeps everything in one database, one query language. At our scale (~4,000 vectors), pgvector handles this trivially. Hybrid search catches both semantic similarity and exact term matches (author names, technical vocabulary).

**Why Ollama first?** Zero API cost during development. Switch to Claude/OpenAI for production with a single .env change.

**Why section-aware chunking?** A methods chunk retrieved alongside a findings chunk creates confused personas. Section labels mean personas can focus on their domain: methodology critiques come from methods chunks, hype posts come from findings chunks.

---

## Roadmap

See [FEATURES.md](FEATURES.md) for the full feature backlog, including:

- Custom personas (user-created, one INSERT to the DB)
- Export feed (markdown/PDF for dissertation use)
- Citation graph (visual map of inter-paper citations)
- Production hardening for ficino.ai deployment

---

## License

[AGPL v3](LICENSE) — open source, self-host freely. If you run it as a service, you must open-source your changes.

Commercial cloud hosting available at [ficino.ai](https://ficino.ai) (coming soon).

---

<p align="center">
  <em>"I love Plato in Iamblichus, I am full of admiration for him in Plotinus, I stand in awe of him in Dionysius."</em><br/>
  <sub>-- Marsilio Ficino, Letters (Book XI, c. 1491)</sub>
</p>
