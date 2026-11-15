import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import { chunkMarkdown, countTokens } from '../../src/ingest/chunker.js';
import { PdfLimitError } from '../../src/ingest/pdf.js';

// Goldens come from worker/lib/chunker.py; see test/fixtures/goldens/README.md (tag `python-final`).
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

/** `n` one-word sections, the shape of a PDF that alternates oversized one-glyph headings with one-glyph lines. */
const headingPairs = (n: number): string => Array.from({ length: n }, (_, i) => `\n# h${i}\n\nb${i}`).join('\n');

// Security review: text under MAX_PAPER_CHARS could still split into hundreds of thousands of chunks (a section per
// heading), each embedded and stored at once, so the chunker stops at a per-paper ceiling (MAX_PAPER_CHUNKS).
describe('chunkMarkdown maxChunks (the per-paper chunk ceiling)', () => {
  it('returns the same chunks as without a ceiling when the paper has exactly maxChunks chunks', () => {
    const want = chunkMarkdown(headingPairs(5), 800);
    expect(want).toHaveLength(5);
    expect(chunkMarkdown(headingPairs(5), 800, 5)).toEqual(want);
    for (const c of inputs) {
      const all = chunkMarkdown(c.markdown, c.max_tokens);
      expect(chunkMarkdown(c.markdown, c.max_tokens, Math.max(1, all.length))).toEqual(all);
    }
  });

  it('throws a PdfLimitError naming the ceiling once the paper would have one chunk more', () => {
    let err: unknown;
    try {
      chunkMarkdown(headingPairs(6), 800, 5);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PdfLimitError);
    expect((err as Error).message).toBe('Paper text splits into more than 5 chunks (the per-paper limit)');
    // A long section split by tokens counts every chunk it makes.
    const long = `# Results\n\n${Array.from({ length: 40 }, (_, i) => `Sentence ${i} has a few words in it.`).join(' ')}`;
    const n = chunkMarkdown(long, 20).length;
    expect(n).toBeGreaterThan(3);
    expect(() => chunkMarkdown(long, 20, n - 1)).toThrow(`more than ${n - 1} chunks`);
  });

  it('does not count the skipped reference sections', () => {
    const md = `${headingPairs(5)}\n# References\n\nOne. Two.\n# Bibliography\n\nThree.`;
    expect(chunkMarkdown(md, 800, 5)).toEqual(chunkMarkdown(md, 800));
  });

  it('stops at the ceiling instead of chunking the rest of a huge paper first', () => {
    const md = headingPairs(300_000); // about 3.3M characters, one chunk per heading
    let t = performance.now();
    expect(() => chunkMarkdown(md, 800, 10)).toThrow(PdfLimitError);
    const stopped = performance.now() - t;
    t = performance.now();
    expect(chunkMarkdown(md, 800)).toHaveLength(300_000);
    const whole = performance.now() - t;
    expect(stopped).toBeLessThan(whole / 4);
  });
});

describe('countTokens', () => {
  it('treats special-token strings as plain text', () => {
    expect(countTokens('<|endoftext|>')).toBeGreaterThan(0);
  });
});

describe('countTokens bounded cost', () => {
  // The unbounded reference: js-tiktoken's own encoder on the whole text.
  let ref: Tiktoken | null = null;
  const plain = (text: string): number => {
    ref ??= new Tiktoken(cl100k_base);
    return ref.encode(text, [], []).length;
  };

  it('equals the unbounded encoder on every golden input and its chunks', () => {
    for (const c of inputs) {
      expect(countTokens(c.markdown)).toBe(plain(c.markdown));
      for (const ch of chunkMarkdown(c.markdown, c.max_tokens)) expect(countTokens(ch.content)).toBe(plain(ch.content));
    }
  });

  it('equals the unbounded encoder on mixed text', () => {
    const samples = [
      '',
      "It's the end — we've seen 12345678 values, they'll say I'd've known.\r\n\r\n  indented\ttabs\n\n\n",
      'naïve café 東京 😀😀 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 ﷺ <|endoftext|> <|fim_prefix|>x<|endofprompt|>',
      '   leading and trailing   \n  ',
      `${'word '.repeat(400)}\n${'-'.repeat(1999)}\n${' '.repeat(1500)}x`,
      `x${'😀'.repeat(1999)}y ${'a'.repeat(1999)} ${'7'.repeat(30)}`, // ' a…a' is one 2000-code-point piece
      '$$\\sum_{i=1}^{n} x_i^2$$ (see Fig. 3a); α=0.05, p<.001…',
    ];
    for (const s of samples) expect(countTokens(s)).toBe(plain(s));
  });

  it('equals the unbounded encoder on seeded random text', () => {
    const alphabet = [...'aZ09 \t\r\n.,;-\'"()[]{}$\\/_<|>', 'é', 'ß', '東', 'ж', '😀', '𝔘', '\u00a0', '\u2028', 'ﷺ', "'s", "'ll", '<|endoftext|>'];
    let seed = 12345;
    const rand = (k: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % k;
    };
    for (let c = 0; c < 300; c++) {
      let s = '';
      const len = 1 + rand(400);
      for (let i = 0; i < len; i++) s += alphabet[rand(alphabet.length)]!.repeat(1 + (rand(10) === 0 ? rand(60) : 0));
      expect(countTokens(s)).toBe(plain(s));
    }
  });

  it('counts 100k identical letters in well under 2 s', () => {
    const t = performance.now();
    const n = countTokens('a'.repeat(100_000));
    expect(performance.now() - t).toBeLessThan(2000);
    expect(n).toBeGreaterThan(0);
  });

  it('counts 100k spaces in well under 2 s', () => {
    const t = performance.now();
    const n = countTokens(`a${' '.repeat(100_000)}b`);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(n).toBeGreaterThan(0);
  });

  it('splits pathological runs by code point without breaking surrogate pairs', () => {
    // 2001 astral chars: one piece over the cap; a split mid-pair would encode U+FFFD bytes instead.
    const s = '😀'.repeat(2001);
    expect(countTokens(s)).toBe(plain('😀'.repeat(2000)) + plain('😀'));
  });

  it('chunks markdown containing a 60k-space line in well under 2 s', () => {
    const md = `# Introduction\n\nSome text here.\n\na${' '.repeat(60_000)}b\n\nMore text.\n`;
    const t = performance.now();
    const chunks = chunkMarkdown(md, 800);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
