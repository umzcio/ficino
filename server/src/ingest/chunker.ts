/** Section-aware markdown chunking. Port of worker/lib/chunker.py (goldens: test/fixtures/goldens/chunker.json). */
import { Tiktoken } from 'js-tiktoken/lite';
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

let enc: Tiktoken | null = null;

/** Token count under cl100k_base. Special-token strings count as plain text (Python's encode() raised on them). */
export function countTokens(text: string): number {
  enc ??= new Tiktoken(cl100k_base);
  return enc.encode(text, [], []).length;
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
