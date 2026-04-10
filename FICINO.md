# Ficino

**ficino.ai** — AI-powered academic discourse engine

---

## Origin & Story

Ficino is named after Marsilio Ficino (1433–1499), the Florentine Renaissance scholar who ran the Platonic Academy and spent his life translating, synthesizing, and animating Greek texts into active Latin discourse. He didn't just read sources — he made them argue with each other across centuries.

That's exactly what this app does.

Ficino takes academic papers — dense, unreadable, inaccessible — and transforms them into a simulated social media feed where AI personas debate the findings, cross-reference competing papers, cite figures, and surface the fault lines in the literature. Built specifically for ADHD-native learning: scroll-first, controversy-first, one finding per post.

The core insight: you don't need to *read* papers to *absorb* a field. You need repeated, multi-angle exposure to the same claims through different lenses. That's what Ficino does, disguised as doomscrolling.

---

## What It Does

1. **User uploads PDFs** (academic papers, preprints, reports)
2. **Ingestion pipeline** extracts text chunks + embedded figures/diagrams
3. **Vector store** indexes all chunks with paper metadata, enabling cross-paper retrieval
4. **Persona engine** generates a simulated social feed — posts, threads, quote-tweets, replies — where AI personas debate the papers
5. **Cross-paper RAG** detects when claims in one paper contradict or extend claims in another, triggering persona arguments across papers
6. **Figure extraction** pulls diagrams and charts from PDFs, describes them via Claude Vision, and renders them inline in posts like image attachments

---

## Personas

Five AI personas with distinct epistemic styles, each grounded in RAG-retrieved paper content:

| Handle | Name | Style |
|--------|------|-------|
| `@skeptical_methods` | Methods Skeptic | Interrogates study design, sample size, operationalization |
| `@ai_breakthroughs` | AI Breakthroughs | Hype-forward, leads with headline findings |
| `@real_world_ml` | Practitioner Pat | Asks "but does this work outside R1 institutions?" |
| `@stats_nerd` | Stats Nerd | Threads out methodology, flags construct validity issues |
| `@phd_suffering` | PhD Candidate | Relatable confusion, asks the questions readers are afraid to ask |

Each persona has a system prompt that shapes how they read and react to retrieved chunks. They cite specific papers and figures. They reply to each other. The feed feels like a real academic Twitter thread.

---

## Post Types

- **Post** — standalone take on a finding
- **Thread** — multi-part breakdown of a paper section (rendered as a thread with count)
- **Quote-tweet** — one persona reacts to another's post, with the original embedded
- **Reply** — direct reply to another persona, continuing a thread of argument
- **Figure post** — a persona cites a specific diagram/chart from a paper, rendered with inline image

---

## Tech Stack

### Frontend
- **React + Vite** (TypeScript)
- **TailwindCSS** for styling
- **Lucide React** for icons
- Deploy target: **Vercel**

### Backend
- **FastAPI** (Python 3.11+)
- REST/JSON API
- Handles: paper uploads, feed generation requests, user corpus management, auth

### Workers (Celery + Redis)
Two logical worker types, initially one container:

**Ingestion Worker** (triggered on paper upload):
1. Attempt text extraction via **Marker** (primary path) → structured markdown output
2. **Quality check** — scan extracted text for gibberish indicators: high symbol density, abnormal word length distribution, encoding artifacts, near-empty output. Academic PDFs frequently suffer from font encoding issues (custom font subsets that render extracted text as garbled symbols) or are scanned documents with no text layer at all.
3. If quality check fails → **fallback**: rasterize each page via PyMuPDF, pass page images to **Claude Vision API** page-by-page, reconstruct as markdown
4. Section-aware chunking from markdown output (abstract, intro, methods, findings, discussion — not sliding window)
5. Extract embedded figures/diagrams as images (PyMuPDF for bitmap-embedded images; note: figures rendered as PDF vector drawing commands require page rasterization — not extractable as standalone image files)
6. Send each figure image to **Claude Vision API** → generate description + claim mapping
7. Embed all chunks (text + figure descriptions) via **OpenAI text-embedding-3-small** or **Nomic embed**
8. Store chunks + embeddings + search_vector in Postgres/pgvector
9. Log extraction path per paper (marker_clean / vision_fallback) for debugging and quality monitoring

**Persona Worker** (triggered on feed generation request):
1. For each persona, retrieve top-k relevant chunks via cosine similarity
2. Cross-paper retrieval by default — chunks from all papers in corpus
3. **Contradiction detection step**: classify each retrieved chunk as `supports / contradicts / extends` the current claim before generating a reply
4. Call **Claude API (Sonnet)** with persona system prompt + retrieved chunks → structured JSON output
5. Interleave persona posts into feed timeline
6. Store generated feed in Postgres

