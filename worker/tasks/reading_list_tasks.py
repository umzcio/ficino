"""Reading list tasks — AI-powered syllabus ordering and chapter generation.

The Archivist analyzes papers to propose a reading order based on
citation chains, conceptual dependencies, and publication dates.
Chapter generation creates progressive feeds scoped to cumulative
paper subsets.
"""

import json
import time
import uuid

import structlog
from celery import Task

from celery_app import app
from lib import claude_client, retrieval, persona as persona_lib
from lib.db import execute, fetchrow, fetch
from lib.sanitize import fence_untrusted
from lib.settings import apply_provider_settings, STUB_USER_ID

logger = structlog.get_logger(__name__)


ORDERING_SYSTEM = """You are The Archivist, analyzing a set of academic papers to propose an optimal reading order.

Your job is to order these papers from "read first" to "read last" based on:
1. Foundational vs. derivative — papers that define frameworks come before papers that test them
2. Citation dependencies — if Paper B cites Paper A, A should come first
3. Conceptual progression — simpler concepts before complex ones
4. Chronological where relevant — earlier work that establishes a field before recent additions

For each paper, provide a one-sentence rationale explaining why it belongs at that position in the sequence.

PAPERS IN THE CORPUS:
{papers}

Respond in JSON format:
[
  {{"paper_id": "uuid-here", "position": 1, "rationale": "Establishes the foundational framework that three other papers reference."}},
  {{"paper_id": "uuid-here", "position": 2, "rationale": "Introduces the key methodology used by later empirical studies."}}
]

Order ALL papers. Return valid JSON only."""


@app.task(name="tasks.reading_list_tasks.propose_ordering", bind=True, max_retries=2)
def propose_ordering(self: Task, paper_ids: list[str], corpus_id: str | None = None) -> dict:
    """Analyze papers and propose an optimal reading order with rationale.

    Returns:
        ordered_papers: list of {paper_id, position, rationale, title, authors, year}
    """
    log = logger.bind(paper_count=len(paper_ids))
    log.info("propose_ordering_start")
    start = time.time()

    try:
        apply_provider_settings()

        # Load paper metadata + sample chunks for each paper
        papers_context = []
        for pid in paper_ids:
            paper = fetchrow(
                "SELECT id, title, authors, year, filename FROM papers WHERE id = $1",
                pid,
            )
            if not paper:
                continue

            # Get first few chunks to understand the paper's content
            chunks = fetch(
                """SELECT section, content FROM chunks
                   WHERE paper_id = $1 ORDER BY chunk_index LIMIT 5""",
                pid,
            )
            chunk_preview = " ".join(c["content"][:200] for c in chunks)

            title = paper["title"] or paper["filename"]
            authors = ", ".join(paper["authors"]) if paper["authors"] else "Unknown"
            year = paper["year"] or "Unknown"

            papers_context.append({
                "paper_id": str(paper["id"]),
                "title": title,
                "authors": authors,
                "year": year,
                "preview": chunk_preview[:500],
            })

        if not papers_context:
            return {"ordered_papers": [], "error": "No papers found"}

        # Format papers for the prompt. Titles, authors, and chunk previews
        # are PDF-origin — fence so a poisoned paper can't rewrite ordering
        # instructions (ID-set check at line 123 catches phantom IDs but not
        # injected rationale text).
        papers_text = "\n\n".join(
            f"Paper ID: {p['paper_id']}\n"
            f"Title: {fence_untrusted(str(p['title']))}\n"
            f"Authors: {fence_untrusted(str(p['authors']))} ({p['year']})\n"
            f"Content preview: {fence_untrusted(str(p['preview']))}"
            for p in papers_context
        )

        system = ORDERING_SYSTEM.format(papers=papers_text)

        # Generate ordering
        response = claude_client.generate_text_sync(
            system_prompt=system,
            user_prompt="Analyze these papers and propose the optimal reading order. Return JSON only.",
            temperature=0.3,
            max_tokens=2048,
        )

        # Parse JSON response
        ordering = _parse_ordering_json(response)

        # Validate that the LLM returned exactly the papers we asked about.
        # Hallucinated paper_ids would silently get "Unknown" metadata and
        # end up in the user's reading list — we'd rather loudly reject and
        # fall back to input-order than ship phantom entries.
        paper_meta = {p["paper_id"]: p for p in papers_context}
        input_ids = set(paper_meta.keys())
        returned_ids = {item.get("paper_id", "") for item in ordering}

        if returned_ids != input_ids:
            missing = input_ids - returned_ids
            extra = returned_ids - input_ids
            log.warn(
                "propose_ordering_id_mismatch",
                missing=list(missing)[:5],
                extra=list(extra)[:5],
                input_count=len(input_ids),
                returned_count=len(returned_ids),
            )
            # Fall back to input order with empty rationale rather than
            # trusting a partial or padded LLM response.
            result = [
                {
                    "paper_id": p["paper_id"],
                    "position": idx,
                    "rationale": "",
                    "title": p.get("title", "Unknown"),
                    "authors": p.get("authors", "Unknown"),
                    "year": p.get("year", "Unknown"),
                }
                for idx, p in enumerate(papers_context)
            ]
        else:
            result = []
            for item in ordering:
                pid = item["paper_id"]
                meta = paper_meta[pid]
                result.append({
                    "paper_id": pid,
                    "position": item.get("position", 0),
                    "rationale": item.get("rationale", ""),
                    "title": meta.get("title", "Unknown"),
                    "authors": meta.get("authors", "Unknown"),
                    "year": meta.get("year", "Unknown"),
                })
            result.sort(key=lambda x: x["position"])

        duration_ms = int((time.time() - start) * 1000)
        log.info("propose_ordering_complete", duration_ms=duration_ms, papers=len(result))

        return {"ordered_papers": result, "duration_ms": duration_ms}

    except Exception as exc:
        log.error("propose_ordering_failed", error=str(exc))
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise


