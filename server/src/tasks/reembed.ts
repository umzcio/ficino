// Re-embed a user's chunks with the embedding model their settings resolve to (plan 06: the restore re-embed and the
// re-embed after an embedding-model change). Retrieval only reads chunks whose metadata.embed_model equals the
// configured model, so a chunk embedded with another model is invisible until this rewrites it.
import type { Logger } from 'pino';
import type { Sql } from '../db/sql.js';
import { chunkEmbedText } from '../ingest/embedText.js';
import { logger } from '../logger.js';
import type { ProviderConfig } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { embedModelId, embedTexts } from '../providers/embed.js';

export type ReembedResult = { target: string; updated: number; remaining: number };

const DEFAULT_BATCH = 64;

/**
 * Re-embeds, batch by batch, every chunk of `userId`'s papers whose `metadata.embed_model` is not the target
 * (`embedModelId(providers)`), and tags it in the same `UPDATE` that writes its new vector. Each batch commits on its
 * own: an abort or a provider failure after batch k leaves batches 1..k re-embedded and tagged and the rest as they
 * were, and a rerun picks up the rest. No row ever carries the new tag with an old vector.
 *
 * A chunk whose metadata is a non-null non-object (an array, a string) cannot be tagged: `||` would turn it into an
 * array that never matches. Those are skipped, logged and counted in `remaining`.
 */
export async function reembedUserChunks(
  sql: Sql,
  providers: ProviderConfig,
  deps: ProviderDeps,
  opts: { userId: string; signal?: AbortSignal; log?: Logger; batchSize?: number },
): Promise<ReembedResult> {
  const { userId, signal } = opts;
  const log = opts.log ?? logger;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`reembed batchSize must be >= 1: ${batchSize}`);
  const target = embedModelId(providers);
  let total = 0;

  for (;;) {
    signal?.throwIfAborted();
    const rows = await sql<Array<{ id: string; content: string; contextual_prefix: string | null }>>`
      SELECT c.id, c.content, c.contextual_prefix
      FROM chunks c JOIN papers p ON p.id = c.paper_id
      WHERE p.user_id = ${userId}
        AND c.metadata->>'embed_model' IS DISTINCT FROM ${target}
        AND jsonb_typeof(COALESCE(c.metadata, '{}'::jsonb)) = 'object'
      ORDER BY c.paper_id, c.chunk_index
      LIMIT ${batchSize}`;
    if (rows.length === 0) break;

    const vectors = await embedTexts(
      providers,
      deps,
      rows.map((r) => chunkEmbedText(r)),
      { inputType: 'document', signal },
    );
    // An embed call does not always reject on abort; an abort during it discards this batch.
    signal?.throwIfAborted();

    const ids = rows.map((r) => r.id);
    const vecs = vectors.map((v) => `[${v.join(',')}]`);
    const result = await sql`
      UPDATE chunks c
      SET embedding = v.e::vector,
          metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object('embed_model', ${target}::text)
      FROM unnest(${ids}::uuid[], ${vecs}::text[]) AS v(id, e)
      WHERE c.id = v.id
        AND c.metadata->>'embed_model' IS DISTINCT FROM ${target}
        AND jsonb_typeof(COALESCE(c.metadata, '{}'::jsonb)) = 'object'`;
    // Fewer rows than selected is fine (a paper deleted meanwhile); none at all would loop on the same rows.
    if (result.count === 0) throw new Error(`reembed made no progress on ${rows.length} chunks`);
    total += result.count;
    log.info({ updated: result.count, total }, 'reembed_batch');
  }

  const [left] = await sql<Array<{ remaining: number; untaggable: number }>>`
    SELECT count(*)::int AS remaining,
           count(*) FILTER (WHERE jsonb_typeof(COALESCE(c.metadata, '{}'::jsonb)) <> 'object')::int AS untaggable
    FROM chunks c JOIN papers p ON p.id = c.paper_id
    WHERE p.user_id = ${userId} AND c.metadata->>'embed_model' IS DISTINCT FROM ${target}`;
  if (left!.untaggable > 0) log.warn({ count: left!.untaggable }, 'reembed_untaggable_metadata');
  return { target, updated: total, remaining: left!.remaining };
}

/** Chunks of `userId`'s papers per `metadata.embed_model`; `'(none)'` counts chunks without one. */
export async function embedModelCounts(sql: Sql, userId: string): Promise<Record<string, number>> {
  const rows = await sql<Array<{ model: string; n: number }>>`
    SELECT COALESCE(c.metadata->>'embed_model', '(none)') AS model, count(*)::int AS n
    FROM chunks c JOIN papers p ON p.id = c.paper_id
    WHERE p.user_id = ${userId}
    GROUP BY 1 ORDER BY 1`;
  return Object.fromEntries(rows.map((r) => [r.model, r.n]));
}
