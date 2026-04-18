"""Paper upload, list, and management endpoints."""

import os
import uuid
from datetime import datetime, timezone

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from redis import Redis

from audit import record_audit
from config import settings
from auth import AuthUser, get_current_user
from auth.rate_limit import RateLimit
from constants import DEFAULT_WORKSPACE_ID
from db.connection import get_db
from models.paper import Paper
from signed_url import sign_resource

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/papers", tags=["papers"])

UPLOAD_DIR = settings.upload_dir


def _get_redis() -> Redis:
    return Redis.from_url(settings.redis_url)


@router.post("", response_model=Paper, status_code=201)
async def upload_paper(
    file: UploadFile,
    workspace_id: str | None = None,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
    _rl: None = Depends(RateLimit("paper_upload", settings.rate_limit_uploads_per_day)),
) -> Paper:
    """Upload a PDF paper for processing."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    # Check file size
    contents = await file.read()
    if len(contents) > settings.max_upload_size_mb * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"File exceeds {settings.max_upload_size_mb}MB limit")

    # Verify PDF magic bytes — an .pdf extension alone is trivially spoofable.
    if not contents.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="File is not a valid PDF (magic bytes missing)")

    paper_id = str(uuid.uuid4())
    file_path = os.path.join(UPLOAD_DIR, f"{paper_id}.pdf")

    # Use provided workspace or default
    corpus_id = workspace_id or DEFAULT_WORKSPACE_ID

    # Validate workspace exists AND belongs to the caller — prevents uploading
    # into someone else's workspace by guessing UUIDs.
    workspace_exists = await db.fetchrow(
        "SELECT id FROM corpora WHERE id = $1 AND user_id = $2",
        corpus_id, user.id,
    )
    if not workspace_exists:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # DB-row-first ordering: insert the paper placeholder BEFORE writing the
    # file to disk. If the process crashes between the row and the write,
    # the paper row is queryable (status='pending') and can be reconciled /
    # deleted by an operator — we never leave an orphan PDF on disk with no
    # database trace. If the row insert itself fails (FK violation on a bad
    # workspace), no file exists yet, so there's nothing to clean up.
    now = datetime.now(timezone.utc)
    try:
        await db.execute(
            """INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status, uploaded_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            paper_id, user.id, corpus_id, file.filename, file_path, "pending", now,
        )
    except asyncpg.ForeignKeyViolationError:
        raise HTTPException(status_code=400, detail="Invalid workspace")

    # Now write the file. If the write fails (disk full, permissions), delete
    # the placeholder row so we don't leave a dangling `pending` paper that
    # the worker will try to process and fail on repeatedly.
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    try:
        with open(file_path, "wb") as f:
            f.write(contents)
    except OSError:
        await db.execute(
            "DELETE FROM papers WHERE id = $1 AND user_id = $2",
            paper_id, user.id,
        )
        # Best-effort remove in case a partial file landed.
        try:
            os.remove(file_path)
        except OSError:
            pass
        logger.error("paper_upload_write_failed", paper_id=paper_id)
        raise HTTPException(status_code=500, detail="Failed to store uploaded file")

    logger.info("paper_uploaded", paper_id=paper_id, filename=file.filename, size=len(contents))

    # Dispatch Celery ingestion task
    redis = _get_redis()
    from celery import Celery
    celery_app = Celery(broker=settings.redis_url)
    celery_app.send_task(
        "tasks.ingestion_tasks.process_paper",
        args=[paper_id, file_path],
        queue="ingestion",
    )
    logger.info("ingestion_task_dispatched", paper_id=paper_id)

    return Paper(
        id=uuid.UUID(paper_id),
        user_id=uuid.UUID(user.id),
        filename=file.filename,
        status="pending",
        uploaded_at=now,
    )


