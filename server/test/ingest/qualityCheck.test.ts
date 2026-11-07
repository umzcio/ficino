import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkExtractionQuality } from '../../src/ingest/qualityCheck.js';

// Goldens come from worker/lib/quality_check.py; see test/fixtures/goldens/README.md (tag `python-final`).
const golden = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/quality.json', import.meta.url), 'utf8'),
) as { text: string; ok: boolean; reason: string }[];

describe('checkExtractionQuality', () => {
  it('has at least 10 golden texts covering every reason', () => {
    expect(golden.length).toBeGreaterThanOrEqual(10);
    const kinds = new Set(golden.map((g) => g.reason.split(' ')[0]));
    for (const k of ['ok', 'empty_extraction', 'too_short', 'encoding_artifacts', 'high_symbol_density', 'abnormal_word_length', 'repetitive_content']) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  golden.forEach((g, i) => {
    it(`matches the Python golden #${i}: ${g.reason}`, () => {
      expect(checkExtractionQuality(g.text)).toEqual({ ok: g.ok, reason: g.reason });
    });
  });
});
