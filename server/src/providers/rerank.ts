import type { Logger } from 'pino';
import type { ProviderConfig } from './config.js';
import type { ProviderDeps } from './deps.js';
import { fetchJson } from './http.js';
import { pySlice } from '../shared/pystr.js';
import type { Chunk } from '../feed/types.js';

const TIMEOUT_MS = 30_000;

type Item = { index?: unknown; relevance_score?: unknown };

/** Map hosted scores back onto the chunks by `index`; out-of-range and negative indexes are skipped. */
function applyScores(chunks: Chunk[], items: unknown): void {
  if (!Array.isArray(items)) throw new Error('rerank response has no result list');
  // Validate every score before touching a chunk, so a failure leaves the caller's chunks unscored.
  const scored: Array<[number, number]> = [];
  for (const item of items as Item[]) {
    const idx = item.index;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= chunks.length) continue;
    // Python's float(item["relevance_score"]) raises on a missing or non-numeric score.
    const score = typeof item.relevance_score === 'string' ? Number(item.relevance_score) : item.relevance_score;
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('rerank result has no numeric relevance_score');
    scored.push([idx, score]);
  }
  for (const [idx, score] of scored) chunks[idx]!.rerank_score = score;
}

/**
 * Port of reranker.rerank. The local cross-encoder is dropped (deliberate change 5): `local` passes through.
 * Sets rerank_score on the given chunk objects, as Python does. Any provider error degrades to the input order;
 * only the caller's own abort is rethrown.
 */
export async function rerank(
  p: ProviderConfig,
  deps: ProviderDeps,
  query: string,
  chunks: Chunk[],
  topK: number,
  o: { logger: Logger; signal?: AbortSignal },
): Promise<Chunk[]> {
  if (chunks.length === 0) return chunks;
  const { provider } = p.rerank;
  if (provider === 'none' || chunks.length < 2) return chunks.slice(0, topK);
  if (provider === 'local') {
    o.logger.warn({ provider }, 'rerank_local_unavailable_passthrough');
    return chunks.slice(0, topK);
  }
  if (provider !== 'voyage' && provider !== 'cohere') {
    o.logger.warn({ provider }, 'rerank_unknown_provider_passthrough');
    return chunks.slice(0, topK);
  }

  const key = provider === 'voyage' ? p.rerank.voyageKey : p.rerank.cohereKey;
  if (key) {
    const documents = chunks.map((c) => String(c.content ?? ''));
    try {
      const body =
        provider === 'voyage'
          ? await fetchJson(deps, 'https://api.voyageai.com/v1/rerank', {
              headers: { authorization: `Bearer ${key}` },
              body: { query, documents, model: p.rerank.voyageModel, top_k: documents.length },
              timeoutMs: TIMEOUT_MS,
              signal: o.signal,
            })
          : await fetchJson(deps, 'https://api.cohere.com/v2/rerank', {
              headers: { authorization: `Bearer ${key}` },
              body: { query, documents, model: p.rerank.cohereModel, top_n: documents.length },
              timeoutMs: TIMEOUT_MS,
              signal: o.signal,
            });
      const b = body as { data?: unknown; results?: unknown } | null;
      applyScores(chunks, provider === 'voyage' ? b?.data : b?.results);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      o.logger.warn({ provider, error: pySlice(e instanceof Error ? e.message : String(e), 0, 200) }, 'rerank_failed_passthrough');
      return chunks.slice(0, topK);
    }
  } else {
    o.logger.warn({}, `rerank_${provider}_no_api_key_passthrough`);
  }

  // Unscored chunks sort as -inf; Array.sort is stable, matching Python's list.sort.
  const score = (c: Chunk) => (c.rerank_score == null ? -Infinity : c.rerank_score);
  const sorted = [...chunks].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    return x === y ? 0 : y > x ? 1 : -1;
  });
  return sorted.slice(0, topK);
}