@router.get("", response_model=list[Paper])
async def list_papers(
    workspace_id: str | None = None,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[Paper]:
    """List papers, optionally filtered by workspace."""
    if workspace_id:
        rows = await db.fetch(
            """SELECT p.id, p.user_id, p.corpus_id, p.title, p.authors, p.year, p.doi, p.filename,
                      p.status, p.extraction_path, p.error_message, p.chunk_count, p.figure_count,
                      p.uploaded_at, p.processed_at,
                      COALESCE(
                        json_agg(json_build_object('id', t.id::text, 'name', t.name))
                        FILTER (WHERE t.id IS NOT NULL), '[]'
                      ) AS tags
               FROM papers p
               LEFT JOIN paper_tags pt ON p.id = pt.paper_id
               LEFT JOIN tags t ON pt.tag_id = t.id
               WHERE p.user_id = $1 AND p.corpus_id = $2
               GROUP BY p.id
               ORDER BY p.uploaded_at DESC""",
            user.id, workspace_id,
        )
    else:
        rows = await db.fetch(
            """SELECT p.id, p.user_id, p.corpus_id, p.title, p.authors, p.year, p.doi, p.filename,
                      p.status, p.extraction_path, p.error_message, p.chunk_count, p.figure_count,
                      p.uploaded_at, p.processed_at,
                      COALESCE(
                        json_agg(json_build_object('id', t.id::text, 'name', t.name))
                        FILTER (WHERE t.id IS NOT NULL), '[]'
                      ) AS tags
               FROM papers p
               LEFT JOIN paper_tags pt ON p.id = pt.paper_id
               LEFT JOIN tags t ON pt.tag_id = t.id
               WHERE p.user_id = $1
               GROUP BY p.id
               ORDER BY p.uploaded_at DESC""",
            user.id,
        )
    papers = []
    for row in rows:
        import json as _json
        tags_data = row["tags"]
        if isinstance(tags_data, str):
            tags_data = _json.loads(tags_data)
        papers.append(Paper(
            id=row["id"],
            user_id=row["user_id"],
            corpus_id=row["corpus_id"],
            title=row["title"],
            authors=row["authors"] or [],
            year=row["year"],
            doi=row["doi"],
            filename=row["filename"],
            status=row["status"],
            extraction_path=row["extraction_path"],
            error_message=row["error_message"],
            chunk_count=row["chunk_count"] or 0,
            figure_count=row["figure_count"] or 0,
            tags=tags_data,
            uploaded_at=row["uploaded_at"],
            processed_at=row["processed_at"],
        ))
    return papers


@router.get("/{paper_id}", response_model=Paper)
async def get_paper(
    paper_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> Paper:
    """Get a specific paper by ID."""
    row = await db.fetchrow(
        """SELECT id, user_id, corpus_id, title, authors, year, doi, filename,
                  status, extraction_path, error_message, chunk_count, figure_count,
                  uploaded_at, processed_at
           FROM papers WHERE id = $1 AND user_id = $2""",
        paper_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Paper not found")

    return Paper(
        id=row["id"],
        user_id=row["user_id"],
        corpus_id=row["corpus_id"],
        title=row["title"],
        authors=row["authors"] or [],
        year=row["year"],
        doi=row["doi"],
        filename=row["filename"],
        status=row["status"],
        extraction_path=row["extraction_path"],
        error_message=row["error_message"],
        chunk_count=row["chunk_count"] or 0,
        figure_count=row["figure_count"] or 0,
        uploaded_at=row["uploaded_at"],
        processed_at=row["processed_at"],
    )


@router.delete("/{paper_id}", status_code=204)
async def delete_paper(
    paper_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> None:
    """Delete a paper and its associated chunks + feeds (ownership-scoped)."""
    # Single round-trip: verify ownership + return metadata + delete.
    row = await db.fetchrow(
        "DELETE FROM papers WHERE id = $1 AND user_id = $2 RETURNING corpus_id, filename",
        paper_id, user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Paper not found")

    corpus_id = row["corpus_id"]
    filename = row["filename"]

    # If this was the last paper in the workspace, drop its feeds so the UI
    # doesn't render dangling discourse. Alerts are user-scoped, not workspace-
    # scoped, so leave them alone.
    if corpus_id:
        remaining = await db.fetchval(
            "SELECT COUNT(*) FROM papers WHERE corpus_id = $1 AND user_id = $2",
            corpus_id, user.id,
        )
        if remaining == 0:
            await db.execute(
                "DELETE FROM feeds WHERE corpus_id = $1 AND user_id = $2",
                corpus_id, user.id,
            )
            logger.info("workspace_feeds_cleared", corpus_id=corpus_id)

    # Clean up uploaded file
    file_path = os.path.join(UPLOAD_DIR, f"{paper_id}.pdf")
    if os.path.exists(file_path):
        os.remove(file_path)

    logger.info("paper_deleted", paper_id=paper_id)

    await record_audit(
        db, request, user,
        action="paper.delete", resource_type="paper", resource_id=paper_id,
        metadata={
            "filename": filename,
            "corpus_id": str(corpus_id) if corpus_id else None,
        },
        status_code=204,
    )


@router.get("/{paper_id}/figures")
async def list_figures(
    paper_id: str,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List extracted figures for a paper."""
    rows = await db.fetch(
        """SELECT f.id, f.page_number, f.image_path, f.extraction_type,
                  f.description, f.claim_summary, f.figure_index
           FROM figures f
           JOIN papers p ON f.paper_id = p.id AND p.user_id = $2
           WHERE f.paper_id = $1 ORDER BY f.figure_index""",
        paper_id, user.id,
    )
    # Each URL carries a fresh short-lived (10 min) HMAC token. The handler
    # at GET /figures/{paper_id}/{figure_id} verifies the token AND that the
    # paper belongs to the caller, so leaking the URL cannot outlive the TTL
    # or cross-tenant.
    return [
        {
            "id": str(row["id"]),
            "page_number": row["page_number"],
            "image_url": (
                f"/figures/{paper_id}/{row['id']}"
                f"?token={sign_resource(str(row['id']))}"
            ),
            "extraction_type": row["extraction_type"],
            "description": row["description"],
            "claim_summary": row["claim_summary"],
            "figure_index": row["figure_index"],
        }
        for row in rows
    ]
