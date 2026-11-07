// Port of worker/lib/retrieval.py: two-stage hybrid pgvector + tsvector retrieval, optional rerank, liked boost.
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Sql } from '../db/sql.js';
import type { ProviderConfig } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { embedModelId, embedTexts } from '../providers/embed.js';
import { rerank } from '../providers/rerank.js';
import { pySlice, pyStrip } from '../shared/pystr.js';
import type { Chunk, Personas } from './types.js';

export type RetrievalCtx = {
  sql: Sql;
  config: Config;
  providers: ProviderConfig;
  deps: ProviderDeps;
  logger: Logger;
  signal?: AbortSignal;
};

export const DEFAULT_RETRIEVAL_QUERY = 'key findings and methodology';
/** Score multiplier for chunks from papers the user has liked posts about. */
export const LIKED_PAPER_BOOST = 1.25;

type ChunkRow = Omit<Chunk, 'score' | 'paper_authors'> & { score: unknown; paper_authors: string[] | null };

/**
 * Port of retrieve_chunks. Stage 1: the candidatePool nearest chunks by vector, plus the candidatePool best keyword
 * hits. Stage 2: the union re-ranked by the hybrid score. Stage 3, when a reranker is configured: rerank to topK over
 * a widened SQL slice. Deliberate change 2: only chunks embedded with embedModelId(providers) are considered.
 */
export async function retrieveChunks(
  ctx: RetrievalCtx,
  o: { query: string; paperIds?: string[]; topK?: number; queryEmbedding?: number[]; excludeChunkIds?: string[] },
): Promise<Chunk[]> {
  const { sql, providers, logger } = ctx;
  const { query, paperIds, excludeChunkIds } = o;
  const topK = o.topK ?? 20;
  const r = ctx.config.retrieval;
  logger.info(
    { query: pySlice(query, 0, 100), paper_ids: paperIds ?? null, top_k: topK, excluded: excludeChunkIds?.length ?? 0 },
    'retrieval_start',
  );

  // One resolved value decides both the SQL widening and the rerank call (W §9.2).
  const rerankProvider = providers.rerank.provider;
  let sqlTopK = topK;
  if (rerankProvider !== 'none') sqlTopK = Math.min(r.candidatePool, Math.max(topK * r.rerankMultiplier, topK));

  const queryEmbedding =
    o.queryEmbedding ?? (await embedTexts(providers, ctx.deps, [query], { inputType: 'query', signal: ctx.signal }))[0]!;
  const embedding = `[${queryEmbedding.join(',')}]`;
  const model = embedModelId(providers);

  const paperFilter = paperIds && paperIds.length > 0 ? sql`AND c.paper_id = ANY(${paperIds}::uuid[])` : sql``;
  const excludeFilter =
    excludeChunkIds && excludeChunkIds.length > 0 ? sql`AND c.id <> ALL(${excludeChunkIds}::uuid[])` : sql``;
  const modelFilter = sql`AND c.metadata->>'embed_model' = ${model}`;

  // Weights bind as numeric so `ts_rank * w` stays real, exactly as Python's interpolated literals type it.
  const rows = await sql<ChunkRow[]>`
    WITH candidates AS (
        SELECT c.id
        FROM chunks c
        WHERE TRUE ${paperFilter} ${excludeFilter} ${modelFilter}
        ORDER BY c.embedding <=> ${embedding}::vector
        LIMIT ${r.candidatePool}
    ),
    keyword_hits AS (
        SELECT c.id
        FROM chunks c
        WHERE c.search_vector @@ plainto_tsquery('english', ${query}) ${paperFilter} ${excludeFilter} ${modelFilter}
        ORDER BY ts_rank(c.search_vector, plainto_tsquery('english', ${query})) DESC
        LIMIT ${r.candidatePool}
    )
    SELECT
        c.id,
        c.paper_id,
        c.section,
        c.content,
        c.chunk_type,
        c.chunk_index,
        c.token_count,
        p.title AS paper_title,
        p.authors AS paper_authors,
        p.year AS paper_year,
        p.filename AS paper_filename,
        (1 - (c.embedding <=> ${embedding}::vector)) * ${r.vectorWeight}::numeric +
        COALESCE(ts_rank(c.search_vector, plainto_tsquery('english', ${query})), 0) * ${r.keywordWeight}::numeric AS score,
        CASE
            WHEN c.search_vector @@ plainto_tsquery('english', ${query})
                AND (c.embedding <=> ${embedding}::vector) < ${r.maxVectorDistance}::numeric
            THEN 'hybrid'
            WHEN c.search_vector @@ plainto_tsquery('english', ${query})
            THEN 'keyword'
            ELSE 'vector'
        END AS match_type
    FROM chunks c
    JOIN papers p ON c.paper_id = p.id
    WHERE (
        c.id IN (SELECT id FROM candidates)
        OR c.id IN (SELECT id FROM keyword_hits)
    )
    ${paperFilter}
    ${modelFilter}
    ORDER BY score DESC
    LIMIT ${sqlTopK}`;

  const results: Chunk[] = rows.map((row) => ({
    id: row.id,
    paper_id: row.paper_id,
    section: row.section,
    content: row.content,
    chunk_type: row.chunk_type,
    chunk_index: row.chunk_index,
    token_count: row.token_count,
    paper_title: row.paper_title,
    paper_authors: row.paper_authors ?? [],
    paper_year: row.paper_year,
    paper_filename: row.paper_filename,
    score: Number(row.score),
    match_type: row.match_type,
  }));

  logger.info({ results: results.length, match_types: [...new Set(results.map((c) => c.match_type))] }, 'retrieval_complete');

  if (rerankProvider !== 'none' && results.length > 0) {
    const reranked = await rerank(providers, ctx.deps, query, results, topK, { logger, signal: ctx.signal });
    logger.info({ provider: rerankProvider, input: results.length, output: reranked.length }, 'retrieval_reranked');
    return reranked;
  }
  return results;
}

