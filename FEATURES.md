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

### Ask Your Corpus
| Feature | Description |
|---------|-------------|
| **User posts** | Compose box at the top of the feed. Type a question or thought — it appears in the timeline like any persona post |
| **The Archivist** | A neutral 6th persona (`@the_archivist`) that responds to user posts with RAG-grounded answers. Hybrid retrieval (top 15 chunks), citation-rich, no persona voice — just accurate synthesis |
| **User profile** | Click your avatar to view all your posts and Archivist replies. Configurable display name and handle in Settings |
| **Source transparency** | Every Archivist reply includes expandable source chunks with relevance scores, just like persona posts |

### Interaction
| Feature | Description |
|---------|-------------|
| **Reply to personas** | Multi-turn threaded conversations on any post. Persona responds grounded in the same paper chunks. Optimistic send, typing indicator with persona avatar |
| **@Mention personas** | Type `@` in a reply → autocomplete dropdown with avatars. Tagged persona responds in character after the main persona's reply. Multiple mentions supported |
| **Conductor mode (↻)** | Retweet button repurposed as persona router. Click ↻ on any post or reply message → pick a persona → they respond to that specific message. Orchestrate debates between personas without typing |
| **Post detail view** | Click any post → full conversation context with parent posts, quoted originals, and downstream responses. Back button preserves scroll position |
| **Annotations** | Private notes on any post via three-dots menu. Gold left-border display, inline editor with Ctrl+Enter save. Visible in feed, post detail, and bookmarks |
| **Cite this** | One-click APA or MLA citation generation from the three-dots menu, copied to clipboard. Looks up full paper metadata from the DB |
| **Copy text** | Copy post content (or full thread) to clipboard |
| **Bookmarks** | Snapshot-based, survives feed regeneration |
| **Reply tracking** | REPLIED badge on posts with conversations. "Threads" tab in Messages inbox for finding all your persona conversations |
| **Reply actions** | Like and bookmark individual reply messages with full persistence. Hearts and bookmarks on reply messages survive page reloads. Liked replies feed into the preference aggregation system |
| **Regenerate post** | Three-dots menu → Regenerate. Reruns a single post with the same persona and post type but fresh chunks. Worker task patches the feed JSONB in place |
| **Hide persona** | Three-dots menu → Hide. One-click disable of a persona from future feed generations. Calls settings API to toggle persona off |
| **Debug view** | Three-dots menu → Debug view (dev only, hidden in production). Shows post metadata (persona, type, category, feed_id, post_index) and full retrieved chunk details with relevance scores |

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

### Like as Training Signal (RLHF-lite)
| Feature | Description |
|---------|-------------|
| **Persistent likes** | Heart clicks stored in `user_likes` table with full context: persona, post type, category, feed, timestamp. Hearts persist across page reloads. Synthetic engagement counts preserved for social proof |
| **Preference aggregation** | After 5+ likes, computes per-persona hit rate, per-post-type affinity, and per-category weighting. Annotated likes (like + note) weighted 2x as stronger learning signal. Stored in `user_settings.preferences`, recomputed after every feed generation |
| **Adaptive feed generation** | Learned preferences blended with manual settings at 40/60 ratio. Liked personas get more posts, preferred post types weighted higher. Retrieval boosts chunks from papers user has liked posts about (1.25x score). Design principle: optimize for *learning*, not engagement |

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

### Tab-Specific Feed Generation
| Feature | Description |
|---------|-------------|
| **Tab-focused generation** | Generating from Debates/Methods/Findings tabs produces tab-specific posts instead of balanced. Debates: 80% quotes+replies, all personas. Methods: skeptic+methodologist, 75% posts+threads. Findings: hype+practitioner, 25% figure posts |
| **Additive** | Tab-specific posts append to the feed — For You always shows everything unchanged |

### Reading Lists
| Feature | Description |
|---------|-------------|
| **AI-ordered syllabi** | Create a reading list from workspace papers. The Archivist analyzes citation chains, conceptual dependencies, and publication dates to propose an optimal reading order with per-paper rationale |
| **Interactive reordering** | AI proposes order, you adjust. Drag papers up/down to customize the sequence |
| **Progressive chapters** | Each paper is a chapter. Generate chapters sequentially — Chapter 1 sees only Paper 1, Chapter 2 sees Papers 1-2. Personas in later chapters reference earlier papers, building cumulative discourse |
| **Unlock progression** | Completing a chapter unlocks the next. Locked chapters shown but grayed out. Read completed chapters anytime |

