"""Persona feed generation tasks.

Full pipeline: retrieve → classify contradictions → generate posts → store feed.
"""

import json
import os
import random
import time
import uuid

import structlog
from celery import Task

from celery_app import app
from lib import claude_client, retrieval, persona as persona_lib
from lib.db import execute, fetchrow, fetch
from lib.post_validation import validate_post_shape
from lib.settings import apply_provider_settings, STUB_USER_ID
from lib.signed_url import sign_resource

# TTL for signed figure URLs embedded in persisted feed posts. Feeds are
# browsed for hours/days after generation, so the 10-minute default would
# cause visible 403s. 24h is long enough to feel permanent to a user but
# still bounds the blast radius of a leaked URL compared to the old
# unauthenticated StaticFiles mount.
FIGURE_URL_TTL_SECONDS = 86400

logger = structlog.get_logger(__name__)

# Synthetic engagement-metric ranges. Used in both the first-generation
# pipeline (generate_feed) and the single-post regenerate path so both
# sources agree. Not cosmetically random across the two — any future
# tuning lands in one place. Mirrored in api/constants.py for reference.
ENGAGEMENT_RANGES: dict[str, tuple[int, int]] = {
    "likes": (100, 5000),
    "retweets": (20, 1000),
    "replies": (10, 500),
    "bookmarks": (10, 900),
}


def _apply_engagement_defaults(post_data: dict[str, object]) -> None:
    """Attach synthetic like/retweet/reply/bookmark counts to a post if absent."""
    for field, (lo, hi) in ENGAGEMENT_RANGES.items():
        post_data.setdefault(field, random.randint(lo, hi))


def _write_feed_posts_index(
    feed_id: str, posts_slice: list[dict], base_index: int, user_id: str,
) -> None:
    """Sync feed_posts search index for a slice of posts.

    Each row is UPSERTed on (feed_id, post_index) so retries and append-mode
    writes are safe. Called AFTER the feeds.posts JSONB is committed — the
    JSONB remains the source of truth; feed_posts is a secondary search
    index that can be rebuilt via infra/postgres/backfill_feed_posts.py
    if it drifts. The caller wraps this in try/except so an index failure
    doesn't lose the feed itself.

    user_id is denormalized onto feed_posts so full-text search can filter
    by owner before hitting the GIN index.
    """
    for i, p in enumerate(posts_slice):
        post_index = base_index + i
        # validate_post_shape already capped content at MAX_CONTENT_CHARS (2000)
        # so feeds.posts and feed_posts now agree. The str(...) coercion stays
        # to handle legacy rows that pre-date that validator.
        content_text = str(p.get("content", ""))
        execute(
            """INSERT INTO feed_posts
               (feed_id, user_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
               ON CONFLICT (feed_id, post_index) DO UPDATE SET
                 content_text = EXCLUDED.content_text,
                 persona = EXCLUDED.persona,
                 post_type = EXCLUDED.post_type,
                 category = EXCLUDED.category,
                 paper_ref = EXCLUDED.paper_ref,
                 data = EXCLUDED.data,
                 deleted = EXCLUDED.deleted""",
            feed_id,
            user_id,
            post_index,
            content_text,
            p.get("persona"),
            p.get("post_type"),
            p.get("category"),
            p.get("paper_ref"),
            json.dumps(p, default=str),
            bool(p.get("deleted", False)),
        )


def _get_paper_ids_for_corpus(
    corpus_id: str | None,
    tag_filter: list[str] | None,
    user_id: str,
) -> list[str]:
    """Get paper IDs scoped to a corpus and/or tag filter.

    Every branch is scoped to `user_id` so another user's tags (names can
    collide across users), papers in the named corpus, or the global
    complete-paper fallback can't leak into this user's generated feed.
    """
    if tag_filter:
        # Filter by tags. Tag names are per-user, so both papers.user_id and
        # tags.user_id must match the caller — otherwise a colliding tag name
        # ("ML", "theory") in another user's workspace silently joins in.
        user_placeholder = f"${len(tag_filter) + 1}"
        placeholders = ",".join(f"${i+1}" for i in range(len(tag_filter)))
        rows = fetch(
            f"""SELECT DISTINCT p.id FROM papers p
                JOIN paper_tags pt ON p.id = pt.paper_id
                JOIN tags t ON pt.tag_id = t.id
                WHERE t.name IN ({placeholders})
                  AND p.status = 'complete'
                  AND p.user_id = {user_placeholder}
                  AND t.user_id = {user_placeholder}""",
            *tag_filter,
            user_id,
        )
    elif corpus_id:
        rows = fetch(
            "SELECT id FROM papers WHERE corpus_id = $1 AND status = 'complete' AND user_id = $2",
            corpus_id,
            user_id,
        )
    else:
        # All complete papers owned by this user
        rows = fetch(
            "SELECT id FROM papers WHERE status = 'complete' AND user_id = $1",
            user_id,
        )

    return [str(row["id"]) for row in rows]


