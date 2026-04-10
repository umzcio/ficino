"""Paper ingestion pipeline tasks.

Full pipeline: extract text → quality check → chunk → embed → store
With figure extraction running in parallel.
"""

import os

import structlog
from celery import Task

from celery_app import app
from lib import (
    chunker,
    embedder,
    marker_extractor,
    metadata_extractor,
    pdf_extractor,
    quality_check,
    vision_extractor,
    figure_describer,
)
from lib.db import execute, fetchrow, store_chunks_batch, store_figure

logger = structlog.get_logger(__name__)

EMBED_DIM = int(os.getenv("EMBED_DIM", "1024"))


def _update_paper_status(paper_id: str, status: str, **kwargs: object) -> None:
    """Update paper status in the database."""
    extra_sets = ""
    args: list[object] = [status, paper_id]
    idx = 3

    if "extraction_path" in kwargs:
        extra_sets += f", extraction_path = ${idx}"
        args.append(kwargs["extraction_path"])
        idx += 1
    if "error_message" in kwargs:
        extra_sets += f", error_message = ${idx}"
        args.append(kwargs["error_message"])
        idx += 1
    if "chunk_count" in kwargs:
        extra_sets += f", chunk_count = ${idx}"
        args.append(kwargs["chunk_count"])
        idx += 1
    if "figure_count" in kwargs:
        extra_sets += f", figure_count = ${idx}"
        args.append(kwargs["figure_count"])
        idx += 1
    if status == "complete":
        extra_sets += ", processed_at = NOW()"

    execute(
        f"UPDATE papers SET status = $1{extra_sets} WHERE id = $2",
        *args,
    )


