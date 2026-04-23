"""Archivist response task — neutral RAG-grounded answers to user posts.

The Archivist retrieves relevant chunks from the user's corpus via hybrid
search and generates a direct, citation-rich answer. No persona voice —
just accurate retrieval and clear synthesis.
"""

import json
import re
import time

import structlog
from celery import Task

from celery_app import app
from lib import claude_client, retrieval, persona as persona_lib
from lib.db import execute, fetchrow
from lib.settings import apply_provider_settings, STUB_USER_ID

logger = structlog.get_logger(__name__)


# "Author (YYYY)" or "Author et al. (YYYY)" — the format the ARCHIVIST_SYSTEM
# prompt asks the model to produce. Looser patterns (e.g. "Smith and Jones
# 2023") are out of scope; the prompt already steers the model to this shape.
_CITATION_PATTERN = re.compile(
    r'\b([A-Z][a-zA-Z\u00C0-\u024F\'\-]+)((?:\s+et\s+al\.?)?)\s*\((\d{4})\)'
)


def _known_citations(chunks: list[dict]) -> set[tuple[str, str]]:
    """Extract (last_name_lower, year_str) tuples from retrieved chunks.

    Only chunks the Archivist actually saw count as grounding — this is the
    set the model is allowed to cite from. Uses the first author's last name
    as the match key, since Archivist's output format drops later authors
    behind "et al.".
    """
    known: set[tuple[str, str]] = set()
    for c in chunks:
        authors = c.get("paper_authors") or []
        year = c.get("paper_year")
        if authors and year:
            first = authors[0] if isinstance(authors, (list, tuple)) else authors
            # Last token of "Jane Doe" → "doe"; handles single-name authors too.
            last = str(first).strip().split()[-1].lower() if str(first).strip() else ""
            if last:
                known.add((last, str(year)))
    return known


def _validate_citations(text: str, known: set[tuple[str, str]]) -> tuple[str, list[str]]:
    """Strip citations that don't match any retrieved chunk's paper.

    Returns (cleaned_text, list_of_stripped_citations). This is post-LLM
    hallucination scrubbing — the prompt tells the model not to invent, but
    LLMs do anyway, so we verify against the chunks that were actually
    retrieved. Strips rather than flags to keep UX clean; hallucinations are
    logged at warn level for monitoring.
    """
    hallucinated: list[str] = []

    def replace(m: re.Match) -> str:
        last = m.group(1).lower()
        year = m.group(3)
        if (last, year) in known:
            return m.group(0)
        hallucinated.append(m.group(0))
        return ""

    cleaned = _CITATION_PATTERN.sub(replace, text)
    # Collapse any empty parenthetical wreckage "( )" or double-spaces left
    # behind by stripped citations so the final prose stays tidy.
    cleaned = re.sub(r'\s+,', ',', cleaned)
    cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip()
    return cleaned, hallucinated


# Hardcoded fallback for the Archivist system prompt, used when the `archivist`
# row in `personas` is missing or has a blank system_prompt. The DB copy is the
# source of truth; this literal only guarantees the worker keeps answering if
# an operator accidentally clears the row during tuning.
_ARCHIVIST_SYSTEM_FALLBACK = """You are The Archivist, a neutral research assistant embedded in Ficino. You have read every paper in the user's corpus. Your job is to answer the user's question directly, grounding every claim in specific passages from the papers.

Rules:
- Cite papers by author and year (e.g., "Chen & Park (2023) found that...")
- When papers disagree, present both sides without taking one
- When the corpus doesn't contain relevant information, say so clearly
- Structure longer answers with bullet points or numbered lists
- Be precise, thorough, and honest
- Keep answers focused — 2-6 sentences for simple questions, longer with structure for complex ones
- Do NOT use JSON formatting. Respond in natural prose.
- Do NOT invent findings. Only cite what appears in the provided context."""


