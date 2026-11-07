// Port of worker/lib/contextualizer.py: a 1-2 sentence situating prefix per chunk.
import { logger } from '../logger.js';
import type { ProviderConfig } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { fetchJson } from '../providers/http.js';
import { mapLimit } from '../shared/mapLimit.js';
import { pySlice, pyStrip } from '../shared/pystr.js';
import type { Chunk } from './chunker.js';

export const CONTEXT_SYSTEM_PROMPT =
  'You situate a short excerpt inside its source academic paper. ' +
  'You write one or two concise sentences (<=50 words total) that say ' +
  'what the excerpt is about and where it fits in the paper. ' +
  "Do NOT quote the excerpt. Do NOT begin with 'This chunk' or 'The excerpt'. " +
  'Write plain prose a human could read as a prefix before the excerpt. ' +
  'Output only the sentences, no preamble.';

const TEMPERATURE = 0.2;
const ANTHROPIC_CONCURRENCY = 8;

export function buildOllamaUserPrompt(paperText: string, chunkContent: string, maxPaperChars: number): string {
  return `<paper>\n${pySlice(paperText, 0, maxPaperChars)}\n</paper>\n\n<excerpt>\n${chunkContent}\n</excerpt>\n\nWrite the contextual prefix for the excerpt.`;
}

export function buildAnthropicUserText(chunkContent: string): string {
  return `<excerpt>\n${chunkContent}\n</excerpt>\n\nWrite the contextual prefix for the excerpt.`;
}

async function contextOllama(
  p: ProviderConfig,
  deps: ProviderDeps,
  paperText: string,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<string[]> {
  const out: string[] = [];
  // Serial on purpose: a shared single-GPU Ollama would only queue parallel calls.
  for (const chunk of chunks) {
    signal?.throwIfAborted();
    try {
      const data = (await fetchJson(deps, `${p.ollamaBaseUrl}/api/chat`, {
        body: {
          model: p.context.ollamaModel,
          messages: [
            { role: 'system', content: CONTEXT_SYSTEM_PROMPT },
            { role: 'user', content: buildOllamaUserPrompt(paperText, chunk.content, p.context.maxPaperChars) },
          ],
          stream: false,
          think: false,
          options: { temperature: TEMPERATURE, num_predict: p.context.maxTokens },
        },
        timeoutMs: 300_000,
        signal,
      })) as { message: { content?: string | null; thinking?: string | null } };
      const msg = data.message;
      out.push(pyStrip(msg.content || msg.thinking || ''));
    } catch (e) {
      if (signal?.aborted) throw e;
      out.push(''); // best-effort: one bad chunk must not drop every prefix
    }
  }
  return out;
}

async function contextAnthropic(
  p: ProviderConfig,
  deps: ProviderDeps,
  paperText: string,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<string[]> {
  const client = deps.anthropic(p.context.anthropicKey, {});
  const paper = pySlice(paperText, 0, p.context.maxPaperChars);
  const system = [
    { type: 'text', text: CONTEXT_SYSTEM_PROMPT }, // small, deliberately not cached
    { type: 'text', text: `<paper>\n${paper}\n</paper>`, cache_control: { type: 'ephemeral' } },
  ];
  return mapLimit(chunks, ANTHROPIC_CONCURRENCY, async (chunk) => {
    try {
      const resp = await client.messages.create(
        {
          model: p.context.anthropicModel,
          max_tokens: p.context.maxTokens,
          temperature: TEMPERATURE,
          system,
          messages: [{ role: 'user', content: buildAnthropicUserText(chunk.content) }],
        },
        { signal },
      );
      return pyStrip(resp.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''));
    } catch (e) {
      if (signal?.aborted) throw e;
      return '';
    }
  });
}

/**
 * One prefix per chunk ('' = none: provider off, that chunk failed, or the paper is over the chunk cap). A job abort
 * rejects.
 *
 * Every chunk costs one provider call, so a paper with more than `p.context.maxChunks` chunks is not contextualized at
 * all (not just its first chunks): a whole paper either has prefixes or has none, and a book-sized upload, whose text
 * the prompt truncates at `maxPaperChars` anyway, spends nothing here.
 */
export async function generateContexts(
  p: ProviderConfig,
  deps: ProviderDeps,
  paperText: string,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (chunks.length === 0) return [];
  const none = () => chunks.map(() => '');
  const provider = p.context.provider;
  const calls = provider === 'ollama' || (provider === 'anthropic' && Boolean(p.context.anthropicKey));
  if (!calls) return none();
  if (chunks.length > p.context.maxChunks) {
    logger.warn({ chunks: chunks.length, max_chunks: p.context.maxChunks, provider }, 'contextualizer_chunk_cap_hit');
    return none();
  }
  return provider === 'ollama'
    ? contextOllama(p, deps, paperText, chunks, signal)
    : contextAnthropic(p, deps, paperText, chunks, signal);
}
