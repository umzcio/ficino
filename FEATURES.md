# Ficino — Feature Ideas & Roadmap

Tracking wild ideas, design decisions, and future features.

---

## DM / Mail — Paper Intelligence View

**Concept**: Repurpose the Twitter/X DM icon as a "conversations with your corpus" feature. The metaphor: your papers are messaging you their insights.

### Individual DMs — Paper-Level Summaries
- Click Mail icon → inbox-style list of papers
- Tap into a paper → structured summary presented as a chat thread
- Summary includes: key findings, methodology, limitations, notable figures
- The paper "talks to you" — each section is a message bubble
- Generated on first open, cached for future views
- Could include extracted figures inline like image messages

### Group Chats — Corpus-Level Synthesis
- Create a "group chat" from multiple papers (or a tag group)
- AI synthesizes across papers: agreements, contradictions, gaps
- Presented as a conversation between the papers themselves
- "Paper A says X, but Paper B found Y" — structured disagreement mapping
- Natural extension of the contradiction detection we already have

### Future: Ask Your Corpus (Q&A)
- Type a question in the DM view → RAG retrieval → direct answer with citations
- Like DMing a research assistant who's read all your papers
- Could support follow-up questions (conversational RAG)
- Builds on the existing hybrid search + chunk retrieval

**Status**: Design phase. Paper-level summaries first, then group chats.

---

## Workspaces + Explore

**Concept**: The Search/Explore icon becomes a workspace hub. Workspaces are named research contexts that scope everything — papers, feeds, summaries, tags. Solves the "50 papers in one pile" problem.

### The Problem
A researcher has papers for their dissertation, a conference paper, and a grant proposal. Without workspaces, everything mixes — feed generation argues about unrelated papers, the corpus panel is overwhelming, DM summaries blur together.

### Workspace Scoping
Everything scopes to the active workspace:
- Papers belong to a workspace
- Feed generation pulls from active workspace only
- DM summaries are per-workspace
- Tags work within a workspace
- Bookmarks are global (saved posts from any workspace)

### Switching Workspaces

**Desktop:**
- Header shows active workspace: "ficino / Dissertation Ch. 2 ▾"
- Click the dropdown for quick switch
- Explore page (Search icon) = full workspace management + activity timeline

**Mobile:**
- Long-press Home icon → bottom sheet slides up (mirrors Twitter/X account switching)
- Shows list of workspaces with paper/feed counts, gold dot on active
- Quick tap to switch, "New Workspace" at bottom, swipe down to dismiss

### First-Time Experience
- New users get a "Default" workspace — no workspace UI shown until they create a second one
- Existing data migrates to "Default" workspace with no disruption

### Explore Page Contents
- **Workspace grid/list** — all workspaces with paper counts, last activity
- **Activity timeline** — cross-workspace history:
  - "Uploaded 3 papers tagged #AI Governance"
  - "Generated feed — 5 contradictions found"
  - "Summarized Trust in AI paper"
- **Search bar** — search across all chunks, papers, and generated posts

### Design Decisions
- Papers live in ONE workspace only (keeps it simple; upload twice for two contexts)
- Moving a paper between workspaces starts fresh (new chunks, new embeddings — avoids stale cross-references)
- Workspaces have a name only (no colors/icons for now — revisit if visual clutter becomes an issue)
- DB already has a `corpora` table that maps to this concept

**Status**: Designed. Ready to build.

---

## Planned Features (from build spec)

- [ ] Auth & user management (Clerk)
- [x] Corpus organization (tags, scoped generation)
- [x] Feed history & bookmarks
- [ ] Retrieval debug view (dev-only)
- [ ] Rate limiting & cost controls
- [ ] Production hardening (logging, Sentry, connection pooling, security headers)

---

## Tab-Specific Feed Generation (Future)

**Concept**: Instead of generating one feed and filtering client-side, each tab (For You / Debates / Methods / Findings) triggers its own generation with different persona weights and section focus.

- **For You**: Mixed feed, all personas, all sections (current behavior)
- **Debates**: Heavy on quotes/replies, prioritize contradictions, weight toward skeptic + practitioner
- **Methods**: Focus retrieval on methods/methodology sections, weight toward methodologist + skeptic
- **Findings**: Focus on results/findings sections, weight toward hype + gradstudent

**Why**: Richer, more focused content per tab. Each tab feels like a different "channel" of discourse.
**Trade-off**: 4x the LLM calls per generation. Could be expensive with API providers. Fine with Ollama.
**Status**: Parking lot. Currently using client-side filtering with post categories (option 1).

---

## Ideas Parking Lot

_Drop ideas here. No commitment, just capture._

## Alerts — Learning Insight Notifications

**Concept**: Alerts aren't system notifications — they surface cognitive friction points. Moments where your understanding should be challenged or deepened. The bell icon becomes a learning companion.

### Alert Types

**Contradiction Alert** (high priority)
- Triggered when a newly uploaded paper contradicts a finding in an existing corpus paper
- "New paper by Kaplan et al. challenges a claim in your Rankin paper — the methodological assumptions are incompatible."
- Links to the specific chunks that conflict
- Most valuable alert — this is active learning

**Emerging Theme Alert** (medium priority)
- After 5+ papers, detects recurring concepts across papers that aren't explicitly tagged
- "3 papers in your corpus discuss 'institutional readiness' but you haven't connected them yet."
- Suggests creating a #tag or group chat
- Nudges pattern recognition