# Suffix appended to whichever system prompt (DB or fallback) we end up using.
# Two parts: a formatting rule that forces real line breaks around markdown
# block markers (without this, the model jams headings and body onto one
# physical line and the frontend renders literal `##` / `---`), and the
# chunks context. The "{chunks}" placeholder is filled at request time.
_ARCHIVIST_CONTEXT_SUFFIX = """

FORMATTING: Use real line breaks. Every markdown heading (## ### ####) must sit on its own line with a blank line above and below it. Every horizontal rule (---) must sit on its own line with a blank line above and below. Every list item must be on its own line. Never concatenate a heading and body text onto one line.

HEADINGS: Use plain descriptive phrases as headings (e.g., `## The Bunker as Entry Point`, not `## Taylor (2021): The Bunker` or `## Taylor — The Bunker`). Do not prefix headings with author names, years, citations, colons, or em-dashes. Cite papers in the body text instead.

CORPUS CONTEXT:
{chunks}"""


def _get_archivist_system_prompt() -> str:
    """Load the archivist persona's system prompt from the DB, with fallback.

    The DB already has an `archivist` row — loading it live means prompt tuning
    through the admin UI / SQL lands without a worker rebuild. Falls back to
    the hardcoded literal if the row is missing or its system_prompt is
    null/empty, so the task never crashes on a misconfigured row.
    """
    try:
        personas = persona_lib.get_personas()
        db_prompt = (personas.get("archivist") or {}).get("system_prompt")
        if db_prompt and str(db_prompt).strip():
            body = str(db_prompt)
        else:
            logger.warn("archivist_persona_prompt_missing_using_fallback")
            body = _ARCHIVIST_SYSTEM_FALLBACK
    except Exception as exc:  # DB blip → degrade rather than fail the task
        logger.warn("archivist_persona_prompt_load_failed", error=str(exc))
        body = _ARCHIVIST_SYSTEM_FALLBACK
    return body + _ARCHIVIST_CONTEXT_SUFFIX


