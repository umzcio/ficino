import { pyStrip } from '../shared/pystr.js';

/**
 * The text a chunk is embedded from: the contextual prefix, a blank line and the content, stripped like Python's
 * `str.strip()`; the bare content when there is no prefix. Ingestion and the re-embed share it, so a re-embedded
 * vector matches the one ingestion would have written.
 */
export function chunkEmbedText(c: { content: string; contextual_prefix?: string | null }): string {
  return c.contextual_prefix ? pyStrip(`${c.contextual_prefix}\n\n${c.content}`) : c.content;
}
