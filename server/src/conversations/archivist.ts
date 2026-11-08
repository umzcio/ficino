// Pure half of worker/tasks/archivist_tasks.py: prompt constants, chunk rendering, Python str.format for the
// system prompt, and the post-LLM citation scrubber.
import type { Chunk } from '../feed/types.js';
import { PY_WORD, PY_WS, pySplit, pyStr, pyStrip } from '../shared/pystr.js';
import { fenceUntrusted, sanitizeInline } from '../shared/sanitize.js';

/** `_ARCHIVIST_SYSTEM_FALLBACK`, used when the `archivist` persona row is missing or its prompt is blank. */
export const ARCHIVIST_SYSTEM_FALLBACK = `You are The Archivist, a neutral research assistant embedded in Ficino. You have read every paper in the user's corpus. Your job is to answer the user's question directly, grounding every claim in specific passages from the papers.

Rules:
- Cite papers by author and year (e.g., "Chen & Park (2023) found that...")
- When papers disagree, present both sides without taking one
- When the corpus doesn't contain relevant information, say so clearly
- Structure longer answers with bullet points or numbered lists
- Be precise, thorough, and honest
- Keep answers focused — 2-6 sentences for simple questions, longer with structure for complex ones
- Do NOT use JSON formatting. Respond in natural prose.
- Do NOT invent findings. Only cite what appears in the provided context.`;

/** `_ARCHIVIST_CONTEXT_SUFFIX`, appended to whichever base prompt is used. `{chunks}` is filled by pyFormatChunks. */
export const ARCHIVIST_CONTEXT_SUFFIX = `

FORMATTING: Use real line breaks. Every markdown heading (## ### ####) must sit on its own line with a blank line above and below it. Every horizontal rule (---) must sit on its own line with a blank line above and below. Every list item must be on its own line. Never concatenate a heading and body text onto one line.

HEADINGS: Use plain descriptive phrases as headings (e.g., \`## The Bunker as Entry Point\`, not \`## Taylor (2021): The Bunker\` or \`## Taylor — The Bunker\`). Do not prefix headings with author names, years, citations, colons, or em-dashes. Cite papers in the body text instead.

CORPUS CONTEXT:
{chunks}`;

export const NO_PASSAGES = 'No relevant passages found in the corpus.';

/** The canned replies stored when the owner has no complete papers in scope (they differ between the two tasks). */
export const EMPTY_CORPUS_REPLY =
  "Your corpus is empty — I don't have any papers to search. Upload some PDFs and I'll be able to answer questions about them.";
export const EMPTY_CORPUS_FOLLOWUP_REPLY = "Your corpus is empty — I don't have any papers to search.";

/** Deliberate change 5: the reply stored when every in-scope chunk was embedded with another model. */
export const embedMismatchReply = (model: string, n: number): string =>
  `None of your papers are searchable with the current embedding model (${model}): ${n} chunks in scope use a different one. Re-process your papers or switch the embedding model back.`;

// ------------------------------------------------------------------ str.format

const pyError = (type: string, msg: string): Error => new Error(`${type}: ${msg}`);

const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python `repr(str)`, for KeyError messages. */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === ' ' || !NON_PRINTABLE_RE.test(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += `\\U${cp.toString(16).padStart(8, '0')}`;
  }
  return out + quote;
}

const ND_RE = /^\p{Nd}$/u;
const PY_SSIZE_T_MAX = 2n ** 63n - 1n;

/** Py_UNICODE_TODECIMAL: Nd digits sit in runs of ten starting at zero, so the value is the offset in the run. */
function decimalValue(ch: string): number {
  if (!ND_RE.test(ch)) return -1;
  let cp = ch.codePointAt(0)!;
  let start = cp;
  while (ND_RE.test(String.fromCodePoint(start - 1))) start--;
  cp -= start;
  return cp % 10;
}

/** CPython `get_integer`: the field name's numeric index, or -1 when it is empty or not all decimal digits. */
function getInteger(s: string): number {
  if (s === '') return -1;
  let acc = 0n;
  for (const ch of s) {
    const d = decimalValue(ch);
    if (d < 0) return -1;
    if (acc > (PY_SSIZE_T_MAX - BigInt(d)) / 10n) throw pyError('ValueError', 'Too many decimal digits in format string');
    acc = acc * 10n + BigInt(d);
  }
  return Number(acc);
}

