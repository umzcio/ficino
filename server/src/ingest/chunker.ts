/** Section-aware markdown chunking. Port of worker/lib/chunker.py (goldens: test/fixtures/goldens/chunker.json). */
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import { PY_WS, pyStrip } from '../shared/pystr.js';

export type Chunk = { section: string; content: string; chunk_index: number; token_count: number };

// Python `re.match` on each pattern: anchored at the start, prefix match. `\s` is Unicode, `.` excludes only \n.
const WS = `[${PY_WS}]`;
const SECTION_PATTERNS: RegExp[] = [
  `^#{1,3}${WS}*(abstract)`,
  `^#{1,3}${WS}*(introduction|background)`,
  `^#{1,3}${WS}*(literature${WS}+review|related${WS}+work|prior${WS}+work)`,
  `^#{1,3}${WS}*(method(?:s|ology)?|approach|experimental${WS}+(?:design|setup))`,
  `^#{1,3}${WS}*(result(?:s)?|finding(?:s)?|analysis)`,
  `^#{1,3}${WS}*(discussion)`,
  `^#{1,3}${WS}*(conclusion(?:s)?|summary)`,
  `^#{1,3}${WS}*(references|bibliography)`,
  `^#{1,3}${WS}*(appendix|appendices|supplementary)`,
  `^#{1,3}${WS}+([^\\n]+)`,
].map((src, i) => new RegExp(src, i < 9 ? 'iu' : 'u'));

const PARA_SPLIT = new RegExp(`\\n${WS}*\\n`, 'u');
const SENT_SPLIT = new RegExp(`(?<=[.!?])${WS}+`, 'u');

type Bpe = { ranks: Map<string, number>; pat: RegExp };
let bpe: Bpe | null = null;
const MAX_PIECE = 2000;

/** cl100k_base ranks keyed by the token's bytes as a latin1 string, parsed like js-tiktoken's constructor does. */
function loadBpe(): Bpe {
  const ranks = new Map<string, number>();
  for (const line of cl100k_base.bpe_ranks.split('\n')) {
    if (!line) continue;
    const [, offsetStr, ...tokens] = line.split(' ');
    const offset = Number.parseInt(offsetStr!, 10);
    tokens.forEach((token, i) => ranks.set(Buffer.from(token, 'base64').toString('latin1'), offset + i));
  }
  return { ranks, pat: new RegExp(cl100k_base.pat_str, 'gu') };
}

/**
 * Tokens in one pre-tokenized piece: byte-pair merge that always merges the lowest-ranked adjacent pair, leftmost on
 * ties, until no adjacent pair has a rank (the same rule as js-tiktoken's bytePairMerge and tiktoken's Rust core).
 * A min-heap of (rank, start) with lazy invalidation makes it O(n log n) instead of js-tiktoken's O(n^2) rescans.
 */
function pieceTokens(piece: string, ranks: Map<string, number>): number {
  const b = Buffer.from(piece, 'utf8').toString('latin1');
  const n = b.length;
  if (n === 1 || ranks.has(b)) return 1;

  const next = new Int32Array(n); // next[s]: start of the part after the one starting at s (n at the end)
  const prev = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    next[i] = i + 1;
    prev[i] = i - 1;
  }
  // Heap entries: [rank, left start, right start, right end] in parallel arrays.
  const hr: number[] = [];
  const hs: number[] = [];
  const hm: number[] = [];
  const he: number[] = [];
  const less = (i: number, j: number): boolean => hr[i]! < hr[j]! || (hr[i] === hr[j] && hs[i]! < hs[j]!);
  const swap = (i: number, j: number): void => {
    [hr[i], hr[j]] = [hr[j]!, hr[i]!];
    [hs[i], hs[j]] = [hs[j]!, hs[i]!];
    [hm[i], hm[j]] = [hm[j]!, hm[i]!];
    [he[i], he[j]] = [he[j]!, he[i]!];
  };
  const push = (s: number): void => {
    const m = next[s]!;
    if (m >= n) return;
    const e = next[m]!;
    const rank = ranks.get(b.slice(s, e));
    if (rank === undefined) return;
    let i = hr.length;
    hr.push(rank);
    hs.push(s);
    hm.push(m);
    he.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const pop = (): void => {
    const last = hr.length - 1;
    swap(0, last);
    hr.pop();
    hs.pop();
    hm.pop();
    he.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < hr.length && less(l, m)) m = l;
      if (r < hr.length && less(r, m)) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  };

  for (let i = 0; i < n - 1; i++) push(i);
  let parts = n;
  while (hr.length > 0) {
    const s = hs[0]!;
    const m = hm[0]!;
    const e = he[0]!;
    pop();
    if (!alive[s] || next[s] !== m || !alive[m] || next[m] !== e) continue; // stale: a neighbour merged since
    alive[m] = 0;
    next[s] = e;
    if (e < n) prev[e] = s;
    parts -= 1;
    if (prev[s]! >= 0) push(prev[s]!);
    push(s);
  }
  return parts;
}

