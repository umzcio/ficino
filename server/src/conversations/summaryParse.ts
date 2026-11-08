// Prompts and output parsing for the paper-summary and corpus-synthesis jobs: a port of the module constants,
// `_coerce_messages` and the inline prompt building and parsing in `worker/tasks/summary_tasks.py`.
// test/conversations/summaryParse.test.ts pins them to goldens produced by the real Celery tasks.
import { pySlice, pyStr, pyStrip } from '../shared/pystr.js';
import { fenceUntrusted, sanitizeInline } from '../shared/sanitize.js';

export const PAPER_SUMMARY_SYSTEM = `You are a research paper summarizer for an academic discourse platform.
Your job is to create a structured summary of a paper presented as a series of chat messages —
as if the paper itself is talking to the reader, explaining what it found.

Keep each message focused on ONE aspect. Be specific, cite numbers and findings from the text.
Use an accessible, conversational tone — not dry academic language.
Do NOT use markdown headers. Write plain text for each message.`;

export function paperSummaryPrompt(title: string, chunks: string): string {
  return `Based on these extracted sections from the paper "${title}", generate a structured summary
as a JSON array of message objects. Each message should cover one aspect of the paper.

PAPER CONTENT:
${chunks}

Generate 8-9 messages covering these types IN THIS ORDER:

1. "tldr" — The bottom line in ONE sentence. What did this paper find or prove? Write it like you're texting a friend the punchline. No preamble, just the core takeaway. Do NOT use markdown formatting (no asterisks, no bold markers). Plain text only. Example: "Basically, only 10% of AI governance frameworks have ever been tested in a real institution."

2. "intro" — A warm, conversational overview of who wrote this and what they set out to do. Introduce the team/context, explain the problem they're tackling. THEN end with a sentence that previews the key finding — connect the setup to the punchline. Don't just introduce, land it.

3. "question" — The specific research question or problem statement they investigated.

4. "methods" — How they studied it. Specific approach, sample size, data sources.

5. "findings" — The most important results with specific numbers, counts, or percentages from the text.

6. "surprise" — What was unexpected or stood out. The thing that makes you go "huh, really?"

7. "limitations" — What the authors acknowledge they couldn't capture or control for. Be honest.

8. "implications" — Why this matters. What should change because of this work?

9. (Optional) "figure" — Highlight a specific figure or table if referenced in the text.

Respond with ONLY a JSON array:
[
  {"role": "paper", "type": "tldr", "content": "..."},
  {"role": "paper", "type": "intro", "content": "..."},
  {"role": "paper", "type": "question", "content": "..."},
  {"role": "paper", "type": "methods", "content": "..."},
  {"role": "paper", "type": "findings", "content": "..."},
  {"role": "paper", "type": "surprise", "content": "..."},
  {"role": "paper", "type": "limitations", "content": "..."},
  {"role": "paper", "type": "implications", "content": "..."}
]`;
}

export const SYNTHESIS_SYSTEM = `You are an academic synthesis engine. You analyze multiple papers together and produce
a structured conversation showing how they relate — where they agree, where they disagree,
and what gaps exist between them. Present this as a group chat where each paper speaks for itself.`;

export function synthesisPrompt(paperChunks: string): string {
  return `Synthesize these papers into a group conversation. Each paper should "speak"
about its findings, and the conversation should highlight agreements, contradictions, and gaps.

PAPERS AND THEIR KEY CHUNKS:
${paperChunks}

Generate 8-12 messages as a JSON array. Each message should reference which paper is speaking.
Include at least:
- Each paper introducing its main finding
- At least one agreement between papers
- At least one disagreement or tension
- A gap or question that none of the papers fully address

Respond with ONLY a JSON array:
[
  {"role": "paper", "paper_ref": "Author et al. YEAR", "type": "intro", "content": "..."},
  {"role": "paper", "paper_ref": "Author et al. YEAR", "type": "finding", "content": "..."},
  {"role": "synthesis", "type": "agreement", "content": "These papers agree that..."},
  {"role": "synthesis", "type": "contradiction", "content": "However, Paper A found X while Paper B found Y..."},
  {"role": "synthesis", "type": "gap", "content": "None of these papers address..."}
]`;
}