@app.task(name="tasks.archivist_tasks.respond_to_user_post", bind=True, max_retries=2)
def respond_to_user_post(self: Task, user_post_id: str, corpus_id: str | None = None) -> dict:
    """Generate The Archivist's response to a user post.

    1. Loads the user post
    2. Retrieves relevant chunks via hybrid search using the post content as query
    3. Generates a grounded response
    4. Stores the reply and sources in user_posts
    """
    log = logger.bind(user_post_id=user_post_id)
    log.info("archivist_response_start")
    start = time.time()

    try:
        # Load the user post first so we can scope provider settings to the
        # post owner. If we applied settings before this SELECT, retrieval
        # + reply generation would run under whichever user's keys were
        # cached in this Celery prefork child from a prior task.
        row = fetchrow(
            "SELECT content, corpus_id, user_id FROM user_posts WHERE id = $1",
            user_post_id,
        )
        if not row:
            raise ValueError(f"User post {user_post_id} not found")

        user_content = row["content"]
        post_user_id = str(row["user_id"])
        post_corpus_id = str(row["corpus_id"]) if row["corpus_id"] else corpus_id

        user_settings = apply_provider_settings(post_user_id)
        temperature = user_settings.get("persona_temperature", 0.7)

        # Get paper IDs — always scoped to the post owner. If a corpus_id is
        # present, narrow further to that workspace. Without the user_id
        # filter, the no-corpus fallthrough used to leak other users' papers
        # into the Archivist reply.
        if post_corpus_id:
            paper_rows = fetchrow(
                """SELECT array_agg(id::text) AS ids FROM papers
                   WHERE corpus_id = $1 AND user_id = $2 AND status = 'complete'""",
                post_corpus_id, post_user_id,
            )
        else:
            paper_rows = fetchrow(
                """SELECT array_agg(id::text) AS ids FROM papers
                   WHERE user_id = $1 AND status = 'complete'""",
                post_user_id,
            )

        paper_ids = paper_rows["ids"] if paper_rows and paper_rows["ids"] else []

        if not paper_ids:
            # No papers — respond with a helpful message
            reply = {
                "role": "archivist",
                "persona": "archivist",
                "content": "Your corpus is empty — I don't have any papers to search. Upload some PDFs and I'll be able to answer questions about them.",
            }
            _store_reply(user_post_id, reply, [])
            return {"status": "complete", "user_post_id": user_post_id}

        # Hybrid retrieval using the user's question as query
        chunks = retrieval.retrieve_chunks(
            query=user_content,
            paper_ids=paper_ids,
            top_k=15,
        )
        log.info("archivist_chunks_retrieved", chunks=len(chunks))

        # Format chunks for the prompt. Chunk content is untrusted PDF text;
        # fence each block so a hostile document can't rewrite the system prompt.
        from lib.sanitize import fence_untrusted

        chunks_text = "\n\n".join(
            f"[{c.get('paper_title', 'Unknown')} — {c.get('section', 'unknown')}]\n"
            f"{fence_untrusted(str(c['content']))}"
            for c in chunks
        ) if chunks else "No relevant passages found in the corpus."

        system = _get_archivist_system_prompt().format(chunks=chunks_text)

        # Generate response
        response = claude_client.generate_text_sync(
            system_prompt=system,
            user_prompt=user_content,
            temperature=temperature,
            max_tokens=1024,
        )

        # Post-process: strip "Author (YYYY)" citations that don't correspond
        # to any retrieved chunk's paper. The model is instructed not to
        # hallucinate, but verifying against the grounding set is cheap.
        # Known citations are built from ALL retrieved chunks, not just the
        # top 5 — the model sees all of them in the prompt and may cite any.
        known = _known_citations(chunks)
        response, hallucinated = _validate_citations(response, known)
        if hallucinated:
            log.warn(
                "archivist_hallucinated_citation",
                count=len(hallucinated),
                citations=hallucinated[:10],
            )

        # Build sources
        # chunk_id + paper_id are the anchors the Archivist's follow-up
        # reply path uses to re-fetch these exact chunks — the user can ask
        # a follow-up question against the same grounded context.
        sources = [
            {
                "chunk_id": c.get("id"),
                "paper_id": c.get("paper_id"),
                "paper_title": c.get("paper_title") or c.get("paper_filename", "Unknown"),
                "section": c.get("section", "unknown"),
                "content": str(c.get("content", ""))[:300],
                "score": round(float(c.get("score", 0)), 3),
            }
            for c in chunks[:5]
        ]

        reply = {
            "role": "archivist",
            "persona": "archivist",
            "content": response,
        }

        _store_reply(user_post_id, reply, sources)
        duration_ms = int((time.time() - start) * 1000)
        log.info("archivist_response_complete", duration_ms=duration_ms)

        return {"status": "complete", "user_post_id": user_post_id, "duration_ms": duration_ms}

    except Exception as exc:
        log.error("archivist_response_failed", error=str(exc))
        # Mark post as error
        execute(
            "UPDATE user_posts SET status = 'error' WHERE id = $1",
            user_post_id,
        )
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise


def _store_reply(user_post_id: str, reply: dict, sources: list[dict]) -> None:
    """Store the archivist reply and sources, mark post as complete."""
    replies_json = json.dumps([reply])
    sources_json = json.dumps(sources)
    execute(
        "UPDATE user_posts SET replies = $1, sources = $2, status = 'complete' WHERE id = $3",
        replies_json, sources_json, user_post_id,
    )


def _append_reply(user_post_id: str, reply: dict) -> None:
    """Append a follow-up reply to the existing replies array and mark the
    post complete. Used by the follow-up path — unlike _store_reply we
    don't touch sources, since the initial grounding citations remain
    attached to the first turn.
    """
    reply_json = json.dumps([reply])
    execute(
        """UPDATE user_posts
           SET replies = replies || $1::jsonb, status = 'complete'
           WHERE id = $2""",
        reply_json, user_post_id,
    )


