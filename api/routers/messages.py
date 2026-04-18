"""Paper summaries (DMs) and corpus syntheses (group chats) endpoints."""

import json
import uuid

import asyncpg
import structlog
from celery import Celery
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import settings
from auth import AuthUser, get_current_user
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/messages", tags=["messages"])


def _get_celery() -> Celery:
    return Celery(broker=settings.redis_url, backend=settings.redis_url)


# --- Paper Summaries (Individual DMs) ---

@router.get("/papers")
async def list_paper_conversations(
    workspace_id: str | None = None,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all papers with their summary status (DM inbox), scoped to workspace.

    We project the last-message preview + message count in SQL instead of
    shipping the whole `ps.messages` JSONB — a user with 200 papers and
    multi-turn transcripts would otherwise transfer megabytes per tab-open
    just to render an 80-char preview.
    """
    # `messages->-1->>'content'` reaches the last element's content field
    # directly; jsonb_array_length gives us the count without streaming the
    # array. LIMIT 200 caps payload size and ORDER BY uses papers(uploaded_at).
    projection = """p.id, p.title, p.filename, p.authors, p.chunk_count, p.figure_count,
                    p.uploaded_at, ps.id AS summary_id, ps.generated_at AS summary_generated_at,
                    COALESCE((ps.messages->-1->>'content'), '') AS last_msg_content,
                    COALESCE(jsonb_array_length(ps.messages), 0) AS message_count"""
    if workspace_id:
        rows = await db.fetch(
            f"""SELECT {projection}
               FROM papers p
               LEFT JOIN paper_summaries ps ON p.id = ps.paper_id
               WHERE p.status = 'complete' AND p.user_id = $1 AND p.corpus_id = $2
               ORDER BY p.uploaded_at DESC
               LIMIT 200""",
            user.id, workspace_id,
        )
    else:
        rows = await db.fetch(
            f"""SELECT {projection}
               FROM papers p
               LEFT JOIN paper_summaries ps ON p.id = ps.paper_id
               WHERE p.status = 'complete' AND p.user_id = $1
               ORDER BY p.uploaded_at DESC
               LIMIT 200""",
            user.id,
        )
    result = []
    for row in rows:
        last = row["last_msg_content"] or None
        result.append({
            "paper_id": str(row["id"]),
            "title": row["title"] or row["filename"],
            "authors": row["authors"] or [],
            "chunk_count": row["chunk_count"],
            "has_summary": row["summary_id"] is not None,
            "summary_generated_at": row["summary_generated_at"],
            "last_message_preview": last[:80] if last else None,
            "message_count": row["message_count"],
            "uploaded_at": row["uploaded_at"],
        })
    return result


@router.get("/papers/tldrs")
async def get_paper_tldrs(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Return paper_id → TL;DR mapping for all completed summaries.

    Projects `messages->0->>'content'` in SQL instead of shipping the whole
    multi-turn transcript just to slice the first 200 chars — this endpoint
    is called from App.tsx on mount AND on every ingestion completion.
    """
    rows = await db.fetch(
        """SELECT ps.paper_id,
                  LEFT(COALESCE(ps.messages->0->>'content', ''), 200) AS tldr
           FROM paper_summaries ps
           JOIN papers p ON ps.paper_id = p.id AND p.user_id = $1
           WHERE ps.status = 'complete' AND jsonb_array_length(ps.messages) > 0""",
        user.id,
    )
    return {str(row["paper_id"]): row["tldr"] for row in rows if row["tldr"]}


@router.get("/papers/{paper_id}")
async def get_paper_summary(
    paper_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get or trigger generation of a paper summary."""
    # Check paper exists and belongs to user
    paper = await db.fetchrow(
        "SELECT id, title, filename, authors FROM papers WHERE id = $1 AND user_id = $2 AND status = 'complete'",
        paper_id, user.id,
    )
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found or not processed")

    # Check for existing summary
    summary = await db.fetchrow(
        "SELECT messages, generated_at, status, task_id FROM paper_summaries WHERE paper_id = $1",
        paper_id,
    )

    # Workers can die mid-task (OOM, SIGKILL, container restart) without
    # writing back a terminal status. If the row says 'generating' but the
    # task is actually FAILURE/REVOKED/unknown, re-dispatch rather than
    # stranding the user on a forever-spinner.
    celery_app = _get_celery()
    if summary and (summary["status"] or "complete") == "generating" and summary["task_id"]:
        try:
            task_state = celery_app.AsyncResult(summary["task_id"]).state
        except Exception:
            task_state = "UNKNOWN"
        if task_state in ("FAILURE", "REVOKED", "UNKNOWN"):
            logger.warn(
                "paper_summary_stuck_generating",
                paper_id=paper_id,
                old_task_id=summary["task_id"],
                task_state=task_state,
            )
            summary = None  # fall through to the dispatch branch below

    if summary:
        messages = summary["messages"]
        if isinstance(messages, str):
            messages = json.loads(messages)
        status = summary["status"] or "complete"
        result: dict[str, object] = {
            "paper_id": paper_id,
            "title": paper["title"] or paper["filename"],
            "authors": paper["authors"] or [],
            "messages": messages,
            "generated_at": summary["generated_at"],
            "status": status,
        }
        if status == "generating" and summary["task_id"]:
            result["task_id"] = summary["task_id"]
        return result

    # No (usable) summary yet — trigger generation and create placeholder row
    task = celery_app.send_task(
        "tasks.summary_tasks.generate_paper_summary",
        args=[paper_id],
        queue="persona",
    )
    logger.info("paper_summary_dispatched", paper_id=paper_id, task_id=task.id)

    await db.execute(
        """INSERT INTO paper_summaries (paper_id, messages, status, task_id)
           VALUES ($1, '[]', 'generating', $2)
           ON CONFLICT (paper_id) DO UPDATE SET status = 'generating', task_id = $2""",
        paper_id, task.id,
    )

    return {
        "paper_id": paper_id,
        "title": paper["title"] or paper["filename"],
        "authors": paper["authors"] or [],
        "messages": [],
        "status": "generating",
        "task_id": task.id,
    }


@router.get("/papers/{paper_id}/status/{task_id}")
async def get_paper_summary_status(
    paper_id: str,
    task_id: str,
    user: AuthUser = Depends(get_current_user),
) -> dict[str, object]:
    """Poll summary generation status.

    Auth-gated (no task-id ownership check): task IDs are opaque but leaving
    this open lets anyone with network visibility poll for completion.
    """
    celery_app = _get_celery()
    result = celery_app.AsyncResult(task_id)

    if result.state == "SUCCESS":
        return {"status": "complete", "paper_id": paper_id}
    elif result.state == "FAILURE":
        return {"status": "error", "error": str(result.result)}
    else:
        return {"status": "generating"}


# --- Corpus Syntheses (Group Chats) ---

class SynthesisCreateRequest(BaseModel):
    name: str
    paper_ids: list[str]


@router.get("/groups")
async def list_group_chats(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all corpus synthesis group chats.

    Projects the preview + counts in SQL so multi-paper synthesis transcripts
    (which can be long) don't stream over the wire per tab-open. LIMIT 50
    caps payload for users with lots of group chats.
    """
    rows = await db.fetch(
        """SELECT id, name,
                  COALESCE(array_length(paper_ids, 1), 0) AS paper_count,
                  COALESCE(jsonb_array_length(messages), 0) AS message_count,
                  LEFT(COALESCE(messages->-1->>'content', ''), 80) AS last_msg,
                  generated_at
           FROM corpus_syntheses
           WHERE user_id = $1
           ORDER BY generated_at DESC
           LIMIT 50""",
        user.id,
    )
    return [
        {
            "id": str(row["id"]),
            "name": row["name"],
            "paper_count": row["paper_count"],
            "message_count": row["message_count"],
            "last_message_preview": row["last_msg"] or None,
            "generated_at": row["generated_at"],
        }
        for row in rows
    ]


@router.post("/groups", status_code=202)
async def create_group_chat(
    body: SynthesisCreateRequest,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Create a new corpus synthesis group chat."""
    if len(body.paper_ids) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 papers for a group chat")

    # Verify every supplied paper_id belongs to the caller. Without this,
    # a user can synthesize across another user's corpus and receive chunks
    # from it in the resulting group chat.
    owned_count = await db.fetchval(
        "SELECT COUNT(*) FROM papers WHERE id = ANY($1::uuid[]) AND user_id = $2",
        body.paper_ids, user.id,
    )
    if owned_count != len(body.paper_ids):
        raise HTTPException(status_code=404, detail="One or more papers not found")

    synthesis_id = str(uuid.uuid4())
    user_id = user.id

    celery_app = _get_celery()
    task = celery_app.send_task(
        "tasks.summary_tasks.generate_corpus_synthesis",
        args=[synthesis_id, body.paper_ids, body.name, user_id],
        queue="persona",
    )

    logger.info("corpus_synthesis_dispatched", synthesis_id=synthesis_id, task_id=task.id)
    return {"synthesis_id": synthesis_id, "task_id": task.id, "status": "generating"}


@router.get("/groups/{synthesis_id}")
async def get_group_chat(
    synthesis_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get a corpus synthesis group chat."""
    row = await db.fetchrow(
        "SELECT id, name, paper_ids, messages, generated_at FROM corpus_syntheses WHERE id = $1 AND user_id = $2",
        synthesis_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Group chat not found")

    messages = row["messages"] if isinstance(row["messages"], list) else json.loads(row["messages"])

    # Get paper titles
    paper_rows = await db.fetch(
        "SELECT id, title, filename FROM papers WHERE id = ANY($1)",
        row["paper_ids"],
    )
    papers = {str(r["id"]): r["title"] or r["filename"] for r in paper_rows}

    return {
        "id": str(row["id"]),
        "name": row["name"],
        "papers": papers,
        "messages": messages,
        "generated_at": row["generated_at"],
    }
