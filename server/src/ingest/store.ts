// Port of worker/lib/db.py store_chunks_batch and store_figure, plus batched embedding and storage of chunks.
import type postgres from 'postgres';
import type { Sql } from '../db/sql.js';
import { pySlice, pyStrip } from '../shared/pystr.js';
import { logger } from '../logger.js';
import type { Chunk } from './chunker.js';
import { chunkEmbedText } from './embedText.js';
import type { ExtractedFigure } from './figures.js';

type StoredChunk = Chunk & { contextual_prefix: string };

/**
 * Chunks embedded and written per batch by `embedAndStoreChunks`. Real papers have at most a few hundred chunks, so
 * they are one batch: one embedding call and one `storeChunks`, as before batching. A multiple of the Ollama (16) and
 * Voyage (128) request sizes. Per-paper memory is this many vectors and their text, whatever the paper's size.
 */
export const EMBED_STORE_BATCH = 256;

/** One `INSERT … SELECT FROM unnest(…)` of `chunks`; embeddings travel as pgvector text and are cast with `::vector`. */
async function insertChunks(
  q: postgres.TransactionSql,
  paperId: string,
  userId: string,
  chunks: StoredChunk[],
  embeddings: number[][],
  embedModel: string,
): Promise<void> {
  if (chunks.length !== embeddings.length) {
    throw new Error(`storeChunks: ${chunks.length} chunks but ${embeddings.length} embeddings`);
  }
  const sections = chunks.map((c) => c.section);
  const contents = chunks.map((c) => c.content);
  const indexes = chunks.map((c) => c.chunk_index);
  const tokens = chunks.map((c) => c.token_count);
  const vectors = embeddings.map((v) => `[${v.join(',')}]`);
  const prefixes = chunks.map((c) => c.contextual_prefix || null);
  const metadata = q.json({ embed_model: embedModel });

  await q`
    INSERT INTO chunks (paper_id, user_id, section, content, chunk_type, chunk_index, token_count, embedding, metadata, contextual_prefix)
    SELECT ${paperId}::uuid, ${userId}::uuid, t.section, t.content, 'text', t.chunk_index, t.token_count,
           t.embedding::vector, ${metadata}::jsonb, t.contextual_prefix
    FROM unnest(${sections}::text[], ${contents}::text[], ${indexes}::int[], ${tokens}::int[],
                ${vectors}::text[], ${prefixes}::text[])
      AS t(section, content, chunk_index, token_count, embedding, contextual_prefix)
    ON CONFLICT (paper_id, chunk_index) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      section = EXCLUDED.section,
      content = EXCLUDED.content,
      chunk_type = EXCLUDED.chunk_type,
      token_count = EXCLUDED.token_count,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata,
      contextual_prefix = EXCLUDED.contextual_prefix`;
}

/**
 * Replace a paper's chunks in one transaction: DELETE them all, then one `INSERT … SELECT FROM unnest(…)`.
 * The delete keeps a retry from leaving rows of an earlier, longer run; the ON CONFLICT keeps the insert
 * itself idempotent. Embeddings travel as pgvector text and are cast with `::vector`. No chunks: returns 0
 * without touching the table (as Python does).
 */
