// Port of worker/tasks/reading_list_tasks.py: the propose_ordering prompt, `_parse_ordering_json` and the ordering
// validation (W §2.8). Pure functions, pinned to test/fixtures/goldens/reading-list-ordering.json.
import { PY_WS, pySlice, pyStr } from '../shared/pystr.js';
import { fenceUntrusted } from '../shared/sanitize.js';

/** One row of the ordering query: a paper and its first chunks, by chunk_index. */
export type OrderingRow = {
  id: string;
  title: string | null;
  authors: string[] | null;
  year: number | null;
  filename: string | null;
  chunks: string[];
};

/** Python's `papers_context` item. */
export type OrderingPaper = {
  paper_id: string;
  title: string | null;
  authors: string;
  year: number | string;
  preview: string;
};

/** One entry of the persisted rationale (and of the job's `ordered_papers`). */
export type OrderedPaper = {
  paper_id: unknown;
  position: unknown;
  rationale: unknown;
  title: string | null;
  authors: string;
  year: number | string;
};

/** The `propose_ordering_id_mismatch` log payload. */
export type OrderingMismatch = {
  missing: string[];
  extra: unknown[];
  input_count: number;
  returned_count: number;
};

export const ORDERING_USER = 'Analyze these papers and propose the optimal reading order. Return JSON only.';

// ORDERING_SYSTEM as rendered by str.format (`{{`/`}}` are single braces); `{papers}` is the one placeholder.
const ORDERING_SYSTEM = `You are The Archivist, analyzing a set of academic papers to propose an optimal reading order.

Your job is to order these papers from "read first" to "read last" based on:
1. Foundational vs. derivative — papers that define frameworks come before papers that test them
2. Citation dependencies — if Paper B cites Paper A, A should come first
3. Conceptual progression — simpler concepts before complex ones
4. Chronological where relevant — earlier work that establishes a field before recent additions

For each paper, provide a one-sentence rationale explaining why it belongs at that position in the sequence.

PAPERS IN THE CORPUS:
{papers}

Respond in JSON format:
[
  {"paper_id": "uuid-here", "position": 1, "rationale": "Establishes the foundational framework that three other papers reference."},
  {"paper_id": "uuid-here", "position": 2, "rationale": "Introduces the key methodology used by later empirical studies."}
]

Order ALL papers. Return valid JSON only.`;

/** Python's `papers_context`: `title or filename`, joined authors or `Unknown`, `year or "Unknown"`, the preview. */
export function orderingContext(rows: OrderingRow[]): OrderingPaper[] {
  return rows.map((r) => {
    const chunks = r.chunks ?? [];
    const preview = chunks.map((c) => pySlice(pyStr(c), 0, 200)).join(' ');
    return {
      paper_id: String(r.id),
      title: r.title || r.filename,
      authors: r.authors && r.authors.length > 0 ? r.authors.join(', ') : 'Unknown',
      year: r.year || 'Unknown',
      preview: pySlice(preview, 0, 500),
    };
  });
}

/** `ORDERING_SYSTEM.format(papers=...)`; titles, authors and previews are PDF-origin, so each is fenced. */
export function orderingSystemPrompt(papers: OrderingPaper[]): string {
  const text = papers
    .map(
      (p) =>
        `Paper ID: ${p.paper_id}\n` +
        `Title: ${fenceUntrusted(pyStr(p.title))}\n` +
        `Authors: ${fenceUntrusted(p.authors)} (${pyStr(p.year)})\n` +
        `Content preview: ${fenceUntrusted(p.preview)}`,
    )
    .join('\n\n');
  // A replacer function inserts the text literally (a string would expand `$&`, `$'` and `` $` ``).
  return ORDERING_SYSTEM.replace('{papers}', () => text);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const WRAPPER_KEYS = ['ordering', 'papers', 'result', 'data'] as const;

/** `_coerce`: an array's dict items, or the dict items of the first wrapper key holding an array, else `[]`. */
export function coerceOrdering(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isPlainObject);
  if (isPlainObject(v)) {
    for (const key of WRAPPER_KEYS) {
      const inner = Object.hasOwn(v, key) ? v[key] : undefined;
      if (Array.isArray(inner)) return inner.filter(isPlainObject);
    }
  }
  return [];
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function tryParse(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const FENCE_RE = new RegExp('```(?:json)?[' + PY_WS + ']*\\n?([\\s\\S]*?)```');
const ARRAY_SPAN_RE = /\[[\s\S]*\]/;

/**
 * `_parse_ordering_json`: whole text, then the first fenced block, then the greedy `[...]` span. A step whose text
 * parses at all returns its coercion, even when that is `[]`; only a decode error falls through.
 */
export function parseOrderingJson(text: string): Record<string, unknown>[] {
  const whole = tryParse(text);
  if (whole.ok) return coerceOrdering(whole.value);
  const fence = FENCE_RE.exec(text);
  if (fence) {
    const inner = tryParse(fence[1]!);
    if (inner.ok) return coerceOrdering(inner.value);
  }
  const span = ARRAY_SPAN_RE.exec(text);
  if (span) {
    const inner = tryParse(span[0]);
    if (inner.ok) return coerceOrdering(inner.value);
  }
  return [];
}

// ---- Python comparison semantics over decoded JSON values ----

/** Python's type name for a decoded JSON value (JS cannot tell `1.0` from `1`; both print `int`). */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

const isNumeric = (v: unknown): v is number | boolean => typeof v === 'number' || typeof v === 'boolean';

/** Python `==` over JSON values: numbers and bools numerically, lists element-wise, dicts by keys and values. */
export function pyEq(a: unknown, b: unknown): boolean {
  if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b);
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (a === null && b === null) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return false;
}

/** `a < b` by code point (JS `<` compares UTF-16 units, which misorders astral characters against U+E000..U+FFFF). */
function codePointLt(a: string, b: string): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return i >= a.length && j < b.length;
}

