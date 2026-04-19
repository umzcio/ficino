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
    contextualizer,
    embedder,
    marker_extractor,
    metadata_extractor,
    pdf_extractor,
    quality_check,
    vision_extractor,
)
from lib.db import execute, fetchrow, store_chunks_batch, store_figure
from lib.settings import STUB_USER_ID
from lib.storage import storage

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
def process_paper(
    self: Task, paper_id: str, _legacy_file_path: str | None = None,
) -> dict[str, str]:
    """Full ingestion pipeline for a single paper.

    Steps:
    1. Extract text (Marker → PyMuPDF → quality check → Vision fallback)
    2. Section-aware chunking
    3. Generate embeddings (Ollama, Voyage, or OpenAI)
    4. Store chunks + embeddings in pgvector
    5. Extract and describe figures

    The `_legacy_file_path` argument is accepted for backward compatibility
    with in-flight Celery jobs enqueued before the storage-adapter refactor.
    New dispatches only send `paper_id`; the storage backend resolves the
    PDF location itself (filesystem path for local, tempfile download for
    cloud backends).
    """
    log = logger.bind(paper_id=paper_id, task_id=self.request.id)

    # Apply provider settings from DB (LLM, embed, API keys)
    from lib.settings import apply_provider_settings, get_user_settings
    user_settings = apply_provider_settings()

    # Fetch the paper's real owner so auto-tags and auto-generate dispatches
    # attribute to them instead of the STUB_USER_ID placeholder. Falls back
    # to the stub only if the lookup fails (paper row missing / unexpected).
    paper_row = fetchrow("SELECT user_id FROM papers WHERE id = $1", paper_id)
    paper_user_id = str(paper_row["user_id"]) if paper_row and paper_row["user_id"] else STUB_USER_ID

    # Materialize the PDF on local disk so the extraction libs (fitz, marker,
    # PIL) can open it by path. For local backend this is a no-op returning
    # the canonical path; for cloud backends it downloads to a tempfile that
    # must be cleaned up in the `finally` below.
    file_path = storage.localize_pdf(paper_user_id, paper_id)

    try:
        # --- Step 1: Text extraction ---
        self.update_state(state="PROGRESS", meta={"step": "extracting", "paper_id": paper_id})
        _update_paper_status(paper_id, "extracting")
        log.info("ingestion_step", step="extracting")

        extraction_mode = user_settings.get("extraction_mode", "auto")
        extraction_path = "pymupdf_clean"
        markdown = ""

        if extraction_mode == "vision":
            # User forced vision-only extraction
            if vision_extractor.is_available():
                markdown = vision_extractor.extract_with_vision_sync(file_path)
                extraction_path = "vision_forced"
            else:
                log.warn("vision_forced_but_unavailable_falling_back_to_pymupdf")
                markdown = pdf_extractor.extract_text_pymupdf(file_path)
        elif extraction_mode == "pymupdf":
            # User forced PyMuPDF-only extraction
            markdown = pdf_extractor.extract_text_pymupdf(file_path)
            extraction_path = "pymupdf_forced"
        else:
            # Auto mode: Marker → PyMuPDF → quality check → vision fallback
            if marker_extractor.is_available():
                try:
                    markdown = marker_extractor.extract_with_marker(file_path)
                    extraction_path = "marker_clean"
                except Exception as e:
                    log.warn("marker_failed", error=str(e))
                    markdown = ""

            if not markdown:
                markdown = pdf_extractor.extract_text_pymupdf(file_path)
                extraction_path = "pymupdf_clean"

        # --- Step 2: Quality check (skip if user forced a mode) ---
        self.update_state(state="PROGRESS", meta={"step": "quality_checking", "paper_id": paper_id})
        log.info("ingestion_step", step="quality_checking")

        if extraction_mode == "auto":
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
            user_id = paper_user_id
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

        chunk_max = user_settings.get("chunk_max_tokens", 800)
        chunks = chunker.chunk_markdown(markdown, max_tokens=chunk_max)
        log.info("chunks_created", count=len(chunks))

        # --- Step 3b: Contextual prefixing (Anthropic-style contextual retrieval) ---
        # Runs only when context_provider != "none". The prefix is a 1-2
        # sentence blurb per chunk that situates it in the paper, and it is
        # concatenated to the chunk content BEFORE embedding so the vector
        # captures the chunk's role inside the paper, not just its tokens.
        # Also persisted to chunks.contextual_prefix for future re-embeds
        # without a second LLM pass.
        self.update_state(state="PROGRESS", meta={"step": "contextualizing", "paper_id": paper_id})
        log.info("ingestion_step", step="contextualizing")
        if chunks:
            try:
                contextual_prefixes = contextualizer.generate_contexts_for_paper_sync(
                    markdown, chunks,
                )
            except Exception as e:
                # Contextual retrieval is an upgrade, not a hard requirement.
                # If the contextualizer is down (Anthropic outage, local LLM
                # crashed), fall back to prefix-less ingestion rather than
                # failing the whole paper.
                log.warn("contextualizer_failed_falling_back", error=str(e)[:200])
                contextual_prefixes = ["" for _ in chunks]
        else:
            contextual_prefixes = []

        # Attach prefix onto each chunk dict so store_chunks_batch can persist it.
        for chunk, prefix in zip(chunks, contextual_prefixes):
            chunk["contextual_prefix"] = prefix

        # --- Step 4: Embedding ---
        self.update_state(state="PROGRESS", meta={"step": "embedding", "paper_id": paper_id})
        _update_paper_status(paper_id, "embedding")
        log.info("ingestion_step", step="embedding")

        if chunks:
            # Prefix+content embedding: chunks with a prefix get it prepended so
            # the bi-encoder sees paper-level framing. Chunks without (or with
            # empty) prefix fall back to raw content — retains backward-compat
            # with prior chunks if a paper is partially re-ingested.
            chunk_texts = [
                (f"{c.get('contextual_prefix') or ''}\n\n{c['content']}".strip()
                 if c.get("contextual_prefix") else str(c["content"]))
                for c in chunks
            ]
            try:
                embeddings = embedder.embed_texts_sync(chunk_texts)
            except RuntimeError as e:
                # Embedder now raises when no provider is reachable instead of
                # silently producing zero-vectors that poison HNSW. Mark the
                # paper 'error' with a descriptive message so the user knows
                # why ingestion stopped — and do NOT retry, since this is a
                # config issue, not a transient failure.
                msg = f"No embedding provider available: {e}"
                log.error("embedding_provider_unavailable", error=str(e))
                _update_paper_status(paper_id, "error", error_message=msg)
                return {
                    "status": "error",
                    "paper_id": paper_id,
                    "error": msg,
                }
        else:
            embeddings = []

        # --- Step 5: Store chunks ---
        stored = store_chunks_batch(paper_id, chunks, embeddings, paper_user_id)
        log.info("chunks_stored", count=stored)

        # --- Step 6: Figure extraction ---
        self.update_state(state="PROGRESS", meta={"step": "extracting_figures", "paper_id": paper_id})
        log.info("ingestion_step", step="extracting_figures")

        # extract_figures returns crops as in-memory PNG bytes keyed under
        # "image_bytes". The storage adapter is the only thing that writes
        # them — whether that means a filesystem directory (local) or a
        # Supabase bucket key (cloud).
        figures = pdf_extractor.extract_figures(file_path)

        # Storage telemetry. Detection failures happen upstream (in the
        # detector, per-page) and surface as an empty figures list or a
        # given page missing detections; the loop below only covers
        # per-row DB write failures, which at this point should be rare
        # (they mean disk or DB trouble, not vision-model trouble).
        figures_attempted = len(figures)
        figures_stored = 0
        figures_failed_by_type: dict[str, int] = {}

        for fig in figures:
            try:
                # data_claim is the detector's 1-sentence grounded summary;
                # caption is the actual figure caption text. We keep the
                # legacy `description` and `claim_summary` columns populated
                # from these so older persona-prompt code paths don't need
                # to be updated simultaneously — the new columns are also
                # written so prompt code can be upgraded to use them.
                data_claim = str(fig.get("data_claim") or "")
                caption = str(fig.get("caption") or "")
                legacy_description = data_claim or caption
                # First sentence of data_claim, or full caption — whichever
                # is shorter and gives personas a clean, short summary.
                first_sentence = data_claim.split(". ")[0].strip()
                legacy_claim = (first_sentence[:400] if first_sentence
                                else caption[:400])

                # Upload the crop to storage and capture the backend's
                # reference for `figures.image_path`. Whatever is persisted
                # here is what `storage.figure_image_url()` will receive at
                # browse time — the two must agree on the reference shape.
                image_ref = storage.save_figure(
                    paper_user_id, paper_id,
                    str(fig["filename"]),
                    fig["image_bytes"],
                )

                store_figure(
                    paper_id=paper_id,
                    page_number=int(fig["page"]),
                    image_path=image_ref,
                    extraction_type=str(fig["extraction_type"]),
                    description=legacy_description,
                    claim_summary=legacy_claim,
                    figure_index=int(fig["figure_index"]),
                    figure_type=str(fig.get("figure_type") or "") or None,
                    caption=caption or None,
                    figure_number=str(fig.get("figure_number") or "") or None,
                    data_claim=data_claim or None,
                    referenced_paragraph=str(fig.get("referenced_paragraph") or "") or None,
                    bbox=fig.get("bbox") if isinstance(fig.get("bbox"), dict) else None,
                    detector_confidence=(
                        float(fig["detector_confidence"])
                        if fig.get("detector_confidence") is not None else None
                    ),
                )
                figures_stored += 1
            except Exception as e:
                err_type = type(e).__name__
                figures_failed_by_type[err_type] = figures_failed_by_type.get(err_type, 0) + 1
                log.warn(
                    "figure_store_failed",
                    figure=str(fig.get("filename")),
                    error_type=err_type,
                    error=str(e)[:200],
                )

        # Emit a single event per paper summarizing the run. Consumers can
        # filter on event="figure_extraction_summary" and track failure_rate
        # over time.
        failure_rate = (
            (figures_attempted - figures_stored) / figures_attempted
            if figures_attempted > 0 else 0.0
        )
        log.info(
            "figure_extraction_summary",
            paper_id=paper_id,
            attempted=figures_attempted,
            stored=figures_stored,
            failed=figures_attempted - figures_stored,
            failure_rate=round(failure_rate, 3),
            failed_by_type=figures_failed_by_type,
        )
        # Loud warning if MOST figures failed — vision provider likely down
        # or wrong model. This one log line is the actionable alert.
        if figures_attempted >= 3 and figures_stored == 0:
            log.error(
                "figure_extraction_total_failure",
                paper_id=paper_id,
                attempted=figures_attempted,
                failed_by_type=figures_failed_by_type,
            )

        # --- Complete ---
        # Use `figures_stored`, not `len(figures)` — some figures fail vision
        # description and don't end up in the DB, so len(figures) overstates
        # what the user can actually browse.
        _update_paper_status(
            paper_id, "complete",
            extraction_path=extraction_path,
            chunk_count=len(chunks),
            figure_count=figures_stored,
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

        # --- Auto-generate feed if enabled ---
        try:
            # Re-fetch for the paper's actual owner (the `user_settings` local
            # at the top of this task was scoped to the stub / apply_provider_settings
            # path). `get_user_settings` was already imported alongside
            # `apply_provider_settings` at the task entry — reuse it.
            owner_settings = get_user_settings(paper_user_id)
            if owner_settings.get("auto_generate_on_upload"):
                corpus_id = fetchrow(
                    "SELECT corpus_id FROM papers WHERE id = $1", paper_id
                )
                if corpus_id and corpus_id["corpus_id"]:
                    app.send_task(
                        "tasks.persona_tasks.generate_feed",
                        kwargs={
                            "corpus_id": str(corpus_id["corpus_id"]),
                            "user_id": str(paper_user_id),
                        },
                        queue="persona",
                    )
                    log.info(
                        "auto_generate_dispatched",
                        corpus_id=str(corpus_id["corpus_id"]),
                        user_id=str(paper_user_id),
                    )
        except Exception:
            log.warn("auto_generate_dispatch_failed")

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
    finally:
        # Release any tempfile the storage backend created (no-op for local).
        # Running this in `finally` guarantees cleanup even when the pipeline
        # errors out or retries — the next attempt will re-localize.
        try:
            storage.release_local(file_path)
        except Exception:
            log.warn("release_local_failed")
