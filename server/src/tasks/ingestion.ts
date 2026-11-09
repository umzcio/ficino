// Port of worker/tasks/ingestion_tasks.py process_paper (W §2.1).
import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { Sql } from '../db/sql.js';
import { generateContexts } from '../ingest/contextualize.js';
import { chunkEmbedText } from '../ingest/embedText.js';
import { extractFigures } from '../ingest/figures.js';
import { extractMetadata } from '../ingest/metadata.js';
import { PdfLimitError } from '../ingest/pdf.js';
import { openIsolatedPdf } from '../ingest/pdfIsolated.js';
import type { PdfSession } from '../ingest/pdfSession.js';
import { checkExtractionQuality } from '../ingest/qualityCheck.js';
import { storeChunks, storeFigure } from '../ingest/store.js';
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings } from '../providers/config.js';
import { embedModelId, embedTexts, EmbeddingUnavailableError } from '../providers/embed.js';
import { extractWithVision, isVisionAvailable } from '../providers/vision.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pyRound, pySlice } from '../shared/pystr.js';
import { isUuid } from '../shared/uuid.js';
import type { WorkerDeps } from '../worker/handlers.js';

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errType = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

async function setStatus(sql: Sql, paperId: string, status: string): Promise<void> {
  await sql`UPDATE papers SET status = ${status} WHERE id = ${paperId}`;
}

async function setError(sql: Sql, paperId: string, message: string): Promise<void> {
  await sql`UPDATE papers SET status = 'error', error_message = ${message} WHERE id = ${paperId}`;
}

/**
 * The whole ingestion pipeline for one paper: extract, quality check (vision fallback), metadata and auto-tags,
 * chunk, contextualize, embed, store chunks, extract figures, complete, fan out.
 *
 * Provider settings are resolved once for the paper's owner and the same frozen config goes to every call, so
 * concurrent jobs never share keys. `ctx.signal` (pg-boss abort or the soft time limit) reaches every provider
 * call and terminates the thread that runs the paper's MuPDF work and chunking (`openIsolatedPdf`), even mid-page.
 * An embedding failure is final (status error, returned, no retry), and so are the soft time limit (a rerun would
 * spend the same provider budget again and time out the same way) and a `PdfLimitError` (a page over
 * `MAX_PAGE_CHARS`, PDF or vision text over `MAX_PAPER_CHARS`, or the PDF thread past its heap cap: the same file
 * fails the same way). Any other failure (a pg-boss abort included) marks the paper error and rethrows so pg-boss
 * retries the whole job.
 */