@app.task(name="tasks.reading_list_tasks.generate_chapter", bind=True, max_retries=2)
def generate_chapter(
    self: Task,
    reading_list_id: str,
    chapter_index: int,
    user_id: str | None = None,
) -> dict:
    """Generate a feed for a specific chapter of a reading list.

    The chapter's feed is scoped to all papers up to and including
    this chapter's papers (cumulative). Personas can reference prior
    chapter content, creating a progressive discourse.
    """
    log = logger.bind(reading_list_id=reading_list_id, chapter_index=chapter_index)
    log.info("generate_chapter_start")

    try:
        # Load the reading list — verify the user owns it and re-use its
        # user_id if no kwarg was passed (API always passes it now; fallback
        # is for legacy in-flight tasks queued before this upgrade).
        rl = fetchrow(
            "SELECT paper_sequence, corpus_id, user_id FROM reading_lists WHERE id = $1",
            reading_list_id,
        )
        if not rl:
            raise ValueError(f"Reading list {reading_list_id} not found")

        effective_user_id = user_id or str(rl["user_id"]) or STUB_USER_ID

        # Load the chapter
        chapter = fetchrow(
            "SELECT id, paper_ids, status FROM reading_list_chapters WHERE reading_list_id = $1 AND chapter_index = $2",
            reading_list_id, chapter_index,
        )
        if not chapter:
            raise ValueError(f"Chapter {chapter_index} not found")

        # Cumulative paper IDs: all papers up to and including this chapter
        paper_sequence = [str(p) for p in rl["paper_sequence"]]
        chapter_paper_ids = [str(p) for p in chapter["paper_ids"]]

        # Find cumulative index: all papers up to the last paper in this chapter
        last_paper = chapter_paper_ids[-1] if chapter_paper_ids else None
        if last_paper and last_paper in paper_sequence:
            cumulative_idx = paper_sequence.index(last_paper) + 1
            cumulative_paper_ids = paper_sequence[:cumulative_idx]
        else:
            cumulative_paper_ids = chapter_paper_ids

        log.info("chapter_scope", chapter_papers=len(chapter_paper_ids), cumulative_papers=len(cumulative_paper_ids))

        # Generate a feed scoped to these papers
        # We'll call generate_feed directly with the paper IDs
        feed_id = str(uuid.uuid4())
        user_settings = apply_provider_settings(effective_user_id)
        num_posts = user_settings.get("posts_per_generation", 12)
        # Opt-out persona enablement — mirror persona_tasks.generate_feed.
        # Start from DB-eligible personas, remove only explicit opt-outs.
        all_feed_personas = {
            k for k, meta in persona_lib.get_personas().items()
            if meta.get("feed_eligible")
        }
        user_enabled = user_settings.get("personas_enabled", {})
        enabled_personas = {
            k for k in all_feed_personas
            if user_enabled.get(k, True) is not False
        }
        temperature = user_settings.get("persona_temperature", 0.8)
        post_weights = user_settings.get("post_type_weights", persona_lib.POST_TYPE_WEIGHTS)
        preferences = user_settings.get("preferences")

        # Retrieve chunks only from cumulative papers
        all_chunks: dict[str, list] = {}
        active_personas = {k: v for k, v in persona_lib.PERSONAS.items() if k in enabled_personas}
        for persona_key in active_personas:
            chunks = retrieval.retrieve_for_persona(persona_key, paper_ids=cumulative_paper_ids, top_k=10)
            all_chunks[persona_key] = chunks

        # Plan and generate posts
        plan = persona_lib.plan_feed_posts(
            num_posts=num_posts,
            enabled_personas=enabled_personas,
            custom_weights=post_weights,
            preferences=preferences,
        )

        system_prompts = persona_lib.get_active_persona_prompts()
        posts = []

        for i, assignment in enumerate(plan):
            persona_key = assignment["persona"]
            post_type = assignment["post_type"]

            system_prompt = system_prompts.get(persona_key, f"You are {persona_key}")
            chunks = all_chunks.get(persona_key, [])
            if not chunks:
                continue

            # Add chapter context to the prompt
            chapter_context = f"\nThis is Chapter {chapter_index + 1} of a reading list. "
            if chapter_index > 0:
                chapter_context += f"The reader has already covered {chapter_index} prior paper(s). Build on that foundation — reference earlier papers when relevant."
            system_prompt = system_prompt + chapter_context

            reference_posts = (
                [p for p in posts if not p.get("deleted")]
                if post_type in ("quote", "reply") and posts else None
            )
            user_prompt = persona_lib.build_post_prompt(
                persona_key=persona_key,
                post_type=post_type if post_type in ("post", "thread", "figure") else "post",
                chunks=chunks,
                existing_posts=reference_posts,
            )

            try:
                post_data = claude_client.generate_persona_post_sync(system_prompt, user_prompt, temperature=temperature)
                post_data["persona"] = persona_key
                post_data.setdefault("post_type", post_type)
                post_data["id"] = i + 1
                post_data["time"] = f"{(i + 1) * 2}m"

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

                # Category assignment via the shared helper (MED-24). The old
                # inline copy was missing the gradstudent → debates branch so
                # gradstudent chapter posts were silently getting "findings".
                pt = post_data.get("post_type", post_type)
                post_data["category"] = persona_lib.assign_post_category(persona_key, pt)

                # Reuse persona_tasks' engagement defaults so reading list and
                # feed gen stay in sync (MED-24 cleanup).
                from tasks.persona_tasks import _apply_engagement_defaults
                _apply_engagement_defaults(post_data)

                posts.append(post_data)
            except Exception as e:
                log.error("chapter_post_failed", error=str(e))
                continue

        # Store the feed
        posts_json = json.dumps(posts, default=str)
        corpus_id = str(rl["corpus_id"]) if rl["corpus_id"] else None

        execute(
            """INSERT INTO feeds (id, user_id, corpus_id, posts, paper_count, post_count, generation_duration_ms)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            feed_id, effective_user_id, corpus_id,
            posts_json, len(cumulative_paper_ids), len(posts), 0,
        )

        # Update chapter with feed_id and mark as unlocked/complete
        execute(
            "UPDATE reading_list_chapters SET feed_id = $1, status = 'complete' WHERE id = $2",
            feed_id, str(chapter["id"]),
        )

        # Unlock the next chapter
        execute(
            """UPDATE reading_list_chapters SET status = 'unlocked'
               WHERE reading_list_id = $1 AND chapter_index = $2 AND status = 'locked'""",
            reading_list_id, chapter_index + 1,
        )

        log.info("generate_chapter_complete", feed_id=feed_id, posts=len(posts))
        return {"status": "complete", "feed_id": feed_id, "post_count": len(posts)}

    except Exception as exc:
        log.error("generate_chapter_failed", error=str(exc))
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise


def _parse_ordering_json(text: str) -> list[dict]:
    """Extract JSON array from LLM response."""
    import re
    # Try raw parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Try extracting from code block
    match = re.search(r'```(?:json)?\s*\n?(.*?)```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # Try finding array in text
    match = re.search(r'\[.*\]', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return []