/** Python `a < b` over JSON values; an unorderable pair throws Python's TypeError. */
export function pyLt(a: unknown, b: unknown): boolean {
  if (isNumeric(a) && isNumeric(b)) return Number(a) < Number(b);
  if (typeof a === 'string' && typeof b === 'string') return codePointLt(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (!pyEq(a[i], b[i])) return pyLt(a[i], b[i]);
    return a.length < b.length;
  }
  throw new TypeError(`'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/**
 * Python's stable `list.sort(key=...)`, comparing in CPython 3.11's order for fewer than 64 items (`count_run`,
 * then `binarysort`), so an unorderable pair raises with the same operands. Larger lists use the same algorithm;
 * the order matches for well-typed keys, though a raise may name a different pair.
 */
export function pySortBy<T>(items: T[], key: (x: T) => unknown): T[] {
  const n = items.length;
  if (n < 2) return [...items];
  const keys = items.map(key);
  const vals = [...items];

  // count_run
  let run = 2;
  if (pyLt(keys[1], keys[0])) {
    while (run < n && pyLt(keys[run], keys[run - 1])) run++;
    keys.splice(0, run, ...keys.slice(0, run).reverse());
    vals.splice(0, run, ...vals.slice(0, run).reverse());
  } else {
    while (run < n && !pyLt(keys[run], keys[run - 1])) run++;
  }

  // binarysort of the rest into the sorted prefix
  for (let start = run; start < n; start++) {
    const pivotKey = keys[start];
    const pivotVal = vals[start]!;
    let l = 0;
    let r = start;
    while (l < r) {
      const p = l + ((r - l) >> 1);
      if (pyLt(pivotKey, keys[p])) r = p;
      else l = p + 1;
    }
    for (let p = start; p > l; p--) {
      keys[p] = keys[p - 1];
      vals[p] = vals[p - 1]!;
    }
    keys[l] = pivotKey;
    vals[l] = pivotVal;
  }
  return vals;
}

/** Python `dict.get(key, default)`: by key presence, so an explicit `null` stays `null`. */
const get = (o: Record<string, unknown>, k: string, d: unknown): unknown => (Object.hasOwn(o, k) ? o[k] : d);

/** A set key with Python's equality for hashable JSON values (`1 == 1.0 == True`); lists and dicts are unhashable. */
function hashKey(v: unknown): string {
  if (typeof v === 'string') return `s${v}`;
  if (isNumeric(v)) return `n${Number(v)}`;
  if (v === null || v === undefined) return 'z';
  throw new TypeError(`unhashable type: '${pyTypeName(v)}'`);
}

/**
 * The ID-set check and the ordered result. Returned ids form a set (duplicates pass); a set unlike the input's
 * falls back to the input order with empty rationales and reports the mismatch; an equal set keeps the LLM's
 * items, stably sorted by `position` with Python's `<` (which may raise TypeError).
 */
export function validateOrdering(
  papers: OrderingPaper[],
  items: Record<string, unknown>[],
): { ordered: OrderedPaper[]; mismatch: OrderingMismatch | null } {
  const meta = new Map<string, OrderingPaper>();
  for (const p of papers) meta.set(p.paper_id, p);

  const returned = new Map<string, unknown>(); // key -> first value added, as a Python set keeps
  for (const item of items) {
    const id = get(item, 'paper_id', '');
    const k = hashKey(id);
    if (!returned.has(k)) returned.set(k, id);
  }
  const inputKeys = new Set([...meta.keys()].map((id) => `s${id}`));
  const equal = returned.size === inputKeys.size && [...inputKeys].every((k) => returned.has(k));

  if (!equal) {
    const missing = [...meta.keys()].filter((id) => !returned.has(`s${id}`));
    const extra = [...returned].filter(([k]) => !inputKeys.has(k)).map(([, v]) => v);
    const ordered = papers.map((p, idx) => ({
      paper_id: p.paper_id,
      position: idx,
      rationale: '',
      title: p.title,
      authors: p.authors,
      year: p.year,
    }));
    return {
      ordered,
      mismatch: {
        missing: missing.slice(0, 5),
        extra: extra.slice(0, 5),
        input_count: inputKeys.size,
        returned_count: returned.size,
      },
    };
  }

  const result = items.map((item) => {
    const pid = item.paper_id as string;
    const m = meta.get(pid)!;
    return {
      paper_id: pid,
      position: get(item, 'position', 0),
      rationale: get(item, 'rationale', ''),
      title: m.title,
      authors: m.authors,
      year: m.year,
    };
  });
  return { ordered: pySortBy(result, (x) => x.position), mismatch: null };
}