/** {persona key -> retrieval query}; a null or empty retrieval_query falls back to the default. */
export function retrievalQueries(personas: Personas): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, p] of personas) out.set(key, p.retrieval_query || DEFAULT_RETRIEVAL_QUERY);
  return out;
}

/**
 * Port of retrieve_for_persona. With liked paper titles it fetches 2 * topK, boosts chunks whose stripped,
 * lower-cased paper title is in the liked set, then re-sorts by `score` (not rerank_score; W §9.10) and slices.
 */
export async function retrieveForPersona(
  ctx: RetrievalCtx,
  personas: Personas,
  o: {
    personaKey: string;
    paperIds?: string[];
    topK?: number;
    likedPaperTitles?: string[];
    queryEmbedding?: number[];
    excludeChunkIds?: string[];
  },
): Promise<Chunk[]> {
  const topK = o.topK ?? 10;
  const liked = o.likedPaperTitles && o.likedPaperTitles.length > 0 ? o.likedPaperTitles : null;
  const query = retrievalQueries(personas).get(o.personaKey) ?? DEFAULT_RETRIEVAL_QUERY;
  let results = await retrieveChunks(ctx, {
    query,
    paperIds: o.paperIds,
    topK: liked ? topK * 2 : topK,
    queryEmbedding: o.queryEmbedding,
    excludeChunkIds: o.excludeChunkIds,
  });

  if (liked && results.length > 0) {
    const likedSet = new Set(liked.filter((t) => t).map((t) => pyStrip(t).toLowerCase()));
    for (const chunk of results) {
      const title = pyStrip(chunk.paper_title ?? '').toLowerCase();
      if (title && likedSet.has(title)) {
        chunk.score = chunk.score * LIKED_PAPER_BOOST;
        chunk.boosted = true;
      }
    }
    // Array.sort is stable, matching Python's list.sort(reverse=True).
    results = [...results].sort((a, b) => b.score - a.score).slice(0, topK);
  }
  return results;
}

/** In-scope chunks that retrieval will skip because they were embedded with a different model (or none). */
export async function countEmbedModelMismatch(sql: Sql, paperIds: string[], model: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM chunks
    WHERE paper_id = ANY(${paperIds}::uuid[]) AND metadata->>'embed_model' IS DISTINCT FROM ${model}`;
  return row!.n;
}

/** All chunks in scope, so a caller can tell a fully excluded corpus from a partly excluded one. */
export async function countScopeChunks(sql: Sql, paperIds: string[]): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM chunks WHERE paper_id = ANY(${paperIds}::uuid[])`;
  return row!.n;
}

/**
 * The embed-model scope check (plan 03 deliberate change 2): log `embed_model_mismatch` when some in-scope chunks
 * were embedded with another model, and throw before any persona embed or LLM spend when every in-scope chunk is
 * excluded. A no-op on an empty id list. Used by generate_feed, generate_chapter and the podcast.
 */
export async function assertEmbedModelScope(sql: Sql, paperIds: string[], model: string, log: Logger): Promise<void> {
  if (paperIds.length === 0) return;
  const mismatched = await countEmbedModelMismatch(sql, paperIds, model);
  if (mismatched > 0) log.warn({ expected: model, excluded_chunks: mismatched }, 'embed_model_mismatch');
  if (mismatched > 0 && mismatched === (await countScopeChunks(sql, paperIds))) {
    throw new Error(
      `No chunks embedded with ${model}: ${mismatched} chunks in scope use a different embedding model. Re-process your papers or switch the embedding model back.`,
    );
  }
}