def _get_tab_overrides(tab_focus: str, enabled_personas: set[str]) -> dict | None:
    """Return persona and post-type weight overrides for tab-specific generation.

    Each tab focuses on specific personas and post types while keeping
    others available at reduced weight for variety.
    """
    if tab_focus == "debates":
        # Heavy on quotes and replies, all personas (debates need disagreement)
        personas = enabled_personas  # keep all — debates need diverse voices
        weights = {"post": 0.10, "thread": 0.05, "quote": 0.40, "reply": 0.40, "figure": 0.05}
    elif tab_focus == "methods":
        # Skeptic and methodologist dominate, threads and posts
        method_personas = {"skeptic", "methodologist"} & enabled_personas
        personas = method_personas if method_personas else enabled_personas
        weights = {"post": 0.40, "thread": 0.35, "quote": 0.10, "reply": 0.10, "figure": 0.05}
    elif tab_focus == "findings":
        # Hype and practitioner dominate, posts and figure analyses
        findings_personas = {"hype", "practitioner"} & enabled_personas
        personas = findings_personas if findings_personas else enabled_personas
        weights = {"post": 0.35, "thread": 0.15, "quote": 0.15, "reply": 0.10, "figure": 0.25}
    else:
        return None

    return {"personas": personas, "post_weights": weights}


def _detect_contradictions(
    chunks: list[dict[str, object]], max_pairs: int = 5
) -> list[dict[str, object]]:
    """Run contradiction detection on chunk pairs from different papers.

    Samples pairs from different papers and classifies their relationship.
    """
    # Group chunks by paper
    by_paper: dict[str, list[dict[str, object]]] = {}
    for chunk in chunks:
        pid = str(chunk["paper_id"])
        by_paper.setdefault(pid, []).append(chunk)

    if len(by_paper) < 2:
        return []  # Need at least 2 papers for cross-paper contradiction

    # Sample cross-paper pairs
    paper_ids = list(by_paper.keys())
    pairs: list[tuple[dict[str, object], dict[str, object]]] = []

    for _ in range(max_pairs * 3):  # Oversample, then trim
        if len(pairs) >= max_pairs:
            break
        pid_a, pid_b = random.sample(paper_ids, 2)
        chunk_a = random.choice(by_paper[pid_a])
        chunk_b = random.choice(by_paper[pid_b])
        pairs.append((chunk_a, chunk_b))

    # Classify each pair
    contradictions: list[dict[str, object]] = []
    for chunk_a, chunk_b in pairs[:max_pairs]:
        try:
            relationship = claude_client.classify_contradiction_sync(
                str(chunk_a["content"]), str(chunk_b["content"])
            )
            contradictions.append({
                "paper_a": chunk_a.get("paper_title") or chunk_a.get("paper_filename"),
                "paper_b": chunk_b.get("paper_title") or chunk_b.get("paper_filename"),
                "content_a": str(chunk_a["content"]),
                "content_b": str(chunk_b["content"]),
                "relationship": relationship,
            })
        except Exception as e:
            # Log type + message so operator can tell a rate-limit from a
            # parse error from a connection refusal. Still swallow so a
            # single bad pair doesn't kill the whole contradiction pass.
            logger.warn(
                "contradiction_classify_failed",
                error_type=type(e).__name__,
                error=str(e)[:200],
            )

    # Only return actual contradictions/supports (not just extends)
    interesting = [c for c in contradictions if c["relationship"] in ("contradicts", "supports")]
    logger.info("contradictions_detected",
                total_pairs=len(pairs),
                interesting=len(interesting))
    return interesting if interesting else contradictions[:2]