**Persona Disagreement Spike** (medium priority)
- When a new feed generation has unusually high contradiction rate
- "This feed had 8 cross-paper debates — the most in your corpus history."
- Flags that the new paper is provocative/important
- Encourages deeper reading

**Reading Gap** (low priority)
- Paper has been debated in feeds but the user never opened its DM summary
- "You've been debating Kaplan 2023 in feeds but haven't read the summary yet."
- Nudges from surface-level exposure to deeper understanding

**Stale Corpus** (low priority)
- Paper sitting without generating any discourse
- "Chen & Park 2023 has been in your corpus for 2 weeks but never appeared in a feed."
- Nudges cleanup or engagement

### Design Principles
- Alerts are about **learning moments**, not system status
- Unread count badge on bell icon (like Twitter)
- Each alert is actionable — tap to go to the relevant paper/feed/summary
- Alert generation runs post-ingestion and post-feed-generation (async, not blocking)
- Dismissable — swipe or tap X

**Status**: Designed. Contradiction alerts first (highest learning value), then emerging themes.

---

## User Interaction — Reply to Personas + Annotations

**Concept**: Users become participants in the discourse, not just readers. Two interaction modes:

### Reply to Persona
- Tap reply on any post → text input appears inline
- Type your question/comment → the persona responds grounded in the same paper chunks
- "Wait @stats_nerd, what do you mean by construct validity here?" → Stats Nerd clarifies
- Responses appear as threaded replies in the feed
- Each reply is a mini RAG call — retrieves relevant chunks + persona system prompt
- Conversation can go multiple rounds (user → persona → user → persona)

### Annotations
- Add a personal note to any post (private, only you see it)
- "This connects to my dissertation argument about X"
- Shows as a subtle note when you revisit the post or view bookmarks
- Your thinking layered on top of AI discourse
- Annotations visible in bookmarks view

**Status**: Reply to persona — built. Annotations — next.

### Organic Persona Interjections

Other personas jump into your reply threads naturally — not because you pressed a button, but because they "saw" the conversation and couldn't resist weighing in.

**Delayed appearance** — After you and a persona go back and forth 2-3 times, another persona just... shows up. Not instantly. Maybe after a few seconds. Like they stumbled onto the thread.

**Selective** — Not every conversation attracts attention. Only when the topic touches another persona's expertise. If you're debating methodology with @stats_nerd, @skeptical_methods might jump in. But @phd_suffering wouldn't butt into a stats argument — they'd only show up if the conversation gets relatable or confusing.

**Opinionated entry** — They don't just add a neutral comment. They enter with a take: "Sorry to jump in but @stats_nerd is underselling the problem here..." or "I've been lurking on this thread and honestly this is exactly what happened in my lab..."

**No button** — It just happens. The system detects when a conversation hits 3+ turns, checks if the topic is relevant to another persona, and auto-injects a reply. Feels organic.

**Implementation**: After a user reply is saved (3+ turns), backend checks if another persona's expertise domain overlaps with the conversation topic (keyword/embedding match against persona query profiles from retrieval.py). If match score is high enough, generate an interjection with a "jumping in" style prompt. Add to the reply thread with a slight delay on the frontend (render after 2-3 seconds with a subtle animation).

**Status**: Designed. Build after source reveal.

---

## Like as Training Signal (RLHF-lite)

**Concept**: Likes aren't vanity metrics — they're implicit feedback on post quality. Over time, builds a preference model for YOUR discourse style.

### How it works
- Each like is stored with full post context: persona, post type, retrieved chunks, section focus
- Aggregated signals per persona: "User likes 80% of @stats_nerd posts but only 30% of @ai_breakthroughs"
- Aggregated signals per post type: "User likes threads 3x more than standalone posts"
- Aggregated by section: "User prefers posts about methodology over findings"

### What it could influence
- **Persona weights**: Personas with more likes get more posts in future generations
- **Post type distribution**: Liked post types get higher weights
- **Temperature tuning**: If liked posts tend to be from lower-temp generations, adjust
- **Prompt refinement**: Extract patterns from liked posts to refine persona system prompts
- **Retrieval feedback**: Liked posts' source chunks get boosted in future retrieval

### The vision
Essentially RLHF for your personal academic discourse engine. Nobody else is doing this — training an AI discourse model by simply liking the posts that helped you learn.

**Status**: Concept. Requires like storage with full context (not just a counter), preference aggregation pipeline, and feedback loop into generation. Separate from the current synthetic engagement counters.

---

- **Light mode**: Full light theme with inverted color system. Settings toggle already exists (shows "coming soon"). Need to define light palette, update all Tailwind theme vars, handle system preference detection (`prefers-color-scheme`), persist choice in settings DB
- **Notification bell**: Alert when a newly uploaded paper contradicts something in your existing corpus
- **Search**: Full-text search across all chunks with highlighted results
- **Paper metadata extraction**: Auto-detect title, authors, year, DOI from PDF content
- **Export feed**: Share a generated feed as a link or export as PDF/markdown
- **Custom personas**: Let users create their own persona with a custom system prompt
- **Reading lists**: Curated sequences of papers with guided discourse
- **Citation graph**: Visual map of how papers in your corpus cite each other
