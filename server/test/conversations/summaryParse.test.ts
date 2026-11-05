import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPaperSummaryPrompt,
  buildSynthesisPrompt,
  coerceMessages,
  PAPER_SUMMARY_SYSTEM,
  parseChatMessages,
  SYNTHESIS_SYSTEM,
  type SummaryChunkRow,
  type SynthesisPaperRow,
} from '../../src/conversations/summaryParse.js';

type Golden = {
  name: string;
  task: 'summary' | 'synthesis';
  rows: {
    existing: null;
    paper?: { title: string | null; filename: string };
    chunks?: SummaryChunkRow[];
    paper_rows?: SynthesisPaperRow[];
  };
  raw: string;
  call: { system: string; prompt: string; kwargs: Record<string, unknown> } | null;
  stored_messages: Record<string, unknown>[] | null;
  result: Record<string, unknown>;
};

const goldens = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/summary-tasks.json', import.meta.url), 'utf8'),
) as Golden[];

const parse = (g: Golden) =>
  g.task === 'summary'
    ? parseChatMessages(g.raw, 'paper', '(no content returned)')
    : parseChatMessages(g.raw, 'synthesis', '(no content)');

describe('summary-tasks goldens', () => {
  it('covers every case the brief names', () => {
    expect(goldens.map((g) => g.name)).toEqual(
      expect.arrayContaining([
        'clean_array',
        'prose_only',
        'think_only',
        'array_of_strings',
        'objects_without_content',
        'truncated_array',
        'greedy_span_two_arrays',
        'long_chunks_cut_after_fencing',
        'two_papers_one_without_chunks',
        'chunk_cut_to_300',
        'no_chunks_anywhere',
      ]),
    );
  });

  for (const g of goldens.filter((x) => x.stored_messages !== null)) {
    it(`${g.name}: raw parses to the stored messages`, () => {
      expect(parse(g).messages).toEqual(g.stored_messages);
    });
  }

  for (const g of goldens.filter((x) => x.call !== null)) {
    it(`${g.name}: the prompt built from the same rows matches Python's call`, () => {
      const call = g.call!;
      if (g.task === 'summary') {
        expect(call.system).toBe(PAPER_SUMMARY_SYSTEM);
        expect(buildPaperSummaryPrompt(g.rows.paper!, g.rows.chunks!)).toBe(call.prompt);
        expect(call.kwargs).toEqual({ max_tokens: 1536 });
      } else {
        expect(call.system).toBe(SYNTHESIS_SYSTEM);
        expect(buildSynthesisPrompt(g.rows.paper_rows!)).toBe(call.prompt);
        // generate_text_sync defaults: temperature 0.7, max_tokens 1024.
        expect(call.kwargs).toEqual({});
      }
    });
  }

  it('no_chunks_anywhere raises the Python message', () => {
    const g = goldens.find((x) => x.name === 'no_chunks_anywhere')!;
    expect(g.result).toEqual({ raises: 'No chunks found for any of the papers' });
    expect(() => buildSynthesisPrompt(g.rows.paper_rows!)).toThrow('No chunks found for any of the papers');
  });

  it('the long-chunk case is cut to 8000 code points after fencing', () => {
    const g = goldens.find((x) => x.name === 'long_chunks_cut_after_fencing')!;
    const body = g.call!.prompt.split('PAPER CONTENT:\n')[1]!.split('\n\nGenerate 8-9')[0]!;
    expect(Array.from(body)).toHaveLength(8000);
    expect(body.startsWith('[INTRODUCTION]\n<untrusted>é')).toBe(true);
  });
});

describe('parseChatMessages warnings', () => {
  const byName = (n: string) => parse(goldens.find((g) => g.name === n)!);
  it('a clean array has no warning', () => {
    expect(byName('clean_array').warning).toBeNull();
  });
  it('prose, think-only, wrong shapes and no closing bracket are parse_empty', () => {
    for (const n of ['prose_only', 'think_only', 'array_of_strings', 'objects_without_content', 'truncated_array']) {
      expect(byName(n).warning, n).toBe('parse_empty');
    }
  });
  it('a greedy span that fails to parse is parse_failed', () => {
    expect(byName('greedy_span_two_arrays').warning).toBe('parse_failed');
  });
  it('a parse failure keeps the cleaned text, with <think> removed and stripped', () => {
    expect(parseChatMessages('  <think>a\nb</think> [1, \n', 'synthesis', '(no content)')).toEqual({
      messages: [{ role: 'synthesis', type: 'summary', content: '[1,' }],
      warning: 'parse_empty',
    });
    expect(parseChatMessages('<think>a</think> [1,] ', 'synthesis', '(no content)')).toEqual({
      messages: [{ role: 'synthesis', type: 'summary', content: '[1,]' }],
      warning: 'parse_failed',
    });
  });
});

describe('coerceMessages', () => {
  it('drops non-dict elements (test_coerce_messages_drops_non_dict_elements)', () => {
    expect(coerceMessages(['a', 'b'])).toEqual([]);
    expect(coerceMessages([{ role: 'x', content: 'hi' }, 'junk', { content: '' }])).toEqual([
      { role: 'x', content: 'hi' },
    ]);
  });
  it('drops arrays, null and non-string content; a non-list is empty', () => {
    expect(coerceMessages([['content'], null, { content: 5 }, { content: null }, { content: 'ok' }])).toEqual([
      { content: 'ok' },
    ]);
    expect(coerceMessages({ content: 'hi' })).toEqual([]);
    expect(coerceMessages('hi')).toEqual([]);
  });
});
