import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown, countTokens } from '../../src/ingest/chunker.js';

// Goldens come from worker/lib/chunker.py in the ficino-worker image; see test/fixtures/goldens/gen/README.md.
const fx = (name: string): string => readFileSync(new URL(`../fixtures/goldens/${name}`, import.meta.url), 'utf8');
type Case = { name: string; markdown: string; max_tokens: number };
const inputs = JSON.parse(fx('chunker-inputs.json')) as Case[];
const golden = JSON.parse(fx('chunker.json')) as { name: string; chunks: unknown[] }[];

describe('chunkMarkdown', () => {
  it('has at least 12 cases, all with goldens', () => {
    expect(inputs.length).toBeGreaterThanOrEqual(12);
    expect(golden.map((g) => g.name)).toEqual(inputs.map((i) => i.name));
  });

  for (const c of inputs) {
    it(`matches the Python golden: ${c.name}`, () => {
      const want = golden.find((g) => g.name === c.name)!;
      expect(chunkMarkdown(c.markdown, c.max_tokens)).toEqual(want.chunks);
    });
  }

  it('defaults maxTokens to 800', () => {
    const sample = inputs.find((i) => i.name === 'sample 800')!;
    expect(chunkMarkdown(sample.markdown)).toEqual(golden.find((g) => g.name === 'sample 800')!.chunks);
  });
});

describe('countTokens', () => {
  it('treats special-token strings as plain text', () => {
    expect(countTokens('<|endoftext|>')).toBeGreaterThan(0);
  });
});