@app.task(
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    name="tasks.persona_tasks.generate_feed",
)
def generate_feed(
    self: Task,
    corpus_id: str | None = None,
    tag_filter: list[str] | None = None,
    user_id: str | None = None,
    num_posts: int = 12,
    append_to_feed_id: str | None = None,
    tab_focus: str | None = None,
    persona_key: str | None = None,
) -> dict[str, object]:
    """Full feed generation pipeline.

    Steps:
    1. Get paper IDs in scope
    2. Retrieve relevant chunks for each persona
    3. Detect contradictions across papers
    4. Generate posts via LLM
    5. Store feed in database
    """
    # Hoisted early so the append_to_feed_id branch below can scope its
    # SELECT/UPDATE by user_id as defense-in-depth against a bypass of the
    # API's ownership check. Later assignments of effective_user_id in this
    # function are idempotent with this one.
    effective_user_id = user_id or STUB_USER_ID

    existing_posts: list[dict[str, object]] = []
    if append_to_feed_id:
        feed_id = append_to_feed_id
        # Load existing posts from the feed — scoped by user_id in case this
        # task was dispatched by something other than the API router.
        row = fetchrow(
            "SELECT posts FROM feeds WHERE id = $1 AND user_id = $2",
            feed_id, effective_user_id,
        )
        if row and row["posts"]:
            existing_posts = json.loads(row["posts"]) if isinstance(row["posts"], str) else row["posts"]
        # Idempotency guard: Celery retries reuse the same task_id. If a prior
        # attempt of this same task already appended its posts, return early
        # rather than double-appending. Each generated post is tagged with
        # `_task_id` below so we can detect this on retry.
        if any(
            isinstance(p, dict) and p.get("_task_id") == self.request.id
            for p in existing_posts
        ):
            logger.info("generate_feed_idempotent_skip",
                        feed_id=feed_id, task_id=self.request.id,
                        existing_post_count=len(existing_posts))
            return {
                "feed_id": feed_id,
                "post_count": len(existing_posts),
                "duration_ms": 0,
                "idempotent": True,
            }
    else:
        feed_id = str(uuid.uuid4())
    log = logger.bind(feed_id=feed_id, task_id=self.request.id, append=bool(append_to_feed_id))
    start_time = time.time()

    try:
        # Load user settings and apply provider env vars
        user_settings = apply_provider_settings()
        # User's posts_per_generation applies to normal feed gen, but not to persona-scoped
        # "Get their take" requests which pass an explicit small num_posts
        if not persona_key:
            num_posts = user_settings.get("posts_per_generation", num_posts)
        enabled_personas = {k for k, v in user_settings.get("personas_enabled", {}).items() if v}
        temperature = user_settings.get("persona_temperature", 0.8)
        post_weights = user_settings.get("post_type_weights", persona_lib.POST_TYPE_WEIGHTS)

        # Load learned preferences from likes (Phase 2/3)
        preferences = user_settings.get("preferences")

        # Persona-scoped generation: restrict to one persona (used for "Get their take" on profile)
        if persona_key:
            enabled_personas = {persona_key}
            # Override post-type weights: favor threads (rhythm needs space),
            # allow quotes, some standalone, no replies (nothing from-scratch to reply to),
            # no figures (needs specific figure chunks which aren't guaranteed here)
            post_weights = {"thread": 0.60, "quote": 0.25, "post": 0.15, "reply": 0.0, "figure": 0.0}
            log.info("persona_scoped_generation", persona=persona_key, num_posts=num_posts, weights=post_weights)

        # Tab-focused generation: override weights for specific tab
        tab_category = None
        if tab_focus:
            tab_category = tab_focus
            tab_overrides = _get_tab_overrides(tab_focus, enabled_personas)
            if tab_overrides:
                enabled_personas = tab_overrides["personas"]
                post_weights = tab_overrides["post_weights"]
                log.info("tab_focus_applied", tab=tab_focus, personas=list(enabled_personas), weights=post_weights)

        log.info("settings_loaded",
                 num_posts=num_posts,
                 personas=list(enabled_personas),
                 temperature=temperature,
                 tab_focus=tab_focus)

        # --- Step 1: Scope papers ---
        self.update_state(state="PROGRESS", meta={"step": "scoping", "feed_id": feed_id})
        log.info("feed_step", step="scoping")

        # Resolve the effective user_id ONCE (same fallback used for the
        # feeds INSERT below) so paper scoping and feed ownership agree.
        effective_user_id = user_id or STUB_USER_ID
        paper_ids = _get_paper_ids_for_corpus(corpus_id, tag_filter, effective_user_id)
        if not paper_ids:
            log.warn("no_papers_found")
            # Store empty feed
            execute(
                """INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                feed_id,
                effective_user_id,
                corpus_id,
                tag_filter,
                "[]",
                0, 0, 0,
            )
            return {"status": "complete", "feed_id": feed_id, "post_count": 0}

        # --- Step 2: Retrieve chunks ---
        self.update_state(state="PROGRESS", meta={"step": "retrieving", "feed_id": feed_id})
        log.info("feed_step", step="retrieving", papers=len(paper_ids))

        # Get chunks for each enabled persona (with retrieval boost from liked papers)
        liked_paper_titles = preferences.get("liked_paper_titles") if preferences and preferences.get("has_signal") else None
        all_chunks: dict[str, list[dict[str, object]]] = {}
        active_personas = {k: v for k, v in persona_lib.PERSONAS.items() if k in enabled_personas}
        for persona_key in active_personas:
            chunks = retrieval.retrieve_for_persona(
                persona_key, paper_ids=paper_ids, top_k=10,
                liked_paper_titles=liked_paper_titles,
            )
            all_chunks[persona_key] = chunks
            log.info("persona_chunks_retrieved", persona=persona_key, chunks=len(chunks))

        # Flatten all chunks for contradiction detection
        flat_chunks = []
        seen_ids: set[str] = set()
        for chunks in all_chunks.values():
            for c in chunks:
                if c["id"] not in seen_ids:
                    flat_chunks.append(c)
                    seen_ids.add(c["id"])

        # Fetch available figures for figure posts
        figure_rows = fetch(
            """SELECT f.id, f.paper_id, f.page_number, f.image_path, f.description,
                      f.claim_summary, f.figure_index, p.filename AS paper_filename, p.title AS paper_title
               FROM figures f JOIN papers p ON f.paper_id = p.id
               WHERE f.paper_id = ANY($1)""",
            paper_ids,
        )
        # Signed with a 24h TTL because these URLs are persisted into feed
        # posts and rendered by the frontend long after generation. When a
        # token eventually expires the figure endpoint will 403 — the
        # frontend can recover by re-fetching GET /papers/{paper_id}/figures
        # to get a fresh short-lived token.
        available_figures = [
            {
                "id": str(r["id"]),
                "paper_id": str(r["paper_id"]),
                "page_number": r["page_number"],
                "image_url": (
                    f"/figures/{r['paper_id']}/{r['id']}"
                    f"?token={sign_resource(str(r['id']), ttl=FIGURE_URL_TTL_SECONDS)}"
                ),
                "description": r["description"] or "",
                "claim_summary": r["claim_summary"] or "",
                "figure_index": r["figure_index"],
                "paper_ref": r["paper_title"] or r["paper_filename"],
            }
            for r in figure_rows
        ]
        log.info("figures_available", count=len(available_figures))

        # --- Step 3: Contradiction detection ---
        self.update_state(state="PROGRESS", meta={"step": "classifying", "feed_id": feed_id})
        log.info("feed_step", step="classifying")

        contradictions = _detect_contradictions(flat_chunks) if len(paper_ids) > 1 else []

        # --- Step 4: Generate posts ---
        self.update_state(state="PROGRESS", meta={"step": "generating", "feed_id": feed_id})
        log.info("feed_step", step="generating", planned_posts=num_posts)

        # Get persona system prompts from DB
        system_prompts = persona_lib.get_active_persona_prompts()

        # Plan the feed timeline with user settings + learned preferences
        plan = persona_lib.plan_feed_posts(
            num_posts=num_posts,
            enabled_personas=enabled_personas,
            custom_weights=post_weights,
            preferences=preferences,
        )
        posts: list[dict[str, object]] = []
        # For append mode, new posts can reference existing ones for quotes/replies
        all_feed_posts = list(existing_posts) if existing_posts else []
        id_offset = len(existing_posts)
        time_offset = len(existing_posts) * 2

        # Count how many slots each persona holds in this plan. Used below
        # to decide whether chunk-window rotation is warranted for this
        # persona's slots, and to track which slot-within-persona we're on.
        persona_slot_counts: dict[str, int] = {}
        for a in plan:
            persona_slot_counts[a["persona"]] = persona_slot_counts.get(a["persona"], 0) + 1
        # Running index of THIS persona's appearances as we walk the plan.
        # Maps persona_key → 0, 1, 2, ... as we encounter each slot.
        persona_slot_cursor: dict[str, int] = {}

        for i, assignment in enumerate(plan):
            persona_key = assignment["persona"]
            post_type = assignment["post_type"]

            self.update_state(state="PROGRESS", meta={
                "step": "generating",
                "feed_id": feed_id,
                "post_progress": f"{i+1}/{num_posts}",
            })

            system_prompt = system_prompts.get(persona_key, f"You are {persona_key}")
            chunks = all_chunks.get(persona_key, [])

            if not chunks:
                log.warn("no_chunks_for_persona", persona=persona_key)
                continue

            # Chunk-window rotation: if this persona appears 2+ times in the
            # plan, each of their slots sees a DIFFERENT window of retrieved
            # chunks. Without this, the Skeptic's 3 slots all run against
            # the same top-K chunks and produce near-identical takes — the
            # temperature alone doesn't diverge the output enough. Applies
            # to both mixed feeds (prior code only fired for single-persona
            # plans) and the "Get their take" path.
            my_slot_count = persona_slot_counts[persona_key]
            my_slot_index = persona_slot_cursor.get(persona_key, 0)
            persona_slot_cursor[persona_key] = my_slot_index + 1
            if my_slot_count > 1 and len(chunks) >= 3:
                window_size = max(3, len(chunks) // my_slot_count)
                max_start = max(0, len(chunks) - window_size)
                start = (my_slot_index * window_size) % (max_start + 1) if max_start > 0 else 0
                chunks = chunks[start:start + window_size]

            # Pick figure BEFORE prompt if this is a figure post
            selected_figure = None
            if post_type == "figure" and available_figures:
                selected_figure = random.choice(available_figures)

            # Build the prompt
            # For quotes/replies, include both existing feed posts and newly generated ones.
            # Skip soft-deleted posts — quoting a hidden post would resurrect its content
            # in the new post and look broken when the user toggles showDeleted off.
            reference_posts = (
                [p for p in (all_feed_posts + posts) if not p.get("deleted")]
                if post_type in ("quote", "reply") else None
            )
            user_prompt = persona_lib.build_post_prompt(
                persona_key=persona_key,
                post_type=post_type,
                chunks=chunks,
                contradictions=contradictions if post_type in ("quote", "reply") else None,
                existing_posts=reference_posts,
                figure=selected_figure,
            )

            try:
                persona_temp = persona_lib.get_personas().get(persona_key, {}).get("temperature")
                call_temp = persona_temp if persona_temp is not None else temperature
                post_data = claude_client.generate_persona_post_sync(system_prompt, user_prompt, temperature=call_temp)

                # Ensure required fields
                post_data["persona"] = persona_key
                post_data.setdefault("post_type", post_type)
                # ID is based on the count of successfully-appended posts, not the
                # loop index — when `continue` skips a failed generation, we don't
                # want to leave a gap or (in append mode after prior skips) collide
                # with existing IDs.
                post_data["id"] = id_offset + len(posts) + 1
                post_data["time"] = f"{time_offset + (len(posts) + 1) * 2}m"
                # Idempotency marker so a Celery retry of the same task can
                # detect and skip already-appended work. See guard at task entry.
                post_data["_task_id"] = self.request.id

                # Override paper_ref with actual metadata (don't trust LLM citation)
                if chunks:
                    post_data["paper_ref"] = persona_lib._build_short_cite(chunks[0])

                # Attach the figure data that was used in the prompt
                if selected_figure:
                    post_data["figure_url"] = selected_figure["image_url"]
                    post_data["figure_id"] = selected_figure["id"]
                    fig_idx = (selected_figure.get("figure_index", 0) or 0) + 1
                    post_data["figure_caption"] = f"Fig. {fig_idx}, p.{selected_figure['page_number']} — {selected_figure['description'][:150]}. {selected_figure.get('paper_ref', '')}"
                    if not post_data.get("paper_ref"):
                        post_data["paper_ref"] = selected_figure.get("paper_ref")

                # Attach source chunks for transparency
                post_data["sources"] = [
                    {
                        "paper_title": c.get("paper_title") or c.get("paper_filename", "Unknown"),
                        "section": c.get("section", "unknown"),
                        "content": str(c.get("content", ""))[:300],
                        "score": round(float(c.get("score", 0)), 3),
                    }
                    for c in chunks[:5]  # Top 5 source chunks
                ]

                # Assign category for tab filtering. Every post appears in at
                # least one tab beyond "For You". Shared helper so the three
                # call sites (feed gen / regenerate / reading list) don't drift.
                pt = post_data.get("post_type", post_type)
                post_data["category"] = persona_lib.assign_post_category(persona_key, pt)

                # Tab-focused generation: override category
                if tab_category:
                    post_data["category"] = tab_category

                # Generate engagement numbers (synthetic for now)
                _apply_engagement_defaults(post_data)

                # Soft-validate shape before storage so malformed LLM output
                # doesn't end up in feeds.posts JSONB (2.31). Mutates in place
                # with placeholder values + warn log on drift; never drops.
                validate_post_shape(post_data, persona_key=persona_key)

                posts.append(post_data)
                log.info("post_generated", post=i+1, persona=persona_key, type=post_data.get("post_type"))

            except Exception as e:
                log.error("post_generation_failed", persona=persona_key, error=str(e))
                continue

        # --- Step 5: Store feed ---
        duration_ms = int((time.time() - start_time) * 1000)
        all_posts = existing_posts + posts
        posts_json = json.dumps(all_posts, default=str)

        if append_to_feed_id:
            execute(
                """UPDATE feeds SET posts = $1, post_count = $2, generation_duration_ms = generation_duration_ms + $3
                   WHERE id = $4 AND user_id = $5""",
                posts_json,
                len(all_posts),
                duration_ms,
                feed_id,
                effective_user_id,
            )
        else:
            execute(
                """INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                feed_id,
                effective_user_id,
                corpus_id,
                tag_filter,
                posts_json,
                len(paper_ids),
                len(all_posts),
                duration_ms,
            )

        # Sync feed_posts search index (2.19 / 2.20). Only write the NEW
        # posts — append mode starts at base_index = len(existing_posts),
        # initial generation starts at 0. Failure is non-fatal: JSONB is
        # the source of truth; the backfill script can re-hydrate the index.
        try:
            base_index = len(existing_posts) if append_to_feed_id else 0
            _write_feed_posts_index(feed_id, posts, base_index, effective_user_id)
        except Exception as e:
            log.warn(
                "feed_posts_index_sync_failed",
                feed_id=feed_id,
                error_type=type(e).__name__,
                error=str(e)[:200],
            )

        log.info("feed_generation_complete",
                 feed_id=feed_id,
                 posts=len(posts),
                 papers=len(paper_ids),
                 duration_ms=duration_ms)

        # Trigger post-feed alerts
        try:
            app.send_task(
                "tasks.alert_tasks.check_post_feed",
                args=[feed_id],
                queue="persona",
            )
        except Exception:
            log.warn("post_feed_alert_dispatch_failed")

        # Recompute preferences from likes so next generation reflects latest
        # signal. Pass user_id so the recompute writes to THIS user's row
        # instead of collapsing every tenant onto STUB_USER_ID.
        try:
            app.send_task(
                "tasks.preference_tasks.compute_preferences",
                kwargs={"user_id": effective_user_id},
                queue="persona",
            )
        except Exception:
            log.warn("preference_recompute_dispatch_failed")

        return {
            "status": "complete",
            "feed_id": feed_id,
            "post_count": len(all_posts),
            "paper_count": len(paper_ids),
            "duration_ms": duration_ms,
        }

    except Exception as exc:
        log.error("feed_generation_failed", error=str(exc))
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise


