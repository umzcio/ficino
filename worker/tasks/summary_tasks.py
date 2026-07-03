"""Paper summary and corpus synthesis generation tasks."""

import json

import structlog
from celery import Task

from celery_app import app
from lib import claude_client
from lib.db import execute, fetch, fetchrow
from lib.sanitize import fence_untrusted
from lib.settings import apply_provider_settings, STUB_USER_ID

logger = structlog.get_logger(__name__)


def _coerce_messages(parsed: object) -> list[dict]:
    """Filter a parsed JSON value down to well-shaped message dicts.

    LLM output that parses as JSON but isn't the expected list-of-message-
    dicts shape (e.g. a bare array of strings) must not persist as-is —
    frontend consumers read message.role / message.content, and a
    non-dict element renders empty or crashes. Elements that aren't dicts,
    or whose "content" isn't a non-empty string, are dropped. Callers run
    this BEFORE their existing `if not messages:` fallback, so a fully
    wrong-shaped array falls through to the single-bubble fallback instead
    of persisting an empty or malformed list (R10 WORK-8).
    """
    if not isinstance(parsed, list):
        return []
    return [
        m for m in parsed
        if isinstance(m, dict) and isinstance(m.get("content"), str) and m.get("content")
    ]


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
        # Check if a completed summary already exists. The previous guard
        # treated status=NULL or status="error" as "complete" (via the
        # `(status or "complete")` default), which blocked retries after a
        # transient failure from ever regenerating. Now only an explicitly
        # "complete" row short-circuits; "error" and NULL fall through to
        # regenerate, and "generating" checks task_id so a Celery retry of
        # the same task can resume, while a different task_id means another
        # worker is actively producing the summary — bail to avoid a race.
        existing = fetchrow("SELECT id, status, task_id FROM paper_summaries WHERE paper_id = $1", paper_id)
        if existing:
            status = existing.get("status")
            if status == "complete":
                log.info("paper_summary_exists")
                return {"status": "exists", "paper_id": paper_id}
            if status == "generating":
                existing_task_id = existing.get("task_id")
                if existing_task_id and existing_task_id != self.request.id:
                    log.info(
                        "paper_summary_already_generating",
                        other_task_id=existing_task_id,
                    )
                    return {"status": "already_generating", "paper_id": paper_id}
                # Same task retrying after a mid-flight crash — fall through
                # and regenerate over the half-written row.

        # Get paper info — include user_id so the provider settings below
        # (LLM key, model choice) bill the paper owner, not whichever
        # user's config was cached in this Celery prefork child.
        paper = fetchrow(
            "SELECT title, filename, authors, user_id FROM papers WHERE id = $1",
            paper_id,
        )
        if not paper:
            raise ValueError(f"Paper {paper_id} not found")

        paper_user_id = str(paper["user_id"]) if paper["user_id"] else STUB_USER_ID
        apply_provider_settings(paper_user_id)

        title = paper["title"] or paper["filename"]

        # Get chunks ordered by section
        rows = fetch(
            """SELECT section, content FROM chunks
               WHERE paper_id = $1 ORDER BY chunk_index LIMIT 30""",
            paper_id,
        )

        if not rows:
            raise ValueError(f"No chunks found for paper {paper_id}")

        # Chunk content + title are PDF-origin and must be treated as untrusted
        # so a hostile document can't reshape the summarizer prompt.
        chunks_text = "\n\n".join(
            f"[{row['section'].upper()}]\n{fence_untrusted(str(row['content']))}"
            for row in rows
        )
        fenced_title = fence_untrusted(str(title))

        # Generate summary
        self.update_state(state="PROGRESS", meta={"step": "generating", "paper_id": paper_id})

        prompt = PAPER_SUMMARY_PROMPT.format(title=fenced_title, chunks=chunks_text[:8000])
        # Single LLM call — prior code also invoked generate_persona_post_sync
        # before this, discarded the result, and re-ran generate_text_sync.
        # That doubled cost on Claude API without using the first result.
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
                messages = _coerce_messages(json.loads(match.group(0)))
        except (json.JSONDecodeError, ValueError):
            log.warning("summary_parse_failed", preview=cleaned[:200])
            # Fallback: wrap raw text as a single message
            messages = [{"role": "paper", "type": "summary", "content": cleaned}]

        # A "success path with no brackets" (response truncation or prose-only
        # output) falls out of the try block with messages==[] but never hits
        # the except — apply the same fallback explicitly so we never store
        # status='complete' with an empty message list (which the GET handler
        # would short-circuit forever without a path to regenerate).
        if not messages:
            log.warning("summary_parse_empty", preview=cleaned[:200])
            messages = [{"role": "paper", "type": "summary", "content": cleaned or "(no content returned)"}]

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
        # Retries exhausted — mark the placeholder row so the GET handler
        # can re-dispatch on the next poll instead of spinning forever on a
        # status='generating' row with a dead task_id.
        try:
            execute(
                """UPDATE paper_summaries
                   SET status = 'error', task_id = NULL
                   WHERE paper_id = $1""",
                paper_id,
            )
        except Exception as update_exc:
            log.error("paper_summary_error_mark_failed", error=str(update_exc))
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
        # Short-circuit if a prior run already produced non-empty messages
        # for this synthesis. The outer POST handler allocates the
        # synthesis_id up front, so a retry after the LLM call succeeded
        # but a downstream step crashed would otherwise re-spend on the
        # synthesis and write over the completed row.
        existing = fetchrow(
            "SELECT messages FROM corpus_syntheses WHERE id = $1",
            synthesis_id,
        )
        if existing:
            existing_messages = existing["messages"]
            if isinstance(existing_messages, str):
                existing_messages = json.loads(existing_messages)
            if existing_messages:
                log.info("corpus_synthesis_idempotent_skip", messages=len(existing_messages))
                return {
                    "status": "complete",
                    "synthesis_id": synthesis_id,
                    "message_count": len(existing_messages),
                    "idempotent": True,
                }

        # Scope provider settings to the requesting user so the multi-paper
        # Claude call bills their keys, not whichever user's config is
        # cached in this Celery prefork child from a prior task.
        apply_provider_settings(user_id)

        # Gather key chunks from every paper in one SQL — the previous
        # code did 2 round-trips per paper (paper metadata + chunks) in a
        # Python loop, so a 10-paper synthesis = 20 RTT before the single
        # Claude call. One LATERAL-joined aggregate instead.
        paper_rows = fetch(
            """SELECT p.id, p.title, p.filename,
                      COALESCE(c.sections, ARRAY[]::text[]) AS sections,
                      COALESCE(c.contents, ARRAY[]::text[]) AS contents
               FROM papers p
               LEFT JOIN LATERAL (
                 SELECT array_agg(section ORDER BY chunk_index) AS sections,
                        array_agg(content ORDER BY chunk_index) AS contents
                 FROM (
                   SELECT section, content, chunk_index FROM chunks
                   WHERE paper_id = p.id
                   ORDER BY chunk_index
                   LIMIT 10
                 ) s
               ) c ON true
               WHERE p.id = ANY($1::uuid[])""",
            paper_ids,
        )
        paper_sections: list[str] = []
        for paper in paper_rows:
            sections = paper["sections"] or []
            contents = paper["contents"] or []
            if not contents:
                continue
            title = paper["title"] or paper["filename"]
            fenced_title = fence_untrusted(str(title))
            chunks_text = "\n".join(
                f"[{section}]\n{fence_untrusted(str(content)[:300])}"
                for section, content in zip(sections, contents)
            )
            paper_sections.append(f"=== {fenced_title} ===\n{chunks_text}")

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
                messages = _coerce_messages(json.loads(match.group(0)))
        except (json.JSONDecodeError, ValueError):
            log.warning("synthesis_parse_failed", preview=cleaned[:200])
            messages = [{"role": "synthesis", "type": "summary", "content": cleaned}]

        # If the regex didn't match at all (not a parse failure, just no
        # JSON array in the LLM output), we'd previously persist messages=[]
        # and leave the user staring at an empty group chat. Mirror the
        # paper-summary fallback instead.
        if not messages:
            messages = [{
                "role": "synthesis",
                "type": "summary",
                "content": cleaned or "(no content)",
            }]

        # Store. ON CONFLICT ensures that a retry after the INSERT succeeded
        # but a post-INSERT step crashed doesn't raise UniqueViolationError
        # (the synthesis_id is allocated by the API and stays stable across
        # retries) — the earlier idempotency guard catches the already-
        # complete case, so this handles only the partial-write path.
        messages_json = json.dumps(messages, default=str)
        execute(
            """INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO UPDATE SET
                 messages = EXCLUDED.messages,
                 generated_at = NOW()""",
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