### Database
- **PostgreSQL** with **pgvector** extension
- Single database for: papers, chunks, embeddings, users, feed history, bookmarks, figure metadata

### Queue
- **Redis** for job queue (via Celery)
- Paper upload → ingestion job queued → async processing → websocket/polling notifies frontend when ready
- Feed generation → persona job queued → async → feed delivered

### Auth
- **Clerk** (faster to ship) or **Lucia** (more control long term)
- TBD based on timeline

---

## Project Structure

```
ficino/
├── docker-compose.yml
├── .env.example
│
├── frontend/                          # React + Vite
│   ├── Dockerfile
│   ├── vite.config.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Feed/
│   │   │   │   ├── Feed.tsx           # Main feed scroll container
│   │   │   │   ├── PostCard.tsx       # Individual post renderer
│   │   │   │   ├── QuoteBlock.tsx     # Embedded quote-tweet
│   │   │   │   ├── FigureCard.tsx     # Inline figure/diagram post
│   │   │   │   └── ThreadPost.tsx     # Thread-style post
│   │   │   ├── Sidebar/
│   │   │   │   ├── CorpusPanel.tsx    # Active papers list
│   │   │   │   └── PersonaPanel.tsx   # Active personas list
│   │   │   ├── Upload/
│   │   │   │   └── PaperUpload.tsx    # PDF drag-drop upload
│   │   │   └── Nav/
│   │   │       └── LeftNav.tsx        # Icon navigation rail
│   │   ├── hooks/
│   │   │   ├── useFeed.ts             # Feed generation + polling
│   │   │   └── useCorpus.ts           # Corpus management
│   │   ├── lib/
│   │   │   └── api.ts                 # API client
│   │   └── types/
│   │       └── index.ts               # Shared types
│   └── public/
│
├── api/                               # FastAPI
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── main.py                        # FastAPI app entry
│   ├── routers/
│   │   ├── papers.py                  # Upload, list, delete papers
│   │   ├── feed.py                    # Generate feed, get feed history
│   │   └── users.py                   # User + corpus management
│   ├── models/
│   │   ├── paper.py                   # Paper, Chunk, Figure models
│   │   ├── feed.py                    # Post, Feed models
│   │   └── user.py                    # User, Corpus models
│   ├── services/
│   │   ├── ingestion.py               # PDF parsing orchestration
│   │   ├── retrieval.py               # pgvector RAG queries
│   │   ├── contradiction.py           # Claim classification
│   │   └── persona.py                 # Persona prompt construction
│   └── db/
│       ├── connection.py              # Postgres connection
│       └── migrations/                # SQL migrations
│
├── worker/                            # Celery workers
│   ├── Dockerfile
│   ├── requirements.txt               # Shared with api/ or separate
│   ├── celery_app.py                  # Celery config
│   ├── tasks/
│   │   ├── ingestion_tasks.py         # PDF → chunks → embeddings → pgvector
│   │   └── persona_tasks.py           # RAG → contradiction → Claude → feed JSON
│   └── lib/
│       ├── marker_extractor.py        # Marker primary extraction → markdown
│       ├── vision_extractor.py        # Claude Vision page-by-page fallback → markdown
│       ├── quality_check.py           # Gibberish detection, routes extraction path
│       ├── pdf_extractor.py           # PyMuPDF page rasterization + figure extraction
│       ├── figure_describer.py        # Claude Vision figure → description + claim mapping
│       ├── chunker.py                 # Section-aware chunking from markdown
│       ├── embedder.py                # Embedding generation (text-embedding-3-small)
│       └── claude_client.py           # Claude API wrapper
│
└── infra/
    ├── nginx.conf                     # Frontend reverse proxy config
    └── postgres/
        └── init.sql                   # pgvector + tsvector schema init (hybrid search)
```

---

## Docker Compose

