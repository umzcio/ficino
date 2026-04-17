"""Paper summary and corpus synthesis generation tasks."""

import asyncio
import json
import uuid

import structlog
from celery import Task

from celery_app import app
from lib import claude_client
from lib.db import execute, fetch, fetchrow

logger = structlog.get_logger(__name__)

PAPER_SUMMARY_SYSTEM = """You are a research paper summarizer for an academic discourse platform.
Your job is to create a structured summary of a paper presented as a series of chat messages —
as if the paper itself is talking to the reader, explaining what it found.

Keep each message focused on ONE aspect. Be specific, cite numbers and findings from the text.
Use an accessible, conversational tone — not dry academic language.
Do NOT use markdown headers. Write plain text for each message."""

PAPER_SUMMARY_PROMPT = """Based on these extracted sections from the paper "{title}", generate a structured summary
as a JSON array of message objects. Each message should cover one aspect of the paper.

PAPER CONTENT:
{chunks}

Generate 8-9 messages covering these types IN THIS ORDER:

1. "tldr" — The bottom line in ONE sentence. What did this paper find or prove? Write it like you're texting a friend the punchline. No preamble, just the core takeaway. Do NOT use markdown formatting (no asterisks, no bold markers). Plain text only. Example: "Basically, only 10% of AI governance frameworks have ever been tested in a real institution."

2. "intro" — A warm, conversational overview of who wrote this and what they set out to do. Introduce the team/context, explain the problem they're tackling. THEN end with a sentence that previews the key finding — connect the setup to the punchline. Don't just introduce, land it.

3. "question" — The specific research question or problem statement they investigated.

4. "methods" — How they studied it. Specific approach, sample size, data sources.

5. "findings" — The most important results with specific numbers, counts, or percentages from the text.

6. "surprise" — What was unexpected or stood out. The thing that makes you go "huh, really?"

7. "limitations" — What the authors acknowledge they couldn't capture or control for. Be honest.

8. "implications" — Why this matters. What should change because of this work?

9. (Optional) "figure" — Highlight a specific figure or table if referenced in the text.

Respond with ONLY a JSON array:
[
  {{"role": "paper", "type": "tldr", "content": "..."}},
  {{"role": "paper", "type": "intro", "content": "..."}},
  {{"role": "paper", "type": "question", "content": "..."}},
  {{"role": "paper", "type": "methods", "content": "..."}},
  {{"role": "paper", "type": "findings", "content": "..."}},
  {{"role": "paper", "type": "surprise", "content": "..."}},
  {{"role": "paper", "type": "limitations", "content": "..."}},
  {{"role": "paper", "type": "implications", "content": "..."}}
]"""

SYNTHESIS_SYSTEM = """You are an academic synthesis engine. You analyze multiple papers together and produce
a structured conversation showing how they relate — where they agree, where they disagree,
and what gaps exist between them. Present this as a group chat where each paper speaks for itself."""

SYNTHESIS_PROMPT = """Synthesize these papers into a group conversation. Each paper should "speak"
about its findings, and the conversation should highlight agreements, contradictions, and gaps.

PAPERS AND THEIR KEY CHUNKS:
{paper_chunks}

Generate 8-12 messages as a JSON array. Each message should reference which paper is speaking.
Include at least:
- Each paper introducing its main finding
- At least one agreement between papers
- At least one disagreement or tension
- A gap or question that none of the papers fully address

Respond with ONLY a JSON array:
[
  {{"role": "paper", "paper_ref": "Author et al. YEAR", "type": "intro", "content": "..."}},
  {{"role": "paper", "paper_ref": "Author et al. YEAR", "type": "finding", "content": "..."}},
  {{"role": "synthesis", "type": "agreement", "content": "These papers agree that..."}},
  {{"role": "synthesis", "type": "contradiction", "content": "However, Paper A found X while Paper B found Y..."}},
  {{"role": "synthesis", "type": "gap", "content": "None of these papers address..."}}
]"""


