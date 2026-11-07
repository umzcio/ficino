import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ORDERING_USER,
  orderingContext,
  orderingSystemPrompt,
  parseOrderingJson,
  pyLt,
  validateOrdering,
  type OrderingRow,
} from '../../src/readingLists/ordering.js';

type LogRec = { level: string; event: string; kwargs: Record<string, unknown> };
type Run = {
  name: string;
  rows: OrderingRow[];
  raw: string;
  list_id: string | null;
  call: { system: string; user: string; kwargs: Record<string, unknown> } | null;
  persisted: { paper_sequence: string[]; rationale: Record<string, unknown>[]; chapters: string[] } | null;
  logs: LogRec[];
  result: Record<string, unknown>;
};
type Golden = { parse: Array<{ text: string; result: unknown }>; runs: Run[] };

const golden = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/reading-list-ordering.json', import.meta.url), 'utf8'),
) as Golden;

const raisesOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
};

describe('parseOrderingJson (golden)', () => {
  it.each(golden.parse.map((p, i) => [i, p] as const))('parse case %i', (_i, p) => {
    expect(parseOrderingJson(p.text)).toEqual(p.result);
  });
});

describe('ordering prompt (golden)', () => {
  const withCall = golden.runs.filter((r) => r.call);
  it('covers every run that reaches the LLM', () => {
    expect(withCall.length).toBe(golden.runs.length - 1);
  });

  it.each(withCall.map((r) => [r.name, r] as const))('%s: system and user prompts byte for byte', (_n, r) => {
    const papers = orderingContext(r.rows);
    expect(orderingSystemPrompt(papers)).toBe(r.call!.system);
    expect(ORDERING_USER).toBe(r.call!.user);
    expect(r.call!.kwargs).toEqual({ temperature: 0.3, max_tokens: 2048 });
  });

  it('no rows gives an empty context and no call', () => {
    const r = golden.runs.find((x) => x.name === 'no_rows')!;
    expect(orderingContext(r.rows)).toEqual([]);
    expect(r.call).toBeNull();
    expect(r.result).toEqual({ ordered_papers: [], error: 'No papers found' });
  });
});

describe('validateOrdering (golden)', () => {
  const runs = golden.runs.filter((r) => r.call);
  it.each(runs.map((r) => [r.name, r] as const))('%s', (_n, r) => {
    const papers = orderingContext(r.rows);
    const items = parseOrderingJson(r.raw);
    const raised = raisesOf(() => validateOrdering(papers, items));
    if ('raises' in r.result) {
      expect(raised).toBe(r.result.raises);
      return;
    }
    expect(raised).toBeNull();
    const { ordered, mismatch } = validateOrdering(papers, items);
    expect(ordered).toEqual(r.result.ordered_papers);
    if (r.persisted) {
      expect(ordered).toEqual(r.persisted.rationale);
      expect(ordered.map((o) => o.paper_id)).toEqual(r.persisted.paper_sequence);
      expect(r.persisted.chapters).toEqual(r.persisted.paper_sequence);
    }
    const logged = r.logs.find((l) => l.event === 'propose_ordering_id_mismatch');
    if (!logged) {
      expect(mismatch).toBeNull();
      return;
    }
    expect(logged.level).toBe('warning');
    const sortKey = (v: unknown) => `${v === null ? 1 : 0}${String(v)}`;
    const sorted = (xs: unknown[]) => [...xs].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    expect(mismatch).not.toBeNull();
    expect(sorted(mismatch!.missing)).toEqual(logged.kwargs.missing);
    expect(sorted(mismatch!.extra)).toEqual(logged.kwargs.extra);
    expect(mismatch!.input_count).toBe(logged.kwargs.input_count);
    expect(mismatch!.returned_count).toBe(logged.kwargs.returned_count);
  });
});

describe('orderingContext', () => {
  it('cuts each chunk at 200 code points and the preview at 500', () => {
    const astral = '\u{1F600}'.repeat(300);
    const [p] = orderingContext([
      { id: 'x', title: 't', authors: ['a'], year: 1, filename: null, chunks: [astral, astral, astral] },
    ]);
    expect(Array.from(p!.preview).length).toBe(500);
    expect(p!.preview.startsWith('\u{1F600}'.repeat(200) + ' ')).toBe(true);
  });
});

describe('validateOrdering edges', () => {
  const papers = orderingContext([
    { id: 'a', title: 'A', authors: null, year: null, filename: null, chunks: [] },
    { id: 'b', title: 'B', authors: null, year: null, filename: null, chunks: [] },
  ]);

  it('keeps at most 5 ids in each mismatch list', () => {
    const items = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'].map((paper_id) => ({ paper_id }));
    const { mismatch, ordered } = validateOrdering(papers, items);
    expect(mismatch!.extra).toHaveLength(5);
    expect(mismatch!.missing).toEqual(['a', 'b']);
    expect(mismatch!.returned_count).toBe(7);
    expect(ordered.map((o) => [o.paper_id, o.position, o.rationale])).toEqual([
      ['a', 0, ''],
      ['b', 1, ''],
    ]);
  });

  it('dedupes returned ids with Python equality (1 == True)', () => {
    const { mismatch } = validateOrdering(papers, [{ paper_id: 1 }, { paper_id: true }, { paper_id: 'a' }]);
    expect(mismatch!.extra).toEqual([1]);
    expect(mismatch!.returned_count).toBe(2);
  });

  it('an explicit null rationale stays null; an absent one is empty', () => {
    const { ordered } = validateOrdering(papers, [
      { paper_id: 'b', position: 1, rationale: null },
      { paper_id: 'a', position: 2 },
    ]);
    expect(ordered.map((o) => o.rationale)).toEqual([null, '']);
  });
});

describe('pyLt', () => {
  it('compares strings by code point, not UTF-16 unit', () => {
    expect(pyLt('～', '\u{1F600}')).toBe(true);
    expect('～' < '\u{1F600}').toBe(false);
  });

  it('compares lists lexicographically and by length', () => {
    expect(pyLt([1, 'a'], [1, 'b'])).toBe(true);
    expect(pyLt([1], [1, 0])).toBe(true);
    expect(pyLt([1, 0], [1])).toBe(false);
    expect(pyLt([1, 'x'], [1, 'x'])).toBe(false);
    expect(pyLt([{ a: 1 }, 1], [{ a: 1 }, 2])).toBe(true);
    expect(raisesOf(() => pyLt([{ a: 1 }], [{ a: 2 }]))).toBe(
      "TypeError: '<' not supported between instances of 'dict' and 'dict'",
    );
  });

  it('names Python types in the error', () => {
    expect(raisesOf(() => pyLt(1.5, 'a'))).toBe("TypeError: '<' not supported between instances of 'float' and 'str'");
    expect(raisesOf(() => pyLt(true, null))).toBe(
      "TypeError: '<' not supported between instances of 'bool' and 'NoneType'",
    );
    expect(raisesOf(() => pyLt([1], 1))).toBe("TypeError: '<' not supported between instances of 'list' and 'int'");
    expect(pyLt(false, 0.5)).toBe(true);
  });
});