export async function processPaper(
  data: { paper_id: string },
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const paperId = data.paper_id;
  const { sql, config } = deps;
  const signal = ctx.signal;
  const log: Logger = ctx.logger.child({ paper_id: paperId, job_id: ctx.jobId });

  // A non-UUID id cannot name a row; treat it like a missing row instead of retrying a cast error.
  const [row] = isUuid(paperId) ? await sql`SELECT user_id FROM papers WHERE id = ${paperId}` : [];
  if (!row) {
    log.warn('paper_not_found_skipping');
    return { status: 'skipped', paper_id: paperId, reason: 'paper not found' };
  }
  const owner = row.user_id ? String(row.user_id) : STUB_USER_ID;
  const { settings, providers: p } = await loadJobSettings(sql, owner, deps.env, config);

  const progress = (step: string) => ctx.progress({ step, paper_id: paperId });
  const step = (name: string) => log.info({ step: name }, 'ingestion_step');

  let doc: PdfSession | undefined;
  try {
    // --- Step 1: text extraction ---
    await progress('extracting');
    await setStatus(sql, paperId, 'extracting');
    step('extracting');
    doc = await openIsolatedPdf(new Uint8Array(await readFile(deps.storage.pdfPath(paperId))), {
      maxPages: config.maxPdfPages,
      maxPageChars: config.maxPageChars,
      maxPaperChars: config.maxPaperChars,
      heapMb: config.pdfThreadHeapMb,
      signal,
    });

    const pdf = doc;
    const readVision = () =>
      extractWithVision(pdf, p, deps.providers, config.maxVisionPages, signal, config.maxPaperChars);
    const extractionMode = String(settings.extraction_mode ?? 'auto');
    let extractionPath = 'pymupdf_clean';
    let markdown: string;
    if (extractionMode === 'vision') {
      if (isVisionAvailable(p)) {
        markdown = await readVision();
        extractionPath = 'vision_forced';
      } else {
        log.warn('vision_forced_but_unavailable_falling_back_to_pymupdf');
        markdown = await doc.extractTextMarkdown(log);
      }
    } else if (extractionMode === 'pymupdf') {
      markdown = await doc.extractTextMarkdown(log);
      extractionPath = 'pymupdf_forced';
    } else {
      // Auto: PyMuPDF, then the quality check below (Marker is gone, so never "marker_clean").
      markdown = await doc.extractTextMarkdown(log);
    }

    // --- Step 2: quality check (auto only) ---
    signal.throwIfAborted();
    await progress('quality_checking');
    step('quality_checking');
    if (extractionMode === 'auto') {
      const { ok, reason } = checkExtractionQuality(markdown);
      if (!ok) {
        log.warn({ reason }, 'extraction_quality_failed');
        if (isVisionAvailable(p)) {
          log.info('falling_back_to_vision');
          markdown = await readVision();
          extractionPath = 'vision_fallback';
        } else {
          log.warn('no_vision_provider_available_using_raw_text');
        }
      }
    }

    // --- Step 2b: metadata ---
    signal.throwIfAborted();
    await progress('metadata');
    step('metadata');
    const meta = await extractMetadata(p, deps.providers, markdown, signal);
    const authors = meta.authors ?? [];
    const sets: Record<string, string | number | string[]> = {};
    if (meta.title) sets.title = meta.title;
    if (authors.length > 0) sets.authors = authors;
    if (meta.year) sets.year = meta.year;
    if (meta.doi) sets.doi = meta.doi;
    const columns = Object.keys(sets);
    if (columns.length > 0) {
      await sql`UPDATE papers SET ${sql(sets, columns)} WHERE id = ${paperId}`;
      log.info({ title: meta.title, authors: authors.length }, 'metadata_stored');
    }

    // Auto-tags: upsert every tag in one statement, then link them all in one more.
    const autoTags = meta.tags ?? [];
    if (autoTags.length > 0) {
      try {
        const tagRows = await sql`
          INSERT INTO tags (user_id, name)
          SELECT ${owner}::uuid, t FROM unnest(${autoTags}::text[]) AS t
          ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
          RETURNING id`;
        const tagIds = tagRows.map((r) => String(r.id));
        if (tagIds.length > 0) {
          await sql`
            INSERT INTO paper_tags (paper_id, tag_id)
            SELECT ${paperId}::uuid, t::uuid FROM unnest(${tagIds}::uuid[]) AS t
            ON CONFLICT DO NOTHING`;
        }
        log.info({ tags: autoTags }, 'auto_tags_assigned');
      } catch (e) {
        // error (not warn) + error_type: a NameError hid here for months as a routine warning (R10 WORK-1).
        log.error({ tags: autoTags, error: errMessage(e), error_type: errType(e) }, 'auto_tag_failed');
      }
    }

    // --- Step 3: chunking ---
    signal.throwIfAborted();
    await progress('chunking');
    await setStatus(sql, paperId, 'chunking');
    step('chunking');
    const chunkMax = Number(settings.chunk_max_tokens ?? 800);
    // In the PDF thread: token counting a long paper takes seconds, which would block every other queue here.
    const chunks = await doc.chunkMarkdown(markdown, chunkMax);
    log.info({ count: chunks.length }, 'chunks_created');

    // --- Step 3b: contextual prefixes (best-effort) ---
    await progress('contextualizing');
    step('contextualizing');
    let prefixes: string[] = [];
    if (chunks.length > 0) {
      try {
        prefixes = await generateContexts(p, deps.providers, markdown, chunks, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        log.warn({ error: pySlice(errMessage(e), 0, 200) }, 'contextualizer_failed_falling_back');
        prefixes = chunks.map(() => '');
      }
    }
    const prefixed = chunks.map((c, i) => ({ ...c, contextual_prefix: prefixes[i] ?? '' }));

    // --- Step 4: embedding ---
    signal.throwIfAborted();
    await progress('embedding');
    await setStatus(sql, paperId, 'embedding');
    step('embedding');
    let embeddings: number[][] = [];
    if (prefixed.length > 0) {
      const texts = prefixed.map((c) => chunkEmbedText(c));
      try {
        embeddings = await embedTexts(p, deps.providers, texts, { inputType: 'document', signal });
      } catch (e) {
        if (!(e instanceof EmbeddingUnavailableError)) throw e;
        // A config problem, not a transient one: mark the paper and stop without a retry.
        const msg = `No embedding provider available: ${e.message}`;
        log.error({ error: e.message }, 'embedding_provider_unavailable');
        await setError(sql, paperId, msg);
        return { status: 'error', paper_id: paperId, error: msg };
      }
    }

    // --- Step 5: store chunks ---
    const stored = await storeChunks(sql, paperId, owner, prefixed, embeddings, embedModelId(p));
    log.info({ count: stored }, 'chunks_stored');

    // --- Step 6: figures ---
    await progress('extracting_figures');
    step('extracting_figures');
    const figures = await extractFigures(doc, p, deps.providers, signal, {
      maxPages: config.figureDetectMaxPages,
    });

    const figuresAttempted = figures.length;
    let figuresStored = 0;
    const failedByType: Record<string, number> = {};
    for (const fig of figures) {
      try {
        const imagePath = await deps.storage.saveFigure(paperId, fig.filename, fig.image_bytes);
        await storeFigure(sql, paperId, fig, imagePath);
        figuresStored++;
      } catch (e) {
        const type = errType(e);
        failedByType[type] = (failedByType[type] ?? 0) + 1;
        log.warn({ figure: fig.filename, error_type: type, error: pySlice(errMessage(e), 0, 200) }, 'figure_store_failed');
      }
    }
    const failureRate = figuresAttempted > 0 ? (figuresAttempted - figuresStored) / figuresAttempted : 0;
    log.info(
      {
        attempted: figuresAttempted,
        stored: figuresStored,
        failed: figuresAttempted - figuresStored,
        failure_rate: pyRound(failureRate, 3),
        failed_by_type: failedByType,
      },
      'figure_extraction_summary',
    );
    if (figuresAttempted >= 3 && figuresStored === 0) {
      log.error({ attempted: figuresAttempted, failed_by_type: failedByType }, 'figure_extraction_total_failure');
    }

    // --- Complete (figure_count = what was stored, i.e. what the user can browse) ---
    await sql`
      UPDATE papers
      SET status = 'complete', extraction_path = ${extractionPath}, chunk_count = ${chunks.length},
          figure_count = ${figuresStored}, processed_at = NOW()
      WHERE id = ${paperId}`;
    log.info({ extraction_path: extractionPath, chunks: chunks.length, figures: figures.length }, 'ingestion_complete');

    // --- Fan-out (failures never fail the paper) ---
    try {
      await deps.queue.send('check_contradictions', { paper_id: paperId });
      log.info('contradiction_check_dispatched');
    } catch {
      log.warn('alert_dispatch_failed');
    }
    try {
      if (settings.auto_generate_on_upload) {
        const [r] = await sql`SELECT corpus_id FROM papers WHERE id = ${paperId}`;
        if (r?.corpus_id) {
          const corpusId = String(r.corpus_id);
          await deps.queue.send('generate_feed', { corpus_id: corpusId, user_id: owner });
          log.info({ corpus_id: corpusId, user_id: owner }, 'auto_generate_dispatched');
        }
      }
    } catch {
      log.warn('auto_generate_dispatch_failed');
    }

    // figure_count here is len(figures), as in Python (the DB holds the stored count).
    return {
      status: 'complete',
      paper_id: paperId,
      extraction_path: extractionPath,
      chunk_count: chunks.length,
      figure_count: figures.length,
    };
  } catch (e) {
    log.error({ error: errMessage(e) }, 'ingestion_failed');
    try {
      await setError(sql, paperId, errMessage(e));
    } catch {
      log.error('status_update_failed_on_error');
    }
    if (ctx.softLimitHit()) {
      log.warn('ingestion_soft_limit_not_retried');
      return { status: 'error', paper_id: paperId, error: errMessage(e) };
    }
    if (e instanceof PdfLimitError) {
      log.warn('ingestion_pdf_limit_not_retried');
      return { status: 'error', paper_id: paperId, error: errMessage(e) };
    }
    throw e;
  } finally {
    if (doc) await doc.close();
  }
}