const unsupported = (field: string): Error =>
  pyError('ValueError', `Unsupported replacement field {${field}}: the archivist prompt allows only {chunks}`);

/**
 * Python `template.format(chunks=chunks)`, ported from CPython's MarkupIterator/parse_field so every syntax error
 * and lookup error raises where, and with the message, Python's does (`<ExceptionType>: <str(exc)>`, the KeyError
 * text being Python's repr of the name). The only field rendered is `{chunks}` with an empty (possibly expanded)
 * format spec. A conversion (`!r`), attribute or index access (`.a`, `[0]`) or non-empty spec on `chunks` throws
 * `ValueError: Unsupported replacement field`, where Python would sometimes render it. The substituted value is
 * never re-scanned.
 */
export function pyFormatChunks(template: string, chunks: string): string {
  return render(template, chunks, 2);
}

function render(s: string, chunks: string, depth: number): string {
  if (depth <= 0) throw pyError('ValueError', 'Max string recursion exceeded');
  const n = s.length;
  let i = 0;
  let out = '';
  while (i < n) {
    // Literal text up to the first '{' or '}'.
    const start = i;
    let c = '';
    let markup = false;
    while (i < n) {
      c = s[i++]!;
      if (c === '{' || c === '}') {
        markup = true;
        break;
      }
    }
    const atEnd = i >= n;
    let len = i - start;
    if (markup && c === '}' && (atEnd || s[i] !== '}')) {
      throw pyError('ValueError', "Single '}' encountered in format string");
    }
    if (markup && atEnd && c === '{') throw pyError('ValueError', "Single '{' encountered in format string");
    if (markup && !atEnd) {
      if (s[i] === c) {
        // An escaped '{{' or '}}': the literal keeps one brace.
        i++;
        markup = false;
      } else len--;
    }
    out += s.slice(start, start + len);
    if (!markup) continue;

    // parse_field: the field name runs to '}', ':' or '!'; '[' skips to the next ']'.
    const nameStart = i;
    c = '';
    while (i < n) {
      c = s[i++]!;
      if (c === '{') throw pyError('ValueError', "unexpected '{' in field name");
      if (c === '[') {
        while (i < n && s[i] !== ']') i++;
        continue;
      }
      if (c === '}' || c === ':' || c === '!') break;
    }
    const fieldName = s.slice(nameStart, i - 1);
    let conversion = '';
    let spec = '';
    let specNeedsExpanding = false;
    if (c === '!' || c === ':') {
      let closed = false;
      if (c === '!') {
        if (i >= n) throw pyError('ValueError', 'end of string while looking for conversion specifier');
        conversion = String.fromCodePoint(s.codePointAt(i)!);
        i += conversion.length;
        if (i < n) {
          const next = s[i++]!;
          if (next === '}') closed = true;
          else if (next !== ':') throw pyError('ValueError', "expected ':' after conversion specifier");
        }
      }
      if (!closed) {
        const specStart = i;
        let count = 1;
        while (i < n) {
          const ch = s[i++]!;
          if (ch === '{') {
            specNeedsExpanding = true;
            count++;
          } else if (ch === '}' && --count === 0) {
            spec = s.slice(specStart, i - 1);
            closed = true;
            break;
          }
        }
        if (!closed) throw pyError('ValueError', "unmatched '{' in format spec");
      }
    } else if (c !== '}') {
      throw pyError('ValueError', "expected '}' before end of string");
    }

    // get_field_object: the first name part (up to '.' or '[') is looked up before anything else is applied.
    const cut = fieldName.search(/[.[]/);
    const first = cut === -1 ? fieldName : fieldName.slice(0, cut);
    const index = getInteger(first);
    if (first === '' || index !== -1) {
      throw pyError('IndexError', `Replacement index ${first === '' ? 0 : index} out of range for positional args tuple`);
    }
    if (first !== 'chunks') throw pyError('KeyError', pyRepr(first));
    if (cut !== -1 || conversion !== '') throw unsupported(s.slice(nameStart, i - 1));
    if (specNeedsExpanding) spec = render(spec, chunks, depth - 1);
    if (spec !== '') throw unsupported(s.slice(nameStart, i - 1));
    out += chunks;
  }
  return out;
}

// ------------------------------------------------------------------- prompts

/**
 * The `chunks_text` both tasks build: one fenced block per chunk, or the no-passages line. The title and section
 * come from the PDF, so they go through `sanitizeInline` like every other prompt header (Python put them in raw).
 */
export function archivistChunksText(chunks: Chunk[]): string {
  if (chunks.length === 0) return NO_PASSAGES;
  return chunks
    .map((c) => {
      // c.get(key, default): the default only when the key is absent; a present None prints None.
      const title = sanitizeInline(c.paper_title === undefined ? 'Unknown' : pyStr(c.paper_title));
      const section = sanitizeInline(c.section === undefined ? 'unknown' : pyStr(c.section));
      return `[${title} — ${section}]\n${fenceUntrusted(pyStr(c.content))}`;
    })
    .join('\n\n');
}

/** The follow-up task's user prompt: the thread as a transcript, then the instruction. */
export function followupUserPrompt(original: string, replies: Array<Record<string, unknown>>): string {
  const lines = [`USER: ${pyStr(original)}`];
  for (const r of replies.slice(0, -1)) {
    const role = r.role === 'user' ? 'USER' : 'ARCHIVIST';
    lines.push(`${role}: ${'content' in r ? pyStr(r.content) : ''}`);
  }
  lines.push(`USER: ${pyStr(replies.at(-1)?.content)}`);
  const transcript = lines.join('\n\n');
  return (
    'This is an ongoing conversation with the user about their corpus. ' +
    'The full thread so far:\n\n' +
    `${transcript}\n\n` +
    'Respond to the most recent USER message, continuing the conversation naturally. ' +
    'Draw on the fresh corpus passages provided in the system prompt.'
  );
}

// ----------------------------------------------------------------- citations

/**
 * `_CITATION_PATTERN` with Python's Unicode semantics: `\b` before `[A-Z]` is "no word character before", `\s` is
 * Python's whitespace and `\d` any Unicode decimal digit. Groups: 1 the name, 2 the optional "et al.", 3 the year.
 */
export const CITATION_RE = new RegExp(
  `(?<!${PY_WORD})([A-Z][a-zA-Z\\u00C0-\\u024F'\\-]+)((?:[${PY_WS}]+et[${PY_WS}]+al\\.?)?)[${PY_WS}]*\\((\\p{Nd}{4})\\)`,
  'gu',
);

const citationKey = (last: string, year: string): string => `${last}\u0000${year}`;

const truthy = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && v.length === 0);

