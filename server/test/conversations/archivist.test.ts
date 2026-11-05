import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVIST_CONTEXT_SUFFIX,
  ARCHIVIST_SYSTEM_FALLBACK,
  archivistChunksText,
  CITATION_RE,
  EMPTY_CORPUS_FOLLOWUP_REPLY,
  EMPTY_CORPUS_REPLY,
  followupUserPrompt,
  knownCitations,
  pyFormatChunks,
  validateCitations,
} from '../../src/conversations/archivist.js';
import { buildPostSources } from '../../src/feed/personas.js';
import type { Chunk } from '../../src/feed/types.js';
import { pyStrip } from '../../src/shared/pystr.js';

type CitationCase = {
  name: string;
  chunks: Chunk[];
  text: string;
  known: Array<[string, string]>;
  validated: { text: string; hallucinated: string[] };
};
type FormatCase = { template: string; value: string; result?: string; raises?: string };
type Execute = { sql: string; args: unknown[] };
type TaskCase = {
  name: string;
  task: 'initial' | 'followup';
  post_id: string;
  post: { content: string; corpus_id: string | null; user_id: string; replies?: Array<Record<string, unknown>> };
  personas: Record<string, { system_prompt: string | null }>;
  chunks: Chunk[];
  raw: string;
  call: { system: string; user: string; kwargs: Record<string, unknown> } | null;
  executes: Execute[];
  result: Record<string, unknown>;
};
type Golden = {
  constants: { fallback: string; suffix: string };
  citations: CitationCase[];
  format: FormatCase[];
  tasks: TaskCase[];
};

const golden = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/archivist-tasks.json', import.meta.url), 'utf8'),
) as Golden;
const task = (name: string) => golden.tasks.find((t) => t.name === name)!;

it('the prompt constants are byte-equal to Python', () => {
  expect(ARCHIVIST_SYSTEM_FALLBACK).toBe(golden.constants.fallback);
  expect(ARCHIVIST_CONTEXT_SUFFIX).toBe(golden.constants.suffix);
  expect(ARCHIVIST_CONTEXT_SUFFIX).toContain('{chunks}');
  expect(ARCHIVIST_CONTEXT_SUFFIX).toContain('FORMATTING: Use real line breaks.');
});

describe('citations (goldens)', () => {
  for (const c of golden.citations) {
    it(c.name, () => {
      const known = knownCitations(c.chunks);
      expect([...known].sort()).toEqual(c.known.map(([last, year]) => `${last}\u0000${year}`).sort());
      expect(validateCitations(c.text, known)).toEqual(c.validated);
    });
  }

  it('CITATION_RE uses the gu flags', () => {
    expect(CITATION_RE.flags).toBe('gu');
  });

  it('validateCitations is stateless across calls on the shared global regex', () => {
    const known = knownCitations(golden.citations[0]!.chunks);
    const a = validateCitations('Doe (2019) one.', known);
    const b = validateCitations('Doe (2019) one.', known);
    expect(a).toEqual(b);
    expect(a.hallucinated).toEqual(['Doe (2019)']);
  });
});