@app.task(name="tasks.persona_tasks.regenerate_post", bind=True)
def regenerate_post(
    self: Task,
    feed_id: str,
    post_index: int,
    user_id: str | None = None,
) -> dict[str, object]:
    """Regenerate a single post in an existing feed.

    Keeps the same persona and post_type, retrieves fresh chunks,
    generates a new post, and patches the feed JSONB in place.

    `user_id` is required to scope the feed lookup (so a task dispatched
    for user A can't mutate user B's feed) and the downstream paper scan
    via `_get_paper_ids_for_corpus`. Defaults to STUB_USER_ID for
    AUTH_PROVIDER=none compatibility.
    """
    log = logger.bind(feed_id=feed_id, post_index=post_index)
    log.info("regenerate_post_start")

    effective_user_id = user_id or STUB_USER_ID

    user_settings = apply_provider_settings()
    temperature = user_settings.get("persona_temperature", 0.8)

    # Load the existing feed. Scoped by user_id so a malicious or buggy
    # dispatcher can't regenerate another user's post even if they guess
    # the feed_id.
    row = fetchrow(
        "SELECT posts, corpus_id FROM feeds WHERE id = $1 AND user_id = $2",
        feed_id, effective_user_id,
    )
    if not row:
        raise ValueError(f"Feed {feed_id} not found")

    posts = row["posts"]
    if isinstance(posts, str):
        posts = json.loads(posts)

    if post_index < 0 or post_index >= len(posts):
        raise ValueError(f"Post index {post_index} out of range (feed has {len(posts)} posts)")

    old_post = posts[post_index]
    persona_key = old_post.get("persona")
    post_type = old_post.get("post_type", "post")
    corpus_id = str(row["corpus_id"]) if row["corpus_id"] else None

    # 3.8: guard against a malformed post that's missing its persona tag —
    # otherwise persona_key stays None and downstream prompts end up with
    # `f"You are {None}"`. Either a stored post predates the Literal-typed
    # models, or the LLM dropped the field. Fail loudly rather than generate.
    if not persona_key or not isinstance(persona_key, str):
        raise ValueError(
            f"Post at feed {feed_id} index {post_index} has no persona — cannot regenerate"
        )

    # Get paper IDs for this corpus, scoped to the owning user.
    paper_ids = _get_paper_ids_for_corpus(corpus_id, None, effective_user_id)
    if not paper_ids:
        raise ValueError("No papers in corpus")

    # Retrieve fresh chunks for this persona
    chunks = retrieval.retrieve_for_persona(persona_key, paper_ids=paper_ids, top_k=10)
    if not chunks:
        raise ValueError(f"No chunks retrieved for persona {persona_key}")

    # Get system prompt
    system_prompts = persona_lib.get_active_persona_prompts()
    system_prompt = system_prompts.get(persona_key, f"You are {persona_key}")

    # Build prompt (standalone — no quote/reply context for regeneration)
    user_prompt = persona_lib.build_post_prompt(
        persona_key=persona_key,
        post_type=post_type if post_type in ("post", "thread", "figure") else "post",
        chunks=chunks,
    )

    # Generate
    persona_temp = persona_lib.get_personas().get(persona_key, {}).get("temperature")
    call_temp = persona_temp if persona_temp is not None else temperature
    post_data = claude_client.generate_persona_post_sync(system_prompt, user_prompt, temperature=call_temp)

    # Fill required fields
    post_data["persona"] = persona_key
    post_data.setdefault("post_type", post_type)
    post_data["id"] = old_post.get("id", post_index + 1)
    post_data["time"] = old_post.get("time", f"{post_index * 2}m")

    if chunks:
        post_data["paper_ref"] = persona_lib._build_short_cite(chunks[0])

    post_data["sources"] = [
        {
            "paper_title": c.get("paper_title") or c.get("paper_filename", "Unknown"),
            "section": c.get("section", "unknown"),
            "content": str(c.get("content", ""))[:300],
            "score": round(float(c.get("score", 0)), 3),
        }
        for c in chunks[:5]
    ]

    # Assign category via the shared helper (MED-24).
    pt = post_data.get("post_type", post_type)
    post_data["category"] = persona_lib.assign_post_category(persona_key, pt)

    _apply_engagement_defaults(post_data)
    validate_post_shape(post_data, persona_key=persona_key)
    post_data["regenerated"] = True

    # Patch the feed with an atomic jsonb_set so a concurrent regenerate or
    # append-to-feed doesn't lose the other's write via read-modify-write. The
    # UPDATE is also scoped by user_id so a bad dispatch can't cross tenants
    # even if the feed_id arg was wrong.
    post_json = json.dumps(post_data, default=str)
    execute(
        """UPDATE feeds
           SET posts = jsonb_set(posts, ARRAY[$1::text], $2::jsonb, false)
           WHERE id = $3 AND user_id = $4""",
        str(post_index), post_json, feed_id, effective_user_id,
    )

    # Sync the feed_posts search index row for this post_index.
    try:
        _write_feed_posts_index(feed_id, [post_data], post_index, effective_user_id)
    except Exception as e:
        log.warn(
            "feed_posts_index_sync_failed",
            feed_id=feed_id, post_index=post_index,
            error_type=type(e).__name__, error=str(e)[:200],
        )

    log.info("regenerate_post_complete", persona=persona_key, post_type=post_type)
    return {"status": "complete", "feed_id": feed_id, "post_index": post_index}