### Authentication
| Feature | Description |
|---------|-------------|
| **Pluggable providers** | `AUTH_PROVIDER` env var selects auth mode: `none` (no login, self-hosted default), `basic` (email/password), `supabase` (JWT for production). Switch with one env change, no code changes |
| **Basic auth** | bcrypt password hashing, Redis session storage (7-day sliding TTL), HTTP-only cookies. First user registration auto-allowed, subsequent controlled by `ALLOW_REGISTRATION` |
| **Supabase auth** | JWT verification via `SUPABASE_JWT_SECRET`. Users auto-created in local DB on first login. Frontend uses `@supabase/supabase-js` for auth flows |
| **Auth abstraction** | Single `get_current_user` FastAPI dependency replaces all user identity logic. Routes never know which provider is active. Frontend discovers provider via `GET /auth/provider` |

### PWA + Offline Mode
| Feature | Description |
|---------|-------------|
| **Installable PWA** | Web app manifest with icons (192/512/maskable), standalone display mode. "Add to Home Screen" on iOS/Android — no App Store needed |
| **Service worker** | Vite PWA plugin (Workbox). Precaches all static assets (JS, CSS, HTML, persona avatars). Runtime caching: CacheFirst for figure images and Google Fonts, StaleWhileRevalidate for font stylesheets. Auto-updates on new deployments |
| **Install prompt** | Download button in desktop left nav. Dismissible banner on mobile with iOS "Add to Home Screen" instructions |
| **IndexedDB cache** | 13-store typed schema (feeds, papers, bookmarks, annotations, likes, personas, workspaces, settings, userPosts, alerts, paperSummaries, groupChats, syncMeta). All hooks write through to IndexedDB on network success, fall back to cache when offline |
| **Offline reading** | Full read-only access to cached feeds, papers, bookmarks, annotations, likes, and settings when offline. Offline banner auto-appears. Generate button and uploads disabled |
| **Download workspace** | One-click download of an entire workspace: feeds, papers, bookmarks, annotations, likes, paper summaries, figure images. Progress modal with cancel support. Sync timestamp tracked per workspace |
| **Offline & Storage settings** | Settings section showing cache size, per-workspace sync status, download/sync buttons, and clear offline data |
| **Sync indicator** | "Synced Xm/Xh ago" in feed header metadata line. Amber warning when stale (>24h) |

---

## Next Up

Features that are designed and ready to build.

### Custom Personas

User-created personas with custom name, handle, color, system prompt, and retrieval query. The DB refactor makes this trivial — it's one INSERT to the `personas` table. Needs a frontend form in Settings.

---

## Distribution Model

Ficino ships as a **self-hosted Docker Compose project** — the same model as Ollama, Immich, or Paperless-ngx.

- No SaaS. No managing other people's data. No billing infrastructure.
- Users run it on their own laptop, home server, or university VM
- The PWA gives mobile access to their own instance
- `git clone && docker compose up` is the install
- AGPL license: self-host freely, cloud providers must open-source changes

---

## Future

Larger features that need more design work.

### Export Feed

Start with **markdown export** — one click, downloads a `.md` file:

- Feed metadata header (workspace, generation date, papers included)
- Each post formatted with persona name, handle, content, paper reference
- Bookmarked posts highlighted/marked
- User annotations included inline below their posts
- Sources as footnotes at the bottom (paper title, section, relevance score)
- Reading list chapter exports include chapter number and cumulative paper context

This is the 80/20 — gets content out in a format that works everywhere (Obsidian, Notion, Google Docs, plain text editors). PDF and shareable link versions can layer on top later, but the use case should drive which comes next: "share with advisor" → PDF, "collaborate with lab" → shareable link, "pull into my writing" → markdown is already enough.

### Citation Graph

Visual map of how papers in your corpus cite each other. Surfaces structural relationships that text-based feeds can't show.


---

## Production

Required for ficino.ai public deployment.

| Item | Status |
|------|--------|
| Auth & user management | **Shipped** — pluggable AUTH_PROVIDER (none/basic/supabase) |
| Rate limiting & cost controls | **Shipped** — Redis-based per-user rate limits on uploads (50/day), feed generation (20/day), user posts (30/day). Configurable via env. Skipped for AUTH_PROVIDER=none |
| Retrieval debug view (dev only) | **Shipped** — three-dots menu → Debug view (dev builds only) |
| Logging & error tracking | Deferred — structlog in place for container logs. Will pick a service (Sentry, Betterstack, or Supabase logs) when ficino.ai hosting stack is finalized |
| Connection pooling optimization | **Shipped** — Worker uses persistent asyncpg pool (min 2, max 10) with shared event loop. API pool unchanged (min 5, max 20). Eliminates per-query connection churn |
| Security headers & CORS lockdown | **Shipped** — X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS + CSP in production, CORS locked to specific origins |
