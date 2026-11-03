import type { ProviderConfig } from './config.js';
import type { ProviderDeps } from './deps.js';
import { fetchJson, HttpStatusError, isTransient, withRetry } from './http.js';
import { mapLimit } from '../shared/mapLimit.js';

/** Plays the role of Python's RuntimeError for embedding failures; callers must not retry it. */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

type Opts = { inputType: 'document' | 'query'; signal?: AbortSignal };

const TIMEOUT_MS = 120_000;
const OLLAMA_BATCH = 16;
const OLLAMA_IN_FLIGHT = 4;
const VOYAGE_BATCH = 128;
const OPENAI_BATCH = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function checkBatch(provider: string, vecs: unknown[], batch: unknown[]): void {
  if (vecs.length !== batch.length) {
    throw new EmbeddingUnavailableError(`${provider} returned ${vecs.length} embeddings for ${batch.length} inputs`);
  }
}

function vectors(body: unknown): number[][] {
  const e = (body as { embeddings?: unknown } | null)?.embeddings;
  return Array.isArray(e) ? (e as number[][]) : [];
}

function dataVectors(body: unknown, sortByIndex: boolean): number[][] {
  const d = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(d)) return [];
  const items = d as Array<{ index?: number; embedding: number[] }>;
  const ordered = sortByIndex ? [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : items;
  return ordered.map((i) => i.embedding);
}

async function embedOllama(p: ProviderConfig, deps: ProviderDeps, texts: string[], o: Opts): Promise<number[][]> {
  const batches = chunk(texts, OLLAMA_BATCH);
  const results = await mapLimit(batches, OLLAMA_IN_FLIGHT, async (batch) => {
    const vecs = await withRetry(
      async () =>
        vectors(
          await fetchJson(deps, `${p.ollamaBaseUrl}/api/embed`, {
            body: { model: p.embed.ollamaModel, input: batch, dimensions: p.embed.dim },
            timeoutMs: TIMEOUT_MS,
            signal: o.signal,
          }),
        ),
      { attempts: 3, delaysMs: [2000, 6000], retryable: (e) => isTransient(e, o.signal), sleep: deps.sleep, signal: o.signal },
    );
    checkBatch('ollama', vecs, batch);
    return vecs;
  });
  return results.flat();
}

async function embedVoyage(p: ProviderConfig, deps: ProviderDeps, texts: string[], o: Opts): Promise<number[][]> {
  const out: number[][] = [];
  const batches = chunk(texts, VOYAGE_BATCH);
  for (const [i, batch] of batches.entries()) {
    const vecs = await withRetry(
      async () =>
        dataVectors(
          await fetchJson(deps, 'https://api.voyageai.com/v1/embeddings', {
            headers: { authorization: `Bearer ${p.embed.voyageKey}` },
            body: {
              input: batch,
              model: p.embed.voyageModel,
              input_type: o.inputType,
              output_dimension: p.embed.dim,
            },
            timeoutMs: TIMEOUT_MS,
            signal: o.signal,
          }),
          true,
        ),
      {
        attempts: 5,
        delaysMs: [20000, 40000, 60000, 80000],
        retryable: (e) => e instanceof HttpStatusError && e.status === 429,
        sleep: deps.sleep,
        signal: o.signal,
      },
    );
    checkBatch('voyage', vecs, batch);
    out.push(...vecs);
    if (i < batches.length - 1) await deps.sleep(500, o.signal);
  }
  return out;
}

async function embedOpenai(p: ProviderConfig, deps: ProviderDeps, texts: string[], o: Opts): Promise<number[][]> {
  const out: number[][] = [];
  const batches = chunk(texts, OPENAI_BATCH);
  for (const [i, batch] of batches.entries()) {
    const vecs = await withRetry(
      async () =>
        dataVectors(
          await fetchJson(deps, 'https://api.openai.com/v1/embeddings', {
            headers: { authorization: `Bearer ${p.embed.openaiKey}` },
            // dimensions is required: text-embedding-3-small defaults to 1536-d, which fails the dim check.
            body: { model: p.embed.openaiModel, input: batch, dimensions: p.embed.dim },
            timeoutMs: TIMEOUT_MS,
            signal: o.signal,
          }),
          true,
        ),
      {
        attempts: 3,
        delaysMs: [2000, 6000],
        retryable: (e) => isTransient(e, o.signal) || (e instanceof HttpStatusError && e.status === 429),
        sleep: deps.sleep,
        signal: o.signal,
      },
    );
    checkBatch('openai', vecs, batch);
    out.push(...vecs);
    if (i < batches.length - 1) await deps.sleep(1000, o.signal);
  }
  return out;
}

export async function embedTexts(
  p: ProviderConfig,
  deps: ProviderDeps,
  texts: string[],
  opts: Opts,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { provider } = p.embed;
  let result: number[][];
  if (provider === 'ollama') result = await embedOllama(p, deps, texts, opts);
  else if (provider === 'openai' && p.embed.openaiKey) result = await embedOpenai(p, deps, texts, opts);
  else if (provider === 'voyage' && p.embed.voyageKey) result = await embedVoyage(p, deps, texts, opts);
  else {
    const reason =
      `provider='${provider}', ` +
      `openai_key=${p.embed.openaiKey ? 'set' : 'missing'}, ` +
      `voyage_key=${p.embed.voyageKey ? 'set' : 'missing'}`;
    throw new EmbeddingUnavailableError(`No embedding provider reachable: ${reason}`);
  }

  // Fail loud rather than bind chunk i's text to chunk j's vector, or store wrong-sized vectors.
  if (result.length !== texts.length) {
    throw new EmbeddingUnavailableError(
      `embed_texts length mismatch: provider=${provider} returned ${result.length} vectors for ${texts.length} inputs`,
    );
  }
  const expected = p.embed.dim;
  for (const [idx, vec] of result.entries()) {
    if (!Array.isArray(vec) || vec.length !== expected) {
      throw new EmbeddingUnavailableError(
        `embed_texts dim mismatch: provider=${provider} vector[${idx}] has dim=${Array.isArray(vec) ? vec.length : 'n/a'}, expected ${expected}`,
      );
    }
  }
  return result;
}

export function embedModelId(p: ProviderConfig): string {
  const { provider, dim } = p.embed;
  const model =
    provider === 'voyage' ? p.embed.voyageModel : provider === 'openai' ? p.embed.openaiModel : p.embed.ollamaModel;
  return `${provider}:${model}@${dim}`;
}