describe('pyFormatChunks', () => {
  it('unescapes doubled braces and substitutes {chunks}', () => {
    expect(pyFormatChunks('{{x}} {chunks}', 'V')).toBe('{x} V');
  });

  it('an unknown field throws KeyError', () => {
    expect(() => pyFormatChunks('Answer as {name}.', 'V')).toThrow(/^KeyError: 'name'$/);
  });

  it('a lone } throws', () => {
    expect(() => pyFormatChunks('}', 'V')).toThrow("ValueError: Single '}' encountered in format string");
  });

  it('the substituted value is never re-scanned', () => {
    expect(pyFormatChunks('<{chunks}>', 'has {chunks} and {x} and }')).toBe('<has {chunks} and {x} and }>');
  });

  // Fields Python renders (or rejects with another exception) that this port refuses: conversions, attribute and
  // index access, and non-empty format specs on {chunks}.
  const NARROWED = new Set([
    '{chunks.a}',
    '{chunks!r}',
    '{chunks!s}',
    '{chunks!x}',
    '{chunks!r:}',
    '{chunks:>5}',
    '{chunks:{chunks}}',
    '{chunks[0]}',
    '{chunks:{{}}}',
  ]);

  describe('matches Python str.format (goldens)', () => {
    for (const f of golden.format) {
      it(`${JSON.stringify(f.template)} with ${JSON.stringify(f.value)}`, () => {
        let got: { result: string } | { raises: string };
        try {
          got = { result: pyFormatChunks(f.template, f.value) };
        } catch (e) {
          got = { raises: (e as Error).message };
        }
        if ('raises' in got && got.raises.startsWith('ValueError: Unsupported replacement field')) {
          expect(NARROWED.has(f.template)).toBe(true);
          // Where Python raised too, it was the attribute, index or spec applied to the value, never a field lookup.
          if (f.raises) expect(f.raises).toMatch(/^(ValueError: |AttributeError: |IndexError: string index)/);
          return;
        }
        expect(got).toEqual(f.raises !== undefined ? { raises: f.raises } : { result: f.result });
      });
    }
  });
});

describe('task prompts and stored values rebuilt from the goldens', () => {
  const baseOf = (t: TaskCase) => {
    const db = t.personas.archivist?.system_prompt;
    return db && pyStrip(db) ? db : ARCHIVIST_SYSTEM_FALLBACK;
  };

  for (const t of golden.tasks.filter((x) => x.call)) {
    it(t.name, () => {
      const call = t.call!;
      expect(pyFormatChunks(baseOf(t) + ARCHIVIST_CONTEXT_SUFFIX, archivistChunksText(t.chunks))).toBe(call.system);
      const user = t.task === 'initial' ? t.post.content : followupUserPrompt(t.post.content, t.post.replies!);
      expect(user).toBe(call.user);
      expect(call.kwargs).toEqual({ temperature: 0.6, max_tokens: 1024 });

      const content = validateCitations(t.raw, knownCitations(t.chunks)).text;
      const store = t.executes.at(-1)!;
      const reply = { role: 'archivist', persona: 'archivist', content };
      expect(store.args[0]).toEqual([reply]);
      if (t.task === 'initial') {
        expect(store.sql).toContain('SET replies = $1, sources = $2');
        expect(store.args[1]).toEqual(buildPostSources(t.chunks));
      } else {
        expect(store.sql).toContain('replies = replies || $1::jsonb');
      }
    });
  }

  it('a null title and section print None; no chunks give the no-passages line', () => {
    expect(task('initial_none_title').call!.system).toContain('[None — results]');
    expect(archivistChunksText([])).toBe('No relevant passages found in the corpus.');
    const absent = { content: 'x' } as unknown as Chunk;
    expect(archivistChunksText([absent])).toBe('[Unknown — unknown]\n<untrusted>x</untrusted>');
  });

  it('the empty-corpus replies match Python', () => {
    expect(task('initial_empty_corpus').executes[0]!.args[0]).toEqual([
      { role: 'archivist', persona: 'archivist', content: EMPTY_CORPUS_REPLY },
    ]);
    expect(task('followup_empty_corpus').executes[0]!.args[0]).toEqual([
      { role: 'archivist', persona: 'archivist', content: EMPTY_CORPUS_FOLLOWUP_REPLY },
    ]);
  });

  it('a DB prompt with a stray field fails the format, as in Python', () => {
    const t = task('format_error_db_prompt');
    expect(t.result).toEqual({ raises: "KeyError: 'name'" });
    expect(() =>
      pyFormatChunks(baseOf(t) + ARCHIVIST_CONTEXT_SUFFIX, archivistChunksText(t.chunks)),
    ).toThrow(/^KeyError: 'name'$/);
    expect(t.executes).toEqual([{ sql: "UPDATE user_posts SET status = 'error' WHERE id = $1", args: [t.post_id] }]);
  });
});