@app.task(
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    name="tasks.summary_tasks.generate_paper_summary",
)
def generate_paper_summary(self: Task, paper_id: str) -> dict[str, object]:
    """Generate a chat-style summary for a single paper."""
    log = logger.bind(paper_id=paper_id, task_id=self.request.id)
    log.info("paper_summary_start")

    try:
        # Check if a completed summary already exists
        existing = fetchrow("SELECT id, status FROM paper_summaries WHERE paper_id = $1", paper_id)
        if existing and (existing.get("status") or "complete") == "complete" and existing.get("status") != "generating":
            log.info("paper_summary_exists")
            return {"status": "exists", "paper_id": paper_id}

        # Get paper info
        paper = fetchrow("SELECT title, filename, authors FROM papers WHERE id = $1", paper_id)
        if not paper:
            raise ValueError(f"Paper {paper_id} not found")

        title = paper["title"] or paper["filename"]

        # Get chunks ordered by section
        rows = fetch(
            """SELECT section, content FROM chunks
               WHERE paper_id = $1 ORDER BY chunk_index LIMIT 30""",
            paper_id,
        )

        if not rows:
            raise ValueError(f"No chunks found for paper {paper_id}")

        chunks_text = "\n\n".join(
            f"[{row['section'].upper()}]\n{row['content']}" for row in rows
        )

        # Generate summary
        self.update_state(state="PROGRESS", meta={"step": "generating", "paper_id": paper_id})

        prompt = PAPER_SUMMARY_PROMPT.format(title=title, chunks=chunks_text[:8000])
        result = claude_client.generate_persona_post_sync(PAPER_SUMMARY_SYSTEM, prompt)

        # Result should be a list, but generate_persona_post_sync returns a dict.
        # Re-parse: the LLM should return a JSON array. Explicit max_tokens=1536
        # caps the generated length — summary should comfortably fit, and this
        # guards against runaway output if the LLM gets chatty on a big corpus.
        # generate_text_sync routes through the persistent loop in claude_client
        # so httpx clients don't get GC'd on a dead loop (BUG-LIVE-06).
        raw_text = claude_client.generate_text_sync(
            PAPER_SUMMARY_SYSTEM, prompt, max_tokens=1536,
        )

        import re
        cleaned = re.sub(r'<think>.*?</think>', '', raw_text, flags=re.DOTALL).strip()

        messages: list[dict[str, str]] = []
        try:
            # Try to find JSON array
            match = re.search(r'\[.*\]', cleaned, re.DOTALL)
            if match:
                messages = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            log.warn("summary_parse_failed", preview=cleaned[:200])
            # Fallback: wrap raw text as a single message
            messages = [{"role": "paper", "type": "summary", "content": cleaned}]

        # Store
        messages_json = json.dumps(messages, default=str)
        execute(
            """INSERT INTO paper_summaries (paper_id, messages, status, task_id)
               VALUES ($1, $2, 'complete', NULL)
               ON CONFLICT (paper_id) DO UPDATE SET messages = $2, status = 'complete', task_id = NULL, generated_at = NOW()""",
            paper_id, messages_json,
        )

        log.info("paper_summary_complete", messages=len(messages))
        return {"status": "complete", "paper_id": paper_id, "message_count": len(messages)}

    except Exception as exc:
        log.error("paper_summary_failed", error=str(exc))
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise


@app.task(
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    name="tasks.summary_tasks.generate_corpus_synthesis",
)
def generate_corpus_synthesis(
    self: Task, synthesis_id: str, paper_ids: list[str], name: str, user_id: str
) -> dict[str, object]:
    """Generate a group chat synthesis across multiple papers."""
    log = logger.bind(synthesis_id=synthesis_id, task_id=self.request.id)
    log.info("corpus_synthesis_start", papers=len(paper_ids))

    try:
        # Gather key chunks from each paper
        paper_sections: list[str] = []
        for pid in paper_ids:
            paper = fetchrow("SELECT title, filename, authors FROM papers WHERE id = $1", pid)
            if not paper:
                continue

            title = paper["title"] or paper["filename"]
            rows = fetch(
                """SELECT section, content FROM chunks
                   WHERE paper_id = $1 ORDER BY chunk_index LIMIT 10""",
                pid,
            )
            if rows:
                chunks_text = "\n".join(f"[{r['section']}] {r['content'][:300]}" for r in rows)
                paper_sections.append(f"=== {title} ===\n{chunks_text}")

        if not paper_sections:
            raise ValueError("No chunks found for any of the papers")

        combined = "\n\n".join(paper_sections)

        # Generate synthesis
        self.update_state(state="PROGRESS", meta={"step": "synthesizing", "synthesis_id": synthesis_id})

        prompt = SYNTHESIS_PROMPT.format(paper_chunks=combined[:10000])
        # Via persistent-loop wrapper so httpx doesn't re-spin a loop per call.
        raw_text = claude_client.generate_text_sync(SYNTHESIS_SYSTEM, prompt)

        import re
        cleaned = re.sub(r'<think>.*?</think>', '', raw_text, flags=re.DOTALL).strip()

        messages: list[dict[str, str]] = []
        try:
            match = re.search(r'\[.*\]', cleaned, re.DOTALL)
            if match:
                messages = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            log.warn("synthesis_parse_failed", preview=cleaned[:200])
            messages = [{"role": "synthesis", "type": "summary", "content": cleaned}]

        # Store
        messages_json = json.dumps(messages, default=str)
        execute(
            """INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages)
               VALUES ($1, $2, $3, $4, $5)""",
            synthesis_id, user_id, name,
            paper_ids, messages_json,
        )

        log.info("corpus_synthesis_complete", messages=len(messages))
        return {"status": "complete", "synthesis_id": synthesis_id, "message_count": len(messages)}

    except Exception as exc:
        log.error("corpus_synthesis_failed", error=str(exc))
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise
