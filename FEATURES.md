# Ficino — Product Roadmap

Ficino ships to **two deploy targets from a single codebase**:

- **Self-host** via `docker compose up` — runs on a laptop, home server, or
  university VM. Defaults lean on Ollama for free local inference. The
  PWA gives mobile access to the user's own instance. No account, no
  SaaS billing, AGPL license.
- **SaaS** at **[ficino.app](https://ficino.app)** — hosted on Railway
  (api, worker, frontend, Redis) backed by Supabase (Postgres + pgvector,
  Auth, object storage). Anthropic Claude + Voyage embeddings behind the
  scenes. Cloudflare Turnstile on every auth surface. Invite-only in
  beta. See `docs/saas-deploy.md` for the operator runbook.

Self-host is unchanged by the SaaS deploy. Every change gates the
SaaS-specific behaviour behind an env flag (`PUBLIC_DEPLOYMENT`,
`STORAGE_PROVIDER`, `AUTH_PROVIDER`).

---

## Shipped

Everything below is live in production.

### Core Platform
| Feature | Description |
|---------|-------------|
| **Paper ingestion** | Upload PDFs → text extraction (Marker/PyMuPDF/vision fallback) → quality check → section-aware chunking → contextual prefixing → embedding → pgvector storage |
| **Feed generation** | Six AI personas retrieve relevant chunks via hybrid search and generate a Twitter/X-style discourse feed with posts, threads, quotes, replies, and figure analysis. A seventh reply-only persona (The Archivist) is gated out of feed authoring via a `feed_eligible` flag |
| **Append mode** | "Generate more posts" adds to the current feed. New posts can quote/reply to existing ones. Feed ID preserved for bookmarks and annotations |
| **Feed history** | Browse and reload past feed generations per workspace |
| **Auto-generate** | Optionally trigger feed generation automatically when a paper finishes ingestion (configurable in Settings) |

### Personas
| Feature | Description |
|---------|-------------|
| **Research-grounded prompts** | Five personas with detailed system prompts engineered from research on science communication, the replication crisis, and academic social media discourse. Each persona has specific "moves," voice rules, interaction rules, and post-type behaviors |
| **DB-stored personas** | All persona data (metadata, prompts, retrieval queries, avatars, bios) lives in a single `personas` table. Adding a persona is one INSERT, zero code changes |
| **Persona profiles** | Click any persona name → Twitter-style profile with Midjourney avatar, AI-generated bio, and three tabs: **Posts** (this persona's top-level feed posts), **Replies** (every interjection this persona made into other threads, with full parent-post context), **Messages** (private DM conversation). The Archivist is a special case — it's reply-only (never publishes to feeds), so its profile swaps "Posts" for a **Corpus Q&A** tab that lists the user's Ask-Your-Corpus conversations, hides the Replies tab, and suppresses the "Get their take" button |
| **Opt-out persona enablement** | Every DB persona with `feed_eligible=true` is enabled by default; the user opts out via `personas_enabled[key]=false` in settings. Personas added via migration appear in every user's feed automatically with no seed-data update required |
| **Persona DMs** | Message any persona directly. They respond in character, grounded in your corpus via RAG. Conversations persist across sessions |
| **Organic interjections** | After 2+ user replies in a thread, another persona may jump in (~70% chance) if the conversation topic overlaps their expertise. Selective, opinionated, and unprompted |

### Retrieval Quality
| Feature | Description |
|---------|-------------|
| **Hybrid search** | Two-stage: HNSW vector nearest-neighbor prunes to a candidate pool, then a weighted (0.7 vector + 0.3 BM25) re-ranker produces the final top-k. See [architecture/hybrid-search](https://docs.ficino.ai/architecture/hybrid-search) |
| **Cross-encoder reranker** | Optional stage-3 reranker over the hybrid candidate pool. Providers: `local` (BGE-reranker-v2-m3), `voyage` (rerank-2-lite/rerank-2), `cohere` (rerank-v3.5), or `none` to disable. Provider abstraction mirrors the embedder pattern; degrades gracefully to hybrid-only on rerank failure |
| **Contextual retrieval** | Anthropic-style per-chunk contextual prefix generated at ingest time and prepended before embedding. Providers: `anthropic` (Claude Haiku with ephemeral prompt caching — the paper is cached once, per-chunk calls are cents), `ollama` (local qwen3.5 fallback), or `none`. Prefix persisted on `chunks.contextual_prefix` so re-embedding doesn't require a second LLM pass |
| **Persona-tuned retrieval** | Each persona has its own retrieval query emphasizing the sections it cares about (methodology for Skeptic, findings for Hype, etc.), stored on the personas table and hot-editable |

### Figure Pipeline (VLM-based)
| Feature | Description |
|---------|-------------|
| **Scientific-figure detection** | Each PDF page is rendered and handed to Claude Sonnet vision (or a local VLM) with a structured prompt that returns a typed list of scientific figures. Non-scientific bitmaps (UI glyphs, publisher logos, running-header icons, decorative marks) are silently filtered at detection time — they never reach storage |
| **Typed figures** | Every figure has a `figure_type` enum (chart_bar, chart_line, chart_scatter, diagram, schematic, flowchart, algorithm, photograph, map, micrograph, anatomical, table_image, other), caption text, figure_number ("5", "5a", "S3"), a data_claim ("what the paper uses this figure to show"), and the first referenced paragraph. Plus bbox + detector confidence |
| **Persona-typed figure routing** | Every persona declares `allowed_figure_types` on its row. Figure-post slots only pick from the intersection of (paper's figures) × (persona's allowed types) — so Methods Skeptic never gets a UI icon to critique and the Hype persona never tries statistics on a photograph. Personas with no eligible figure on the paper skip the slot rather than force-fit |
| **Grounded figure prompts** | Persona figure-post prompts receive the caption, figure_number, data_claim, and referenced paragraph as fenced grounding context. Posts are evaluated against what the paper says the figure shows, not a blind vision description |

### Paper Intelligence
| Feature | Description |
|---------|-------------|
| **Paper summaries** | Click a paper in Messages → structured chat-style summary (TL;DR, methods, findings, limitations). Generated once, cached. Generation survives navigation and page refresh |
| **Group chats** | Select multiple papers for cross-corpus synthesis — agreements, contradictions, gaps presented as a conversation between papers. Creatable from the Messages inbox ("New Group Chat") |
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
| **Per-reply three-dots menu** | Each reply/interjection message has its own ⋯ menu (Copy text, Delete message). Delete removes a single message atomically via JSONB array-element removal; the rest of the thread survives |
| **Nested quote cards** | Quote-tweet posts render the quoted persona as a Twitter-style nested card inside the quoter's post — avatar + name + @handle on the first line, content below, clickable to the quoted persona's profile |
| **Threaded reply rail** | Profile Replies tab renders parent + interjection through the shared PostCard component, connected by a vertical rail inside the avatar column — matches Twitter's profile Replies layout rather than a one-off card shape |
| **Regenerate post** | Three-dots menu → Regenerate. Reruns a single post with the same persona and post type but fresh chunks. Worker task patches the feed JSONB in place |
| **Hide persona** | Three-dots menu → Hide. One-click disable of a persona from future feed generations. Calls settings API to toggle persona off |
| **Debug view** | Three-dots menu → Debug view (dev only, hidden in production). Shows post metadata (persona, type, category, feed_id, post_index) and full retrieved chunk details with relevance scores |

### Alerts
| Feature | Description |
|---------|-------------|
| **Contradiction alerts** | Triggered when a new paper contradicts findings in an existing corpus paper |
| **Disagreement spikes** | Flagged when feed generation produces unusual debate volume |
| **Reading gap nudges** | Prompted when you've debated a paper in feeds but never read its summary |
| **Stale corpus** | Nudges for papers sitting without generating any discourse. Checked daily via a scheduled Celery beat task (03:00 UTC) |

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

### Data Management (Danger Zone)
| Feature | Description |
|---------|-------------|
| **Clear All Feeds** | Delete every generated feed for the user. Bookmarks and annotations survive (they're snapshot-based) |
| **Clear All Summaries** | Delete every paper summary — they regenerate on next view |
| **Clear All Conversations** | Delete every user post and every Archivist reply attached to it. Broadcasts an event so mounted views reset without a hard reload |
| **Delete All Papers** | Cascade-delete every paper, its chunks, figures, summaries, and feeds. Cleans up PDFs and figure crops on disk. Workspaces and settings are kept |
| **Delete Everything** | Nuclear reset — everything above PLUS notifications/alerts, persona DMs, corpus syntheses, and reading lists, in one transaction. Workspaces and account settings are kept. Each content hook (useCorpus, useFeed, useUserPosts, useAlerts) listens for the clear event and resets instantly |

### Post-Generation Quality Gate
| Feature | Description |
|---------|-------------|
| **Hard-fail on unparseable output** | `_parse_post_json` and `validate_post_shape` raise on empty or excessively-long LLM output instead of persisting `[generation produced no text]` placeholder strings. The feed-generation loop catches the raise and drops the slot — a research feed never ships apology text as a "post" |

### Configuration & Display
| Feature | Description |
|---------|-------------|
| **Light/dark mode** | Instant theme switching via CSS custom properties. Warm white light palette with adjusted gold accent |
| **Font size** | Small, normal, large — applies via root font-size |
| **Post spacing** | Compact, comfortable — adjusts article padding |
| **LLM provider** | Toggle between Ollama (local, free) and Claude/OpenAI APIs. **SaaS users can't change this** — `PUBLIC_DEPLOYMENT=true` swaps the provider controls for a "Managed by Ficino" panel and the settings-update endpoint silently drops any provider-override write. Operator env (Railway variables) is the single source of truth on hosted deploys |
| **Model selection** | Pick from installed Ollama models via dropdown (self-host only) |
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

### Listen Mode (Audio)
| Feature | Description |
|---------|-------------|
| **Feed audio** | On-demand ElevenLabs TTS renders each non-deleted post as its own mp3 using the persona's dedicated voice (turbo v2.5 model). Claim-then-render Celery task keyed on `feeds.audio_status` so two click-happy users can't trigger duplicate spend. Per-post `audio_key` persisted into `posts[*]` JSONB; signed URLs hydrated at GET time with a 24h TTL |
| **Podcast mode** | NotebookLM-style two-host dialogue episode grounded in the same retrieved chunks the feed uses. Producer pulls ~30 chunks via the existing hybrid pipeline across every `posts[*].sources[*].paper_id`, scripts 8–12 turns of natural dialogue (short reactions, variable lengths, audio tags like `[laughs]` / `[sighs]`), then renders the whole thing as ONE continuous mp3 via ElevenLabs `/v1/text-to-dialogue` (Eleven v3 Dialogue Mode). Cross-speaker prosody and interruptions come from the model — no stitched clips |
| **Persona voices** | Seven preset ElevenLabs first-gen voices mapped 1:1 to personas by gender, tone, and age (Paul=warm mature male for Practitioner, George=British narrator for AI Breakthroughs, etc.). Two additional host voices (Drew + Tyler) reserved for podcast mode. Voice map is code-level, not user-editable — a persona's voice is part of its identity |
| **Fallback script** | If the LLM call or JSON parse fails, the producer emits a deterministic host_a/host_b script derived from feed stats + the first chunk per paper. User always gets a playable episode rather than a dead play button |
| **Scrolling transcript** | Podcast mode renders every turn as a two-color transcript (Host A gold, Host B teal) alongside the single continuous audio element. No per-turn seeking — v3 doesn't return alignments; the unified audio file is the feature |
| **Lazy + idempotent** | Audio synthesis is gated behind the user pressing Play. `audio_status` / `podcast_status` columns track `generating | ready | failed`; hitting Play again on a ready feed returns the cached episode. Generation failures flip to `failed` and surface a Try-again button |
| **Env-only configuration** | Requires `ELEVENLABS_API_KEY`. `ELEVENLABS_MODEL_ID` drives per-post TTS (default `eleven_turbo_v2_5`); `ELEVENLABS_DIALOGUE_MODEL_ID` drives podcast mode (default `eleven_v3`). Endpoints return 501 when the key is unset so the frontend hides the UI cleanly |

### Authentication
| Feature | Description |
|---------|-------------|
| **Pluggable providers** | `AUTH_PROVIDER` env var selects auth mode: `none` (no login, self-hosted default), `basic` (email/password), `supabase` (JWT for production). Switch with one env change, no code changes |
| **Basic auth** | bcrypt password hashing, Redis session storage (7-day sliding TTL), HTTP-only cookies. First user registration auto-allowed, subsequent controlled by `ALLOW_REGISTRATION` |
| **Supabase auth** | JWT verification via JWKS endpoint (supports ES256/RS256 asymmetric keys as well as legacy HS256 HMAC). Users auto-created in local DB on first login; a Default workspace is seeded alongside so the app has somewhere to put their first paper. Frontend uses `@supabase/supabase-js` for auth flows |
| **Cloudflare Turnstile captcha** | On Supabase deploys, every authenticator call (sign-in, sign-up, password reset, OTP verify) routes a Turnstile token through `options.captchaToken`. Site key in `VITE_TURNSTILE_SITE_KEY`, secret in the Supabase dashboard. Self-host leaves the site key unset → widget silently no-ops |
| **OTP-code password recovery** | Reset password email includes `{{ .Token }}` so the user can type the code into an in-app form instead of clicking a link. Defends against corporate link scanners (Microsoft ATP Safe Links, Google pre-fetch) that burn single-use reset tokens before the recipient can click. Flow: "Forgot password?" → email lands with code → Login page `verify-code` mode takes email + code + new password → `verifyOtp({type:'recovery'})` then `updateUser({password})` |
| **Admin-set password override** | Operator script at `/tmp/set-my-password.sh` hits Supabase's admin API to rewrite a user's password directly — bypasses email entirely when corporate scanners break the normal flow |
| **Sign out** | Settings → Account → Session panel. Shows the signed-in email + a Sign Out button; also clears per-browser IndexedDB so the next user on the device doesn't see a previous session's cached data |
| **Auth abstraction** | Single `get_current_user` FastAPI dependency replaces all user identity logic. Routes never know which provider is active. Frontend discovers provider + deploy mode via `GET /auth/provider` |
| **CSRF posture** | Double-submit cookie under `none` / `basic` providers. Skipped entirely under `supabase` — the Authorization-header-bearer flow is structurally immune to CSRF (no auto-attached credential a cross-origin page could exploit) |

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

### Mobile
| Feature | Description |
|---------|-------------|
| **Responsive primitives** | Dropdown / context-menu widths clamp to `max-w-[calc(100vw-2rem)]` so PostCard menus never overflow a 390px phone. Every icon-only button has ≥44×44 px hit region (WCAG 2.5.5). `env(safe-area-inset-*)` padding on the bottom nav + sticky headers so the iPhone home indicator and notch stop clipping content. Global `-webkit-tap-highlight-color: transparent` + touch-callout disabled on chrome, preserved on prose so quotes still copy |
| **Edge swipe-back** | Right-drag from the left edge of any detail view (post, persona profile, user profile, reading list chapter) triggers back navigation. Matches iOS native muscle memory. Mounted as an invisible 20 px strip that's axis-locked to ignore vertical scroll |
| **Swipeable feed tabs** | Horizontal drag across the feed advances/retreats between For You / Debates / Methods / Findings. Commits at 80 px + 0.2 velocity. Additive — tabs remain tappable |
| **Pull-to-refresh** | Pull the feed down at `scrollY=0` → gold spinner rotates with pull progress, fires a feed reload on release past threshold. Rubber-band beyond threshold for natural feel |
| **Swipe-to-act on cards** | Swipe-left on any PostCard reveals a Like gutter; swipe-right reveals a Reply gutter. Commits at 80 px, haptic on commit. Axis-locked with an 8 px dead-zone so vertical scroll wins when the user's first motion is downward. Disabled while a menu, reply textarea, or zap panel is open |
| **Keyboard-aware inputs** | `window.visualViewport` listener scrolls the focused input into view when the on-screen keyboard opens. Wired into ComposeBox (Ask-Your-Corpus) and LoginPage |
| **Haptic feedback** | `navigator.vibrate(10)` on like, bookmark, and swipe commits. Graceful no-op on iOS Safari (no Vibration API) |
| **Gesture library** | `@use-gesture/react` (~15 KB gz) for useDrag primitives; axis-locking, tap filtering, and velocity are standardized in one place |

---

## Next Up

Features that are designed and ready to build.

### Custom Personas

User-created personas with custom name, handle, color, system prompt, and retrieval query. The DB refactor makes this trivial — it's one INSERT to the `personas` table. Needs a frontend form in Settings.

---

## Distribution Model

Ficino ships to **two deploy targets from a single codebase**:

**Self-host** — same model as Ollama / Immich / Paperless-ngx.
- `git clone && docker compose up` is the install
- Runs on a laptop, home server, or university VM
- Defaults to Ollama for free local inference (`AUTH_PROVIDER=none`, `STORAGE_PROVIDER=local`)
- The PWA gives mobile access to the user's own instance
- Users bring (or omit) their own API keys for Claude / Voyage / etc. via the Settings → AI panel
- AGPL license: self-host freely, cloud providers must open-source their changes

**SaaS** — hosted at [ficino.app](https://ficino.app).
- Railway (api + worker + frontend + managed Redis) + Supabase (Postgres/pgvector, Auth, object storage) + Cloudflare (DNS + Turnstile captcha) + Mailgun (SMTP)
- Invite-only beta; sign-ups disabled in Supabase Auth until we're ready for wider access
- Operator env controls everything provider-side — users only see their content, not the LLM plumbing (`PUBLIC_DEPLOYMENT=true`)
- Same codebase, gated behind env flags. Anyone can stand up their own instance via `docs/saas-deploy.md`

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

Required for ficino.app public deployment.

| Item | Status |
|------|--------|
| Auth & user management | **Shipped** — pluggable AUTH_PROVIDER (none/basic/supabase), Turnstile captcha, OTP-code password recovery |
| Rate limiting & cost controls | **Shipped** — Redis-based per-user rate limits on uploads (50/day), feed generation (20/day), user posts (30/day). Configurable via env. Skipped for AUTH_PROVIDER=none |
| Retrieval debug view (dev only) | **Shipped** — three-dots menu → Debug view (dev builds only) |
| Logging & error tracking | Deferred — structlog in place for container logs. Will pick a service (Sentry, Betterstack, Axiom) once beta-tester volume warrants it |
| Connection pooling optimization | **Shipped** — env-configurable pool sizes (`DB_POOL_MIN_SIZE` / `DB_POOL_MAX_SIZE`) on both api and worker. Railway defaults 2-8 (api) / 1-5 (worker) to fit Supabase session pooler's 15-client cap |
| Security headers & CORS lockdown | **Shipped** — X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS + CSP in production, CORS locked to specific origins, CORSMiddleware moved to outermost layer so CSRF/header-middleware rejections still carry ACAO |
| SaaS deploy (Railway + Supabase) | **Shipped** — full operator runbook at `docs/saas-deploy.md`. Three Railway services + managed Redis, one Supabase project, Cloudflare DNS + Turnstile, Mailgun SMTP. Same frontend bundle as self-host; env flags toggle the hosted behaviour |
| Object storage backend | **Shipped** — pluggable via `STORAGE_PROVIDER=local|supabase`. Local is the self-host default (filesystem under `/app/uploads`, `/app/figures`); Supabase uses a single private bucket keyed by `{user_id}/{paper_id}.pdf` and `.../figures/{filename}.png` with signed-URL figure access (30-day TTL). Workers download PDFs to a tempfile for fitz/marker/PIL and release on cleanup |
| Mobile responsiveness | **Shipped** — see the Mobile section above. Dropdowns clamped, touch targets ≥44 px, safe-area insets, edge swipe-back, swipeable tabs, pull-to-refresh, swipe-to-act, keyboard-aware inputs, haptics |