@app.task(name="tasks.archivist_tasks.respond_to_user_post_followup", bind=True, max_retries=2)
def respond_to_user_post_followup(self: Task, user_post_id: str) -> dict:
    """Generate The Archivist's response to a follow-up turn on an
    existing user post.

    By the time this task fires, the `replies` JSONB array already ends
    with a {role:"user", content:…} turn appended by the API endpoint.
    We retrieve fresh chunks using that latest turn as the query (follow-
    ups often pivot topics, so reusing the initial grounding would miss
    the mark), carry the prior conversation into the prompt as a
    transcript, then append the Archivist's reply.
    """
    log = logger.bind(user_post_id=user_post_id)
    log.info("archivist_followup_start")
    start = time.time()

    try:
        row = fetchrow(
            "SELECT content, replies, corpus_id, user_id FROM user_posts WHERE id = $1",
            user_post_id,
        )
        if not row:
            raise ValueError(f"User post {user_post_id} not found")

        original_question = row["content"]
        replies = row["replies"]
        if isinstance(replies, str):
            replies = json.loads(replies)
        post_user_id = str(row["user_id"])
        post_corpus_id = str(row["corpus_id"]) if row["corpus_id"] else None

        if not replies or replies[-1].get("role") != "user":
            raise ValueError("No pending user turn in replies")
        last_user_msg = replies[-1]["content"]

        user_settings = apply_provider_settings(post_user_id)
        temperature = user_settings.get("persona_temperature", 0.7)

        if post_corpus_id:
            paper_rows = fetchrow(
                """SELECT array_agg(id::text) AS ids FROM papers
                   WHERE corpus_id = $1 AND user_id = $2 AND status = 'complete'""",
                post_corpus_id, post_user_id,
            )
        else:
            paper_rows = fetchrow(
                """SELECT array_agg(id::text) AS ids FROM papers
                   WHERE user_id = $1 AND status = 'complete'""",
                post_user_id,
            )
        paper_ids = paper_rows["ids"] if paper_rows and paper_rows["ids"] else []

        if not paper_ids:
            _append_reply(user_post_id, {
                "role": "archivist",
                "persona": "archivist",
                "content": "Your corpus is empty — I don't have any papers to search.",
            })
            return {"status": "complete", "user_post_id": user_post_id}

        chunks = retrieval.retrieve_chunks(
            query=last_user_msg,
            paper_ids=paper_ids,
            top_k=15,
        )
        log.info("archivist_followup_chunks_retrieved", chunks=len(chunks))

        from lib.sanitize import fence_untrusted
        chunks_text = "\n\n".join(
            f"[{c.get('paper_title', 'Unknown')} — {c.get('section', 'unknown')}]\n"
            f"{fence_untrusted(str(c['content']))}"
            for c in chunks
        ) if chunks else "No relevant passages found in the corpus."

        system = _get_archivist_system_prompt().format(chunks=chunks_text)

        # Flatten the conversation into a transcript. We don't have a
        # multi-turn API in claude_client yet, so we pass the prior turns
        # as a transcript inside the user_prompt and mark the latest turn
        # as the one to respond to. This keeps citations and topic-shift
        # awareness intact without expanding claude_client's surface.
        transcript_lines = [f"USER: {original_question}"]
        # Prior turns excluding the trailing user turn we're about to answer.
        for r in replies[:-1]:
            role = "USER" if r.get("role") == "user" else "ARCHIVIST"
            transcript_lines.append(f"{role}: {r.get('content', '')}")
        transcript_lines.append(f"USER: {last_user_msg}")
        transcript = "\n\n".join(transcript_lines)

        user_prompt = (
            "This is an ongoing conversation with the user about their corpus. "
            "The full thread so far:\n\n"
            f"{transcript}\n\n"
            "Respond to the most recent USER message, continuing the conversation naturally. "
            "Draw on the fresh corpus passages provided in the system prompt."
        )

        response = claude_client.generate_text_sync(
            system_prompt=system,
            user_prompt=user_prompt,
            temperature=temperature,
            max_tokens=1024,
        )

        known = _known_citations(chunks)
        response, hallucinated = _validate_citations(response, known)
        if hallucinated:
            log.warn(
                "archivist_followup_hallucinated_citation",
                count=len(hallucinated),
                citations=hallucinated[:10],
            )

        _append_reply(user_post_id, {
            "role": "archivist",
            "persona": "archivist",
            "content": response,
        })

        duration_ms = int((time.time() - start) * 1000)
        log.info("archivist_followup_complete", duration_ms=duration_ms)
        return {"status": "complete", "user_post_id": user_post_id, "duration_ms": duration_ms}

    except Exception as exc:
        log.error("archivist_followup_failed", error=str(exc))
        execute(
            "UPDATE user_posts SET status = 'error' WHERE id = $1",
            user_post_id,
        )
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise
