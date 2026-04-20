"""Reading list endpoints — curated paper sequences with guided discourse."""

import json

import asyncpg
import structlog
from celery import Celery
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from audit import record_audit
from config import settings
from auth import AuthUser, get_current_user
from auth.rate_limit import RateLimit
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/reading-lists", tags=["reading-lists"])


def _get_celery() -> Celery:
    return Celery(broker=settings.redis_url, backend=settings.redis_url)


class ReadingListCreate(BaseModel):
    name: str
    corpus_id: str | None = None
    paper_ids: list[str] | None = None  # if None, use all papers in corpus


class ReadingListReorder(BaseModel):
    paper_sequence: list[str]


@router.get("")
async def list_reading_lists(
    workspace_id: str | None = None,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List reading lists, optionally scoped to a workspace.

    One aggregate query with LEFT JOIN + COUNT FILTER replaces the previous
    2× fetchval-per-row N+1. At 10 lists that was 21 round trips every time
    the view mounted or refreshed; now it's 1.
    """
    base_sql = """
        SELECT rl.id, rl.name, rl.paper_sequence, rl.rationale, rl.created_at,
               COUNT(rlc.id) AS chapter_count,
               COUNT(rlc.id) FILTER (WHERE rlc.status = 'complete') AS completed
        FROM reading_lists rl
        LEFT JOIN reading_list_chapters rlc ON rlc.reading_list_id = rl.id
        WHERE rl.user_id = $1
    """
    if workspace_id:
        rows = await db.fetch(
            base_sql + " AND rl.corpus_id = $2 GROUP BY rl.id ORDER BY rl.created_at DESC",
            user.id, workspace_id,
        )
    else:
        rows = await db.fetch(
            base_sql + " GROUP BY rl.id ORDER BY rl.created_at DESC",
            user.id,
        )

    results = []
    for row in rows:
        rationale = row["rationale"]
        if isinstance(rationale, str):
            rationale = json.loads(rationale)
        results.append({
            "id": str(row["id"]),
            "name": row["name"],
            "paper_count": len(row["paper_sequence"] or []),
            "chapter_count": row["chapter_count"],
            "completed_chapters": row["completed"],
            "rationale": rationale,
            "created_at": row["created_at"],
        })
    return results


@router.get("/{list_id}")
async def get_reading_list(
    list_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get a reading list with its chapters and paper details."""
    row = await db.fetchrow(
        "SELECT id, name, corpus_id, paper_sequence, rationale, created_at FROM reading_lists WHERE id = $1 AND user_id = $2",
        list_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Reading list not found")

    rationale = row["rationale"]
    if isinstance(rationale, str):
        rationale = json.loads(rationale)

    # Get paper details in sequence order. Guard against an empty sequence
    # so the SQL below doesn't produce `WHERE id IN ()` which Postgres rejects.
    # Defense-in-depth: re-scope the fetch to user.id even though the parent
    # reading_lists row is already user-owned — this prevents a stored
    # foreign paper_id (from a prior-era bug or a restored-from-backup row)
    # from leaking another user's title/authors into this response.
    paper_ids = [str(p) for p in (row["paper_sequence"] or [])]
    papers = []
    if paper_ids:
        placeholders = ",".join(f"${i+1}" for i in range(len(paper_ids)))
        user_placeholder = f"${len(paper_ids) + 1}"
        paper_rows = await db.fetch(
            f"SELECT id, title, authors, year, filename FROM papers "
            f"WHERE id IN ({placeholders}) AND user_id = {user_placeholder}",
            *paper_ids,
            user.id,
        )
        paper_map = {str(r["id"]): r for r in paper_rows}
        for pid in paper_ids:
            p = paper_map.get(pid)
            if p:
                # Find rationale for this paper
                paper_rationale = ""
                for r in rationale:
                    if r.get("paper_id") == pid:
                        paper_rationale = r.get("rationale", "")
                        break
                papers.append({
                    "id": str(p["id"]),
                    "title": p["title"] or p["filename"],
                    "authors": p["authors"] or [],
                    "year": p["year"],
                    "rationale": paper_rationale,
                })

    # Get chapters
    chapter_rows = await db.fetch(
        """SELECT id, chapter_index, paper_ids, feed_id, status, created_at
           FROM reading_list_chapters WHERE reading_list_id = $1 ORDER BY chapter_index""",
        list_id,
    )
    chapters = []
    for ch in chapter_rows:
        chapters.append({
            "id": str(ch["id"]),
            "chapter_index": ch["chapter_index"],
            "paper_ids": [str(p) for p in (ch["paper_ids"] or [])],
            "feed_id": str(ch["feed_id"]) if ch["feed_id"] else None,
            "status": ch["status"],
        })

    return {
        "id": str(row["id"]),
        "name": row["name"],
        "corpus_id": str(row["corpus_id"]) if row["corpus_id"] else None,
        "papers": papers,
        "chapters": chapters,
        "created_at": row["created_at"],
    }


@router.post("", status_code=201)
async def create_reading_list(
    body: ReadingListCreate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
    _rl: None = Depends(RateLimit("feed_generation", settings.rate_limit_generations_per_day)),
) -> dict[str, object]:
    """Create a reading list. Dispatches AI ordering if paper_ids provided."""
    # If a corpus_id is supplied, verify it belongs to the caller before using it.
    if body.corpus_id:
        owned_corpus = await db.fetchrow(
            "SELECT id FROM corpora WHERE id = $1 AND user_id = $2",
            body.corpus_id, user.id,
        )
        if not owned_corpus:
            raise HTTPException(status_code=404, detail="Workspace not found")

    # Get paper IDs
    if body.paper_ids:
        # Verify every paper in the explicit list belongs to the caller.
        # Using ANY($1::uuid[]) keeps this a single round-trip.
        owned_count = await db.fetchval(
            "SELECT COUNT(*) FROM papers WHERE id = ANY($1::uuid[]) AND user_id = $2",
            body.paper_ids, user.id,
        )
        if owned_count != len(body.paper_ids):
            raise HTTPException(
                status_code=404,
                detail="One or more papers not found",
            )
        paper_ids = body.paper_ids
    elif body.corpus_id:
        rows = await db.fetch(
            "SELECT id FROM papers WHERE corpus_id = $1 AND user_id = $2 AND status = 'complete' ORDER BY uploaded_at",
            body.corpus_id, user.id,
        )
        paper_ids = [str(r["id"]) for r in rows]
    else:
        raise HTTPException(status_code=400, detail="Provide paper_ids or corpus_id")

    if len(paper_ids) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 papers for a reading list")

    # Create the reading list with papers in upload order initially
    row = await db.fetchrow(
        """INSERT INTO reading_lists (user_id, corpus_id, name, paper_sequence)
           VALUES ($1, $2, $3, $4) RETURNING id""",
        user.id, body.corpus_id, body.name, paper_ids,
    )
    list_id = str(row["id"])

    # Create one chapter per paper in a single statement. The previous
    # Python-loop version was N serial INSERTs — a 20-paper list = 20
    # sequential RTT before the Celery dispatch. unnest WITH ORDINALITY
    # keeps the per-paper chapter_index deterministic.
    await db.execute(
        """INSERT INTO reading_list_chapters
             (reading_list_id, chapter_index, paper_ids, status)
           SELECT $1::uuid,
                  (row_num - 1)::int,
                  ARRAY[pid]::uuid[],
                  CASE WHEN row_num = 1 THEN 'unlocked' ELSE 'locked' END
           FROM unnest($2::uuid[]) WITH ORDINALITY AS t(pid, row_num)""",
        list_id, paper_ids,
    )

    # Dispatch AI ordering. The worker persists the result directly into
    # reading_lists.{rationale, paper_sequence} so the frontend's polling
    # loop (watching for `rationale` to appear) exits. Without list_id the
    # ordering would just sit in Celery's result backend unused.
    celery_app = _get_celery()
    task = celery_app.send_task(
        "tasks.reading_list_tasks.propose_ordering",
        args=[paper_ids, body.corpus_id, list_id],
        kwargs={"user_id": user.id},
        queue="persona",
    )

    logger.info("reading_list_created", list_id=list_id, papers=len(paper_ids), task_id=task.id)
    return {"id": list_id, "task_id": task.id, "paper_count": len(paper_ids)}


@router.put("/{list_id}/reorder")
async def reorder_reading_list(
    list_id: str,
    body: ReadingListReorder,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Reorder papers in a reading list. Rebuilds chapters."""
    row = await db.fetchrow(
        "SELECT id FROM reading_lists WHERE id = $1 AND user_id = $2",
        list_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Reading list not found")

    # Verify every paper_id in the new sequence belongs to the caller —
    # otherwise a reorder can slip a foreign paper_id into this user's
    # reading list (which downstream chapter generation will happily
    # dereference).
    if body.paper_sequence:
        owned_count = await db.fetchval(
            "SELECT COUNT(*) FROM papers WHERE id = ANY($1::uuid[]) AND user_id = $2",
            body.paper_sequence, user.id,
        )
        if owned_count != len(set(body.paper_sequence)):
            raise HTTPException(
                status_code=404,
                detail="One or more papers not found",
            )

    # Update sequence
    await db.execute(
        "UPDATE reading_lists SET paper_sequence = $1 WHERE id = $2",
        body.paper_sequence, list_id,
    )

    # Delete existing chapters (only non-complete ones to preserve generated feeds)
    await db.execute(
        "DELETE FROM reading_list_chapters WHERE reading_list_id = $1 AND feed_id IS NULL",
        list_id,
    )

    # Get highest completed chapter index
    max_complete = await db.fetchval(
        "SELECT COALESCE(MAX(chapter_index), -1) FROM reading_list_chapters WHERE reading_list_id = $1 AND status = 'complete'",
        list_id,
    )

    # Recreate chapters for remaining papers
    for i, pid in enumerate(body.paper_sequence):
        if i <= max_complete:
            continue  # Skip already-completed chapters
        exists = await db.fetchrow(
            "SELECT id FROM reading_list_chapters WHERE reading_list_id = $1 AND chapter_index = $2",
            list_id, i,
        )
        if not exists:
            await db.execute(
                """INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
                   VALUES ($1, $2, $3, $4)""",
                list_id, i, [pid], "unlocked" if i == max_complete + 1 else "locked",
            )

    logger.info("reading_list_reordered", list_id=list_id)
    return {"status": "reordered"}


@router.put("/{list_id}/apply-ordering")
async def apply_ai_ordering(
    list_id: str,
    body: dict,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Apply AI-proposed ordering to a reading list. Called after ordering task completes."""
    row = await db.fetchrow(
        "SELECT id, paper_sequence FROM reading_lists WHERE id = $1 AND user_id = $2",
        list_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Reading list not found")

    ordered_papers = body.get("ordered_papers", [])
    if not ordered_papers:
        raise HTTPException(status_code=400, detail="No ordering data")

    new_sequence = [p["paper_id"] for p in ordered_papers]

    # The ordering must be a permutation of the list's existing papers —
    # a bad client (or a malicious one) shouldn't be able to inject foreign
    # paper IDs via this endpoint.
    existing_set = {str(p) for p in (row["paper_sequence"] or [])}
    if set(new_sequence) != existing_set:
        raise HTTPException(
            status_code=400,
            detail="Ordering must be a permutation of the existing paper list",
        )

    rationale_json = json.dumps(ordered_papers)

    await db.execute(
        "UPDATE reading_lists SET paper_sequence = $1, rationale = $2 WHERE id = $3",
        new_sequence, rationale_json, list_id,
    )

    # Rebuild chapters
    await db.execute(
        "DELETE FROM reading_list_chapters WHERE reading_list_id = $1",
        list_id,
    )
    for i, pid in enumerate(new_sequence):
        await db.execute(
            """INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
               VALUES ($1, $2, $3, $4)""",
            list_id, i, [pid], "unlocked" if i == 0 else "locked",
        )

    logger.info("ai_ordering_applied", list_id=list_id)
    return {"status": "applied"}


@router.post("/{list_id}/chapters/{chapter_index}/generate", status_code=202)
async def generate_chapter(
    list_id: str,
    chapter_index: int,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
    # Chapter generation fans out ~12 persona LLM calls per invocation —
    # the single biggest LLM spend amplifier in the app. Share the
    # generations budget with /feed/generate.
    _rl: None = Depends(RateLimit("feed_generation", settings.rate_limit_generations_per_day)),
) -> dict[str, str]:
    """Generate the feed for a chapter. Chapter must be unlocked or complete."""
    # Verify the reading list belongs to the user
    list_owner = await db.fetchrow(
        "SELECT id FROM reading_lists WHERE id = $1 AND user_id = $2",
        list_id, user.id,
    )
    if not list_owner:
        raise HTTPException(status_code=404, detail="Chapter not found")

    chapter = await db.fetchrow(
        """SELECT id, status FROM reading_list_chapters
           WHERE reading_list_id = $1 AND chapter_index = $2""",
        list_id, chapter_index,
    )
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    if chapter["status"] == "locked":
        raise HTTPException(status_code=400, detail="Chapter is locked. Complete prior chapters first.")

    celery_app = _get_celery()
    task = celery_app.send_task(
        "tasks.reading_list_tasks.generate_chapter",
        args=[list_id, chapter_index],
        kwargs={"user_id": user.id},
        queue="persona",
    )

    logger.info("chapter_generation_dispatched", list_id=list_id, chapter=chapter_index, task_id=task.id)
    return {"task_id": task.id, "status": "queued"}


@router.delete("/{list_id}", status_code=204)
async def delete_reading_list(
    list_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Delete a reading list and its chapters."""
    result = await db.execute(
        "DELETE FROM reading_lists WHERE id = $1 AND user_id = $2",
        list_id, user.id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Reading list not found")

    await record_audit(
        db, request, user,
        action="reading_list.delete", resource_type="reading_list", resource_id=list_id,
        status_code=204,
    )