```yaml
version: "3.9"

services:
  frontend:
    build: ./frontend
    ports:
      - "3000:80"
    depends_on:
      - api

  api:
    build: ./api
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://ficino:ficino@postgres:5432/ficino
      - REDIS_URL=redis://redis:6379
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - postgres
      - redis

  worker:
    build: ./worker
    environment:
      - DATABASE_URL=postgresql://ficino:ficino@postgres:5432/ficino
      - REDIS_URL=redis://redis:6379
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - postgres
      - redis

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_USER=ficino
      - POSTGRES_PASSWORD=ficino
      - POSTGRES_DB=ficino
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

---

## Key Design Decisions

**Why Marker for PDF extraction, not raw PyMuPDF?**
PyMuPDF extracts the raw text layer of a PDF, which is unreliable for academic papers. Two common failure modes: (1) font encoding issues — the PDF uses custom font subsets that make extracted text unreadable garbled symbols, not actual encryption; (2) scanned documents — no text layer exists at all, just page images. Marker re-renders the PDF visually and reconstructs structured markdown, handling two-column layouts, equations, tables, and figures correctly. NotebookLM uses the same general approach (page rasterization + OCR/vision reconstruction) which is why it handles difficult PDFs without issue. Marker is the open source equivalent. Claude Vision page-by-page is the fallback for papers Marker cannot handle cleanly.

**Why section-aware chunking, not sliding window?**
A methods section chunk retrieved alongside a findings chunk creates confused personas. Section-aware chunking means personas can be prompted to focus on specific claim types — methodology critiques come from methods chunks, hype posts come from findings chunks.

**Why contradiction detection as a separate step?**
Without it, cross-paper retrieval just produces agreement. The contradiction step is what makes the discourse feel real — a persona only fires a reply if the retrieved chunk actually pushes back on the current claim.

**Why pgvector with hybrid search, not Pinecone or Weaviate?**

Three options were evaluated:

- **Pinecone** — managed, fast, scales to billions of vectors. Rejected because metadata lives separately from relational data, requiring joins across two systems. Overkill for current scale and adds cost and operational surface.
- **Weaviate** — open source, self-hostable, has native hybrid search (vector + BM25). Genuinely compelling for academic text retrieval. Rejected at this stage because its GraphQL query model is a context-switch from SQL, schema definition is more rigid upfront, and debugging retrieval failures is harder. Revisit if retrieval quality degrades at scale or if a "search your corpus" feature becomes a priority.
- **pgvector with hybrid search** — chosen. Keeps everything in one database, one backup strategy, one query language. Hybrid search is implemented using PostgreSQL's native `tsvector` column alongside the embedding column, blending vector similarity with BM25 keyword matching.

**The math:** 100 papers × 40 chunks = ~4,000 vectors. pgvector handles this trivially. Revisit Weaviate at 500k+ vectors or if hybrid search quality proves insufficient for complex corpus retrieval.

**Hybrid search query pattern (implemented in `retrieval.py`):**

```sql
SELECT *,
  (1 - (embedding <=> query_embedding)) * 0.7 +
  ts_rank(search_vector, plainto_tsquery('english', query_text)) * 0.3 AS score
FROM chunks
WHERE search_vector @@ plainto_tsquery('english', query_text)
   OR (embedding <=> query_embedding) < 0.4
ORDER BY score DESC
LIMIT 20;
```

Author names, paper titles, and specific technical terms hit via BM25. Semantic similarity handles conceptual retrieval. Both paths run in a single query — no join across systems.

**Why figures matter?**
Most academic discourse happens around figures and tables, not prose. "Look at Figure 3" is a real argumentative move. Extracting and describing figures as first-class chunks means personas can make this move authentically, and the feed can render the actual diagram inline — a feature no existing tool offers.

---

## Known Problem Areas & Mitigations

**PDF extraction reliability**
Academic PDFs are notoriously inconsistent. Two common failure modes:
- **Font encoding issues** — custom font subsets make raw text extraction unreadable garbled symbols (not encryption, just bad PDF construction from certain publishers, especially Elsevier)
- **Scanned documents** — no text layer at all, just page images

Mitigation: Marker primary path → quality check → Claude Vision fallback. Log extraction path per paper. Test on 10+ real papers from your target corpus before building the chunking pipeline.

**Figure extraction gaps**
Figures embedded as vector graphics (PDF drawing commands) cannot be extracted as standalone image files by PyMuPDF. Only bitmap-embedded figures extract cleanly. Mitigation: rasterize full pages for any page where a figure is detected but no bitmap image was extracted, then crop and pass to Claude Vision.

**Section detection failure**
Marker handles most papers cleanly but will occasionally fail to detect section boundaries in unusual layouts (some conference proceedings, older papers, non-standard templates). Mitigation: implement a fallback chunking strategy that splits by token count when section detection produces fewer than 3 sections.

**Persona prompt fragility**
Feed quality lives entirely in the persona system prompts. Prompts must be versioned and stored in the database — not hardcoded in the worker — so they can be iterated without redeployment.

**Contradiction detection silent failure**
If the LLM classifies all retrieved chunks as "extends" rather than "contradicts," cross-paper discourse becomes agreement. Requires an eval set of known chunk pairs before shipping.

**Feed generation cost**
Multiple Claude API calls per generation. Implement per-user rate limits from day one.

---

## MVP Scope (Build Order)

1. Docker Compose scaffold — all five containers running
2. PDF upload → PyMuPDF text extraction → section chunking → pgvector storage
3. Single paper → persona generation → feed render (no cross-paper yet)
4. Figure extraction → Claude Vision description → figure chunks indexed
5. Cross-paper retrieval → contradiction detection → persona replies across papers
6. Figure posts rendered inline in feed
7. Auth + user corpus management
8. Feed history + bookmarks
9. Public launch