/** `_known_citations`: (first author's lower-cased last name, year) for every retrieved chunk that has both. */
export function knownCitations(chunks: Chunk[]): Set<string> {
  const known = new Set<string>();
  for (const c of chunks) {
    const authors = (c.paper_authors as unknown) || [];
    const year = c.paper_year as unknown;
    if (!truthy(authors) || !truthy(year)) continue;
    const first = Array.isArray(authors) ? (authors[0] as unknown) : authors;
    const stripped = pyStrip(pyStr(first));
    const last = stripped ? pySplit(stripped).at(-1)!.toLowerCase() : '';
    if (last) known.add(citationKey(last, pyStr(year)));
  }
  return known;
}

const WS_COMMA_RE = new RegExp(`[${PY_WS}]+,`, 'g');
const WS_RUN_RE = new RegExp(`[${PY_WS}]{2,}`, 'g');

/** `_validate_citations`: strip `Author (YYYY)` citations no retrieved chunk grounds, then tidy the whitespace. */
export function validateCitations(text: string, known: Set<string>): { text: string; hallucinated: string[] } {
  const hallucinated: string[] = [];
  let cleaned = text.replace(CITATION_RE, (m: string, name: string, _etAl: string, year: string) => {
    if (known.has(citationKey(name.toLowerCase(), year))) return m;
    hallucinated.push(m);
    return '';
  });
  cleaned = cleaned.replace(WS_COMMA_RE, ',');
  cleaned = pyStrip(cleaned.replace(WS_RUN_RE, ' '));
  return { text: cleaned, hallucinated };
}
