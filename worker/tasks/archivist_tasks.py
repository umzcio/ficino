"""Archivist response task — neutral RAG-grounded answers to user posts.

The Archivist retrieves relevant chunks from the user's corpus via hybrid
search and generates a direct, citation-rich answer. No persona voice —
just accurate retrieval and clear synthesis.
"""

import json
import time

import structlog
from celery import Task

from celery_app import app
from lib import claude_client, retrieval
from lib.db import execute, fetchrow
from lib.settings import apply_provider_settings, STUB_USER_ID

logger = structlog.get_logger(__name__)


ARCHIVIST_SYSTEM = """You are The Archivist, a neutral research assistant embedded in Ficino. You have read every paper in the user's corpus. Your job is to answer the user's question directly, grounding every claim in specific passages from the papers.

Rules:
- Cite papers by author and year (e.g., "Chen & Park (2023) found that...")
- When papers disagree, present both sides without taking one
- When the corpus doesn't contain relevant information, say so clearly
- Structure longer answers with bullet points or numbered lists
- Be precise, thorough, and honest
- Keep answers focused — 2-6 sentences for simple questions, longer with structure for complex ones
- Do NOT use JSON formatting. Respond in natural prose.
- Do NOT invent findings. Only cite what appears in the provided context.

CORPUS CONTEXT:
{chunks}"""


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
        user_settings = apply_provider_settings()
        temperature = user_settings.get("persona_temperature", 0.7)

        # Load the user post
        row = fetchrow("SELECT content, corpus_id FROM user_posts WHERE id = $1", user_post_id)
        if not row:
            raise ValueError(f"User post {user_post_id} not found")

        user_content = row["content"]
        post_corpus_id = str(row["corpus_id"]) if row["corpus_id"] else corpus_id

        # Get paper IDs for this corpus
        if post_corpus_id:
            paper_rows = fetchrow(
                "SELECT array_agg(id::text) AS ids FROM papers WHERE corpus_id = $1 AND status = 'complete'",
                post_corpus_id,
            )
        else:
            paper_rows = fetchrow(
                "SELECT array_agg(id::text) AS ids FROM papers WHERE status = 'complete'",
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

        system = ARCHIVIST_SYSTEM.format(chunks=chunks_text)

        # Generate response
        response = claude_client.generate_text_sync(
            system_prompt=system,
            user_prompt=user_content,
            temperature=temperature,
            max_tokens=1024,
        )

        # Build sources
        sources = [
            {
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