export async function storeChunks(
  sql: Sql,
  paperId: string,
  userId: string,
  chunks: StoredChunk[],
  embeddings: number[][],
  embedModel: string,
): Promise<number> {
  if (chunks.length === 0) return 0;
  if (chunks.length !== embeddings.length) {
    throw new Error(`storeChunks: ${chunks.length} chunks but ${embeddings.length} embeddings`);
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM chunks WHERE paper_id = ${paperId}`;
    await insertChunks(tx, paperId, userId, chunks, embeddings, embedModel);
  });
  return chunks.length;
}

/**
 * Embed and store a paper's chunks `batchSize` at a time (default `EMBED_STORE_BATCH`): each batch is embedded
 * (`embed` gets its `chunkEmbedText` texts) and written before the next is requested, so the vectors and their text
 * held at once are one batch's, whatever the paper's size. The first batch replaces the paper's rows as
 * `storeChunks` does (one transaction: DELETE, INSERT); later batches are inserted after it. The stored rows are the
 * ones `storeChunks` would write for all the chunks at once.
 *
 * `signal` is checked before each batch and after each embedding call. A failure (an abort included) before the
 * first batch is written leaves the paper's rows as they were, as a failed `storeChunks` did; one after it deletes
 * the batches already written, so a paper is never left with part of its chunks. No chunks: returns 0 without
 * embedding or touching the table.
 */
export async function embedAndStoreChunks(
  sql: Sql,
  o: {
    paperId: string;
    userId: string;
    chunks: StoredChunk[];
    embedModel: string;
    embed: (texts: string[]) => Promise<number[][]>;
    batchSize?: number;
    signal?: AbortSignal;
  },
): Promise<number> {
  const { paperId, userId, chunks, embedModel, embed, signal } = o;
  const batchSize = o.batchSize ?? EMBED_STORE_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`embedAndStoreChunks batchSize must be at least 1: ${batchSize}`);
  }
  if (chunks.length === 0) return 0;

  let written = false;
  try {
    for (let start = 0; start < chunks.length; start += batchSize) {
      signal?.throwIfAborted();
      const batch = chunks.slice(start, start + batchSize);
      const vectors = await embed(batch.map((c) => chunkEmbedText(c)));
      // An embedding call does not always reject on abort; an abort during it discards this batch.
      signal?.throwIfAborted();
      if (written) {
        await sql.begin((tx) => insertChunks(tx, paperId, userId, batch, vectors, embedModel));
      } else {
        await storeChunks(sql, paperId, userId, batch, vectors, embedModel);
        written = true;
      }
    }
  } catch (e) {
    if (written) {
      try {
        await sql`DELETE FROM chunks WHERE paper_id = ${paperId}`;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error({ paper_id: paperId, error }, 'chunk_cleanup_failed');
      }
    }
    throw e;
  }
  return chunks.length;
}

/**
 * Upsert one figure on (paper_id, figure_index), so a process_paper retry never duplicates rows. The legacy
 * `description` and `claim_summary` columns are derived for older prompt code: description = data_claim or
 * caption; claim_summary = data_claim's first sentence (split on ". "), else the caption, capped at 400.
 */
export async function storeFigure(sql: Sql, paperId: string, f: ExtractedFigure, imagePath: string): Promise<void> {
  const dataClaim = f.data_claim || '';
  const caption = f.caption || '';
  const description = dataClaim || caption;
  const firstSentence = pyStrip(dataClaim.split('. ')[0] ?? '');
  const claimSummary = firstSentence ? pySlice(firstSentence, 0, 400) : pySlice(caption, 0, 400);
  // postgres.js serializes a jsonb parameter itself; a pre-stringified value would land as a JSON string.
  const bbox = f.bbox && typeof f.bbox === 'object' && !Array.isArray(f.bbox) ? sql.json(f.bbox) : null;
  const confidence = f.detector_confidence ?? null;

  await sql`
    INSERT INTO figures (
      paper_id, page_number, image_path, extraction_type,
      description, claim_summary, figure_index, processed_at,
      figure_type, caption, figure_number, data_claim,
      referenced_paragraph, bbox, detector_confidence
    )
    VALUES (${paperId}, ${Math.trunc(f.page)}, ${imagePath}, ${f.extraction_type},
            ${description}, ${claimSummary}, ${Math.trunc(f.figure_index)}, NOW(),
            ${f.figure_type || null}, ${caption || null}, ${f.figure_number || null}, ${dataClaim || null},
            ${f.referenced_paragraph || null}, ${bbox}::jsonb, ${confidence})
    ON CONFLICT (paper_id, figure_index) DO UPDATE
      SET page_number          = EXCLUDED.page_number,
          image_path           = EXCLUDED.image_path,
          extraction_type      = EXCLUDED.extraction_type,
          description          = EXCLUDED.description,
          claim_summary        = EXCLUDED.claim_summary,
          processed_at         = EXCLUDED.processed_at,
          figure_type          = EXCLUDED.figure_type,
          caption              = EXCLUDED.caption,
          figure_number        = EXCLUDED.figure_number,
          data_claim           = EXCLUDED.data_claim,
          referenced_paragraph = EXCLUDED.referenced_paragraph,
          bbox                 = EXCLUDED.bbox,
          detector_confidence  = EXCLUDED.detector_confidence`;
}