@app.task(
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    name="tasks.ingestion_tasks.process_paper",
)
def process_paper(self: Task, paper_id: str, file_path: str) -> dict[str, str]:
    """Full ingestion pipeline for a single paper.

    Steps:
    1. Extract text (Marker → PyMuPDF → quality check → Vision fallback)
    2. Section-aware chunking
    3. Generate embeddings (Ollama or OpenAI)
    4. Store chunks + embeddings in pgvector
    5. Extract and describe figures
    """
    log = logger.bind(paper_id=paper_id, task_id=self.request.id)

    try:
        # --- Step 1: Text extraction ---
        self.update_state(state="PROGRESS", meta={"step": "extracting", "paper_id": paper_id})
        _update_paper_status(paper_id, "extracting")
        log.info("ingestion_step", step="extracting")

        extraction_path = "pymupdf_clean"
        markdown = ""

        # Try Marker first if available
        if marker_extractor.is_available():
            try:
                markdown = marker_extractor.extract_with_marker(file_path)
                extraction_path = "marker_clean"
            except Exception as e:
                log.warn("marker_failed", error=str(e))
                markdown = ""

        # Fall back to PyMuPDF
        if not markdown:
            markdown = pdf_extractor.extract_text_pymupdf(file_path)
            extraction_path = "pymupdf_clean"

        # --- Step 2: Quality check ---
        self.update_state(state="PROGRESS", meta={"step": "quality_checking", "paper_id": paper_id})
        log.info("ingestion_step", step="quality_checking")

        is_good, reason = quality_check.check_extraction_quality(markdown)

        if not is_good:
            log.warn("extraction_quality_failed", reason=reason)
            if vision_extractor.is_available():
                log.info("falling_back_to_vision")
                markdown = vision_extractor.extract_with_vision_sync(file_path)
                extraction_path = "vision_fallback"
            else:
                log.warn("no_vision_provider_available_using_raw_text")

        # --- Step 2b: Metadata extraction ---
        self.update_state(state="PROGRESS", meta={"step": "metadata", "paper_id": paper_id})
        log.info("ingestion_step", step="metadata")

        meta = metadata_extractor.extract_metadata_sync(markdown)
        if any([meta["title"], meta["authors"], meta["year"], meta["doi"]]):
            meta_sets: list[str] = []
            meta_args: list[object] = []
            idx = 1
            if meta["title"]:
                meta_sets.append(f"title = ${idx}")
                meta_args.append(meta["title"])
                idx += 1
            if meta["authors"]:
                meta_sets.append(f"authors = ${idx}")
                meta_args.append(meta["authors"])
                idx += 1
            if meta["year"]:
                meta_sets.append(f"year = ${idx}")
                meta_args.append(meta["year"])
                idx += 1
            if meta["doi"]:
                meta_sets.append(f"doi = ${idx}")
                meta_args.append(meta["doi"])
                idx += 1
            meta_args.append(paper_id)
            execute(
                f"UPDATE papers SET {', '.join(meta_sets)} WHERE id = ${idx}",
                *meta_args,
            )
            log.info("metadata_stored", title=meta.get("title"), authors=len(meta.get("authors", [])))

        # Auto-tag from extracted metadata
        auto_tags = meta.get("tags", [])
        if auto_tags:
            user_id = "00000000-0000-0000-0000-000000000000"
            for tag_name in auto_tags:
                try:
                    tag = fetchrow(
                        "SELECT id FROM tags WHERE user_id = $1 AND name = $2",
                        user_id, tag_name,
                    )
                    if not tag:
                        tag = fetchrow(
                            "INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id",
                            user_id, tag_name,
                        )
                    if tag:
                        execute(
                            "INSERT INTO paper_tags (paper_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                            paper_id, str(tag["id"]),
                        )
                except Exception as e:
                    log.warn("auto_tag_failed", tag=tag_name, error=str(e))
            log.info("auto_tags_assigned", tags=auto_tags)

        # --- Step 3: Chunking ---
        self.update_state(state="PROGRESS", meta={"step": "chunking", "paper_id": paper_id})
        _update_paper_status(paper_id, "chunking")
        log.info("ingestion_step", step="chunking")

        chunks = chunker.chunk_markdown(markdown)
        log.info("chunks_created", count=len(chunks))

        # --- Step 4: Embedding ---
        self.update_state(state="PROGRESS", meta={"step": "embedding", "paper_id": paper_id})
        _update_paper_status(paper_id, "embedding")
        log.info("ingestion_step", step="embedding")

        if chunks:
            chunk_texts = [str(c["content"]) for c in chunks]
            embeddings = embedder.embed_texts_sync(chunk_texts)
        else:
            embeddings = []

        # --- Step 5: Store chunks ---
        stored = store_chunks_batch(paper_id, chunks, embeddings)
        log.info("chunks_stored", count=stored)

        # --- Step 6: Figure extraction ---
        self.update_state(state="PROGRESS", meta={"step": "extracting_figures", "paper_id": paper_id})
        log.info("ingestion_step", step="extracting_figures")

        figure_dir = os.path.join("/app/figures", paper_id)
        figures = pdf_extractor.extract_figures(file_path, figure_dir)

        for fig in figures:
            try:
                with open(str(fig["image_path"]), "rb") as f:
                    img_bytes = f.read()
                desc = figure_describer.describe_figure_sync(img_bytes)
                store_figure(
                    paper_id=paper_id,
                    page_number=int(fig["page"]),
                    image_path=str(fig["image_path"]),
                    extraction_type=str(fig["extraction_type"]),
                    description=desc["description"],
                    claim_summary=desc["claim_summary"],
                    figure_index=int(fig["figure_index"]),
                )
            except Exception as e:
                log.warn("figure_store_failed", figure=str(fig.get("image_path")), error=str(e))

        # --- Complete ---
        _update_paper_status(
            paper_id, "complete",
            extraction_path=extraction_path,
            chunk_count=len(chunks),
            figure_count=len(figures),
        )
        log.info("ingestion_complete",
                 extraction_path=extraction_path,
                 chunks=len(chunks),
                 figures=len(figures))

        # --- Trigger post-ingestion alerts (async, non-blocking) ---
        try:
            app.send_task(
                "tasks.alert_tasks.check_contradictions",
                args=[paper_id],
                queue="persona",
            )
            log.info("contradiction_check_dispatched")
        except Exception:
            log.warn("alert_dispatch_failed")

        return {
            "status": "complete",
            "paper_id": paper_id,
            "extraction_path": extraction_path,
            "chunk_count": len(chunks),
            "figure_count": len(figures),
        }

    except Exception as exc:
        log.error("ingestion_failed", error=str(exc))
        try:
            _update_paper_status(paper_id, "error", error_message=str(exc))
        except Exception:
            log.error("status_update_failed_on_error")
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)
        raise