export type SummaryPaperRow = { title: string | null; filename: string };
export type SummaryChunkRow = { section: string; content: string };
export type SynthesisPaperRow = {
  title: string | null;
  filename: string;
  sections: string[] | null;
  contents: string[] | null;
};

/**
 * The summary prompt for a paper and its first chunks. Chunk content and the title are PDF-origin, so both are
 * fenced, and the section headings are sanitized (Python put them in raw); the joined chunk text is cut to 8000 code points after fencing, as Python's `chunks_text[:8000]`.
 */
export function buildPaperSummaryPrompt(paper: SummaryPaperRow, chunks: SummaryChunkRow[]): string {
  const chunksText = chunks
    .map((row) => `[${sanitizeInline(pyStr(row.section).toUpperCase())}]\n${fenceUntrusted(pyStr(row.content))}`)
    .join('\n\n');
  const title = paper.title || paper.filename;
  return paperSummaryPrompt(fenceUntrusted(pyStr(title)), pySlice(chunksText, 0, 8000));
}

/**
 * The synthesis prompt for the LATERAL query's rows: papers without chunks are skipped, section headings are
 * sanitized, each chunk is cut to 300 code points before fencing, and the combined text to 10 000. Throws when no paper has chunks.
 */
export function buildSynthesisPrompt(paperRows: SynthesisPaperRow[]): string {
  const paperSections: string[] = [];
  for (const paper of paperRows) {
    const sections = paper.sections ?? [];
    const contents = paper.contents ?? [];
    if (contents.length === 0) continue;
    const title = paper.title || paper.filename;
    const n = Math.min(sections.length, contents.length); // zip()
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(`[${sanitizeInline(pyStr(sections[i]))}]\n${fenceUntrusted(pySlice(pyStr(contents[i]), 0, 300))}`);
    }
    paperSections.push(`=== ${fenceUntrusted(pyStr(title))} ===\n${lines.join('\n')}`);
  }
  if (paperSections.length === 0) throw new Error('No chunks found for any of the papers');
  return synthesisPrompt(pySlice(paperSections.join('\n\n'), 0, 10000));
}

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `_coerce_messages`: keep the objects whose `content` is a non-empty string; a non-array gives []. */
export function coerceMessages(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((m): m is Record<string, unknown> => isDict(m) && typeof m.content === 'string' && m.content !== '');
}

const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const ARRAY_SPAN_RE = /\[[\s\S]*\]/;

export type ParsedChat = { messages: Record<string, unknown>[]; warning: 'parse_failed' | 'parse_empty' | null };

/**
 * The tasks' inline parsing: strip `<think>` blocks, parse the greedy `[ … ]` span and keep well-shaped messages.
 * A span that fails to parse becomes one `summary` bubble of the cleaned text (`parse_failed`); no span, or nothing
 * kept, becomes one bubble of the cleaned text or `emptyContent` (`parse_empty`). Never returns [].
 */
export function parseChatMessages(
  raw: string,
  fallbackRole: 'paper' | 'synthesis',
  emptyContent: string,
): ParsedChat {
  const cleaned = pyStrip(raw.replace(THINK_RE, ''));
  const match = ARRAY_SPAN_RE.exec(cleaned);
  if (match) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { messages: [{ role: fallbackRole, type: 'summary', content: cleaned }], warning: 'parse_failed' };
    }
    const messages = coerceMessages(parsed);
    if (messages.length > 0) return { messages, warning: null };
  }
  return {
    messages: [{ role: fallbackRole, type: 'summary', content: cleaned || emptyContent }],
    warning: 'parse_empty',
  };
}
