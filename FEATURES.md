# Ficino — Product Roadmap

---

## Shipped

Everything below is live in production.

### Core Platform
| Feature | Description |
|---------|-------------|
| **Paper ingestion** | Upload PDFs → text extraction (Marker/PyMuPDF/vision fallback) → quality check → section-aware chunking → embedding → pgvector storage |
| **Feed generation** | Five AI personas retrieve relevant chunks via hybrid search and generate a Twitter/X-style discourse feed with posts, threads, quotes, replies, and figure analysis |
| **Append mode** | "Generate more posts" adds to the current feed. New posts can quote/reply to existing ones. Feed ID preserved for bookmarks and annotations |
| **Feed history** | Browse and reload past feed generations per workspace |
| **Auto-generate** | Optionally trigger feed generation automatically when a paper finishes ingestion (configurable in Settings) |

### Personas
| Feature | Description |
|---------|-------------|
| **Research-grounded prompts** | Five personas with detailed system prompts engineered from research on science communication, the replication crisis, and academic social media discourse. Each persona has specific "moves," voice rules, interaction rules, and post-type behaviors |
| **DB-stored personas** | All persona data (metadata, prompts, retrieval queries, avatars, bios) lives in a single `personas` table. Adding a persona is one INSERT, zero code changes |
| **Persona profiles** | Click any persona name → Twitter-style profile with Midjourney avatar, AI-generated bio, post history from current feed, and stats |
| **Persona DMs** | Message any persona directly. They respond in character, grounded in your corpus via RAG. Conversations persist across sessions |
| **Organic interjections** | After 2+ user replies in a thread, another persona may jump in (~70% chance) if the conversation topic overlaps their expertise. Selective, opinionated, and unprompted |

### Paper Intelligence
| Feature | Description |
|---------|-------------|
| **Paper summaries** | Click a paper in Messages → structured chat-style summary (TL;DR, methods, findings, limitations). Generated once, cached. Generation survives navigation and page refresh |
| **Group chats** | Select multiple papers for cross-corpus synthesis — agreements, contradictions, gaps presented as a conversation between papers |
| **"What's happening" panel** | Corpus sidebar redesigned as a content discovery module. Papers shown as headlines with TL;DR teasers. Click to expand for details or navigate to summary. Also appears at the top of Explore on mobile |
| **Auto-tagging** | Papers automatically receive 2-3 topic tags during ingestion (piggybacks on the metadata extraction LLM call) |
| **Metadata extraction** | Title, authors, year, DOI auto-detected from PDF content |

### Interaction
| Feature | Description |
|---------|-------------|
| **Reply to personas** | Multi-turn threaded conversations on any post. Persona responds grounded in the same paper chunks |
| **Post detail view** | Click any post → full conversation context with parent posts, quoted originals, and downstream responses. Back button preserves scroll position |
| **Annotations** | Private notes on any post via three-dots menu. Gold left-border display, inline editor with Ctrl+Enter save. Visible in feed, post detail, and bookmarks |
| **Cite this** | One-click APA or MLA citation generation from the three-dots menu, copied to clipboard. Looks up full paper metadata from the DB |
| **Copy text** | Copy post content (or full thread) to clipboard |
| **Bookmarks** | Snapshot-based, survives feed regeneration |
| **Reply tracking** | REPLIED badge on posts with conversations. "Threads" tab in Messages inbox for finding all your persona conversations |

### Alerts
| Feature | Description |
|---------|-------------|
| **Contradiction alerts** | Triggered when a new paper contradicts findings in an existing corpus paper |
| **Disagreement spikes** | Flagged when feed generation produces unusual debate volume |
| **Reading gap nudges** | Prompted when you've debated a paper in feeds but never read its summary |
| **Stale corpus** | Nudges for papers sitting without generating any discourse |

### Organization
| Feature | Description |
|---------|-------------|
| **Workspaces** | Named research contexts (dissertation, conference paper, grant proposal). Everything scopes to the active workspace — papers, feeds, summaries, tags |
| **Tags** | Hashtag-style paper tagging with corpus-scoped feed generation. Manual + auto-generated |
| **Search** | Full-text search across all chunks, papers, and generated posts with result grouping |

### Configuration & Display
| Feature | Description |
|---------|-------------|
| **Light/dark mode** | Instant theme switching via CSS custom properties. Warm white light palette with adjusted gold accent |
| **Font size** | Small, normal, large — applies via root font-size |
| **Post spacing** | Compact, comfortable — adjusts article padding |
| **LLM provider** | Toggle between Ollama (local, free) and Claude/OpenAI APIs |
| **Model selection** | Pick from installed Ollama models via dropdown |
| **Persona controls** | Enable/disable personas, adjust temperature, tune post type weights |
| **Paper processing** | Extraction mode (auto/PyMuPDF/vision), chunk size |

---

## Next Up

Features that are designed and ready to build.

### Like as Training Signal (RLHF-lite)

Your likes become implicit feedback that shapes future feed generation. Three phases:

**Phase 1 — Real Likes** *(quick)*
- `user_likes` table with full context: persona, post type, feed, timestamp
- Swap synthetic counters for a real persisted toggle
- Like data stored for later analysis

**Phase 2 — Preference Aggregation**
- Compute preference signals after N likes accumulate:
  - Per-persona hit rate ("you like 80% of stats_nerd but only 30% of hype")
  - Per-post-type affinity ("threads liked 3x more than standalone posts")
  - Per-category weighting ("methods > findings")
- Weight annotated likes higher — a liked post with a note is a stronger learning signal
- Store as preferences profile in `user_settings`

**Phase 3 — Feedback Loop**
- Feed preference data into `plan_feed_posts()` custom weights
- Liked personas get more posts in future generations
- Boost retrieval for chunks similar to liked posts' sources
- Design principle: optimize for *learning*, not engagement

### Ask Your Corpus (Conversational RAG)

Type a question in the DM view → RAG retrieval → direct answer with citations. Like DMing a research assistant who's read all your papers. Could support follow-up questions. Persona DMs are halfway there — this extends it beyond a single persona's lens.

### Custom Personas

User-created personas with custom name, handle, color, system prompt, and retrieval query. The DB refactor makes this trivial — it's one INSERT to the `personas` table. Needs a frontend form in Settings.

### Post Actions Menu (remaining)

The three-dots menu has Copy text, Cite (APA/MLA), and annotations. Still to add:
- **Regenerate**: rerun a single post with the same persona and chunks
- **Hide persona**: quick toggle to disable a persona (links to Settings)
- **Debug view**: show the full prompt + retrieved chunks that generated the post (dev only)

---

## Future

Larger features that need more design work.

### Tab-Specific Feed Generation

Each tab (For You / Debates / Methods / Findings) triggers its own generation with different persona weights and section focus, instead of client-side filtering. 4x the LLM calls — expensive with API providers, fine with Ollama.

### Export Feed

Share a generated feed as a link or export as PDF/markdown. Bridges the gap between scrolling the feed and writing your dissertation.

### Citation Graph

Visual map of how papers in your corpus cite each other. Surfaces structural relationships that text-based feeds can't show.

### Reading Lists

Curated sequences of papers with guided discourse. A structured path through a topic rather than a single feed.

---

## Production

Required for ficino.ai public deployment.

| Item | Status |
|------|--------|
| Auth & user management (Clerk) | Not started |
| Rate limiting & cost controls | Not started |
| Retrieval debug view (dev only) | Not started |
| Logging & error tracking (Sentry) | Not started |
| Connection pooling optimization | Not started |
| Security headers & CORS lockdown | Not started |