/**
 * Token count under cl100k_base. Special-token strings count as plain text (Python's encode() raised on them).
 *
 * js-tiktoken's encode() is quadratic in the length of one pre-tokenized piece (16k identical chars took ~13 s,
 * 20k spaces ~21 s; Python's tiktoken does 200k in 44 ms), so we pre-split with cl100k_base's own `pat_str` (the
 * regex js-tiktoken uses) and merge each piece with pieceTokens. Deliberate divergence: a piece longer than
 * MAX_PIECE code points (only pathological unbroken runs) is counted as MAX_PIECE-code-point sub-pieces, so its count
 * can differ slightly from tiktoken's. For every piece up to MAX_PIECE the total equals js-tiktoken's
 * `encode(text, [], []).length` (asserted in test/ingest/chunker.test.ts).
 */
export function countTokens(text: string): number {
  bpe ??= loadBpe();
  const { ranks, pat } = bpe;
  let n = 0;
  for (const [piece] of text.matchAll(pat)) {
    if (piece.length <= MAX_PIECE) {
      n += pieceTokens(piece, ranks);
      continue;
    }
    const cps = Array.from(piece); // code points: never splits a surrogate pair
    for (let i = 0; i < cps.length; i += MAX_PIECE) n += pieceTokens(cps.slice(i, i + MAX_PIECE).join(''), ranks);
  }
  return n;
}

function detectSections(markdown: string): [string, string][] {
  const sections: [string, string][] = [];
  let currentSection = 'untitled';
  let currentLines: string[] = [];

  for (const line of markdown.split('\n')) {
    const stripped = pyStrip(line);
    let m: RegExpExecArray | null = null;
    for (const pattern of SECTION_PATTERNS) {
      m = pattern.exec(stripped);
      if (m) break;
    }
    if (m) {
      if (currentLines.length > 0) {
        const content = pyStrip(currentLines.join('\n'));
        if (content) sections.push([currentSection, content]);
      }
      currentSection = pyStrip(m[1]!).toLowerCase();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    const content = pyStrip(currentLines.join('\n'));
    if (content) sections.push([currentSection, content]);
  }
  return sections;
}

function splitByTokens(text: string, section: string, maxTokens: number, startIndex: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let chunkIndex = startIndex;

  const emit = (content: string): void => {
    chunks.push({ section, content, chunk_index: chunkIndex, token_count: countTokens(content) });
    chunkIndex += 1;
  };

  for (const raw of text.split(PARA_SPLIT)) {
    const para = pyStrip(raw);
    if (!para) continue;
    const paraTokens = countTokens(para);

    if (paraTokens > maxTokens) {
      if (current.length > 0) {
        emit(current.join('\n\n'));
        current = [];
        currentTokens = 0;
      }
      let sentChunk: string[] = [];
      let sentTokens = 0;
      for (const sent of para.split(SENT_SPLIT)) {
        const st = countTokens(sent);
        if (sentTokens + st > maxTokens && sentChunk.length > 0) {
          emit(sentChunk.join(' '));
          sentChunk = [];
          sentTokens = 0;
        }
        sentChunk.push(sent);
        sentTokens += st;
      }
      if (sentChunk.length > 0) {
        const content = sentChunk.join(' ');
        current = [content];
        currentTokens = countTokens(content);
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      emit(current.join('\n\n'));
      current = [];
      currentTokens = 0;
    }
    current.push(para);
    currentTokens += paraTokens;
  }

  if (current.length > 0) emit(current.join('\n\n'));
  return chunks;
}

export function chunkMarkdown(markdown: string, maxTokens = 800): Chunk[] {
  let sections = detectSections(markdown);
  if (sections.length === 0) sections = [['untitled', markdown]];

  const all: Chunk[] = [];
  let chunkIndex = 0;
  for (const [name, content] of sections) {
    if (name === 'references' || name === 'bibliography') continue;
    const created = splitByTokens(content, name, maxTokens, chunkIndex);
    all.push(...created);
    chunkIndex += created.length;
  }
  return all;
}
