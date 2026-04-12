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
from lib.settings import apply_provider_settings, STUB_USER_ID

logger = structlog.get_logger(__name__)


def _get_paper_ids_for_corpus(corpus_id: str | None, tag_filter: list[str] | None) -> list[str]:
    """Get paper IDs scoped to a corpus and/or tag filter."""
    if tag_filter:
        # Filter by tags
        placeholders = ",".join(f"${i+1}" for i in range(len(tag_filter)))
        rows = fetch(
            f"""SELECT DISTINCT p.id FROM papers p
                JOIN paper_tags pt ON p.id = pt.paper_id
                JOIN tags t ON pt.tag_id = t.id
                WHERE t.name IN ({placeholders}) AND p.status = 'complete'""",
            *tag_filter,
        )
    elif corpus_id:
        rows = fetch(
            "SELECT id FROM papers WHERE corpus_id = $1 AND status = 'complete'",
            corpus_id,
        )
    else:
        # All complete papers
        rows = fetch("SELECT id FROM papers WHERE status = 'complete'")

    return [str(row["id"]) for row in rows]


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
            logger.warn("contradiction_classify_failed", error=str(e))

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
) -> dict[str, object]:
    """Full feed generation pipeline.

    Steps:
    1. Get paper IDs in scope
    2. Retrieve relevant chunks for each persona
    3. Detect contradictions across papers
    4. Generate posts via LLM
    5. Store feed in database
    """
    existing_posts: list[dict[str, object]] = []
    if append_to_feed_id:
        feed_id = append_to_feed_id
        # Load existing posts from the feed
        row = fetchrow("SELECT posts FROM feeds WHERE id = $1", feed_id)
        if row and row["posts"]:
            existing_posts = json.loads(row["posts"]) if isinstance(row["posts"], str) else row["posts"]
    else:
        feed_id = str(uuid.uuid4())
    log = logger.bind(feed_id=feed_id, task_id=self.request.id, append=bool(append_to_feed_id))
    start_time = time.time()

    try:
        # Load user settings and apply provider env vars
        user_settings = apply_provider_settings()
        num_posts = user_settings.get("posts_per_generation", num_posts)
        enabled_personas = {k for k, v in user_settings.get("personas_enabled", {}).items() if v}
        temperature = user_settings.get("persona_temperature", 0.8)
        post_weights = user_settings.get("post_type_weights", persona_lib.POST_TYPE_WEIGHTS)

        log.info("settings_loaded",
                 num_posts=num_posts,
                 personas=list(enabled_personas),
                 temperature=temperature)

        # --- Step 1: Scope papers ---
        self.update_state(state="PROGRESS", meta={"step": "scoping", "feed_id": feed_id})
        log.info("feed_step", step="scoping")

        paper_ids = _get_paper_ids_for_corpus(corpus_id, tag_filter)
        if not paper_ids:
            log.warn("no_papers_found")
            # Store empty feed
            execute(
                """INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                feed_id,
                user_id or STUB_USER_ID,
                corpus_id,
                tag_filter,
                "[]",
                0, 0, 0,
            )
            return {"status": "complete", "feed_id": feed_id, "post_count": 0}

        # --- Step 2: Retrieve chunks ---
        self.update_state(state="PROGRESS", meta={"step": "retrieving", "feed_id": feed_id})
        log.info("feed_step", step="retrieving", papers=len(paper_ids))

        # Get chunks for each enabled persona
        all_chunks: dict[str, list[dict[str, object]]] = {}
        active_personas = {k: v for k, v in persona_lib.PERSONAS.items() if k in enabled_personas}
        for persona_key in active_personas:
            chunks = retrieval.retrieve_for_persona(persona_key, paper_ids=paper_ids, top_k=10)
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
        available_figures = [
            {
                "id": str(r["id"]),
                "paper_id": str(r["paper_id"]),
                "page_number": r["page_number"],
                "image_url": f"/figures/{r['paper_id']}/{r['image_path'].split('/')[-1]}",
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

        # Plan the feed timeline with user settings
        plan = persona_lib.plan_feed_posts(
            num_posts=num_posts,
            enabled_personas=enabled_personas,
            custom_weights=post_weights,
        )
        posts: list[dict[str, object]] = []
        # For append mode, new posts can reference existing ones for quotes/replies
        all_feed_posts = list(existing_posts) if existing_posts else []
        id_offset = len(existing_posts)
        time_offset = len(existing_posts) * 2

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

            # Pick figure BEFORE prompt if this is a figure post
            selected_figure = None
            if post_type == "figure" and available_figures:
                selected_figure = random.choice(available_figures)

            # Build the prompt
            # For quotes/replies, include both existing feed posts and newly generated ones
            reference_posts = all_feed_posts + posts if post_type in ("quote", "reply") else None
            user_prompt = persona_lib.build_post_prompt(
                persona_key=persona_key,
                post_type=post_type,
                chunks=chunks,
                contradictions=contradictions if post_type in ("quote", "reply") else None,
                existing_posts=reference_posts,
                figure=selected_figure,
            )

            try:
                post_data = claude_client.generate_persona_post_sync(system_prompt, user_prompt, temperature=temperature)

                # Ensure required fields
                post_data["persona"] = persona_key
                post_data.setdefault("post_type", post_type)
                post_data["id"] = id_offset + i + 1
                post_data["time"] = f"{time_offset + (i + 1) * 2}m"

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

                # Assign category for tab filtering
                # Every post must appear in at least one tab beyond "For You"
                pt = post_data.get("post_type", post_type)
                if pt in ("quote", "reply"):
                    post_data["category"] = "debates"
                elif persona_key in ("skeptic", "methodologist"):
                    post_data["category"] = "methods"
                elif persona_key in ("hype", "practitioner") or pt == "figure":
                    post_data["category"] = "findings"
                elif persona_key == "gradstudent":
                    post_data["category"] = "debates"
                else:
                    post_data["category"] = "findings"

                # Generate engagement numbers (synthetic for now)
                post_data.setdefault("likes", random.randint(100, 5000))
                post_data.setdefault("retweets", random.randint(20, 1000))
                post_data.setdefault("replies", random.randint(10, 500))
                post_data.setdefault("bookmarks", random.randint(10, 900))

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
                   WHERE id = $4""",
                posts_json,
                len(all_posts),
                duration_ms,
                feed_id,
            )
        else:
            execute(
                """INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                feed_id,
                user_id or STUB_USER_ID,
                corpus_id,
                tag_filter,
                posts_json,
                len(paper_ids),
                len(all_posts),
                duration_ms,
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
