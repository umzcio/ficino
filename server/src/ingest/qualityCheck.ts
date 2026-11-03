/** Extraction quality gate. Port of worker/lib/quality_check.py (goldens: test/fixtures/goldens/quality.json). */
import { PY_WS, pyLen, pyRound, pySlice, pySplit, pyStrip } from '../shared/pystr.js';

const SYMBOL_RE = new RegExp(`[^\\p{L}\\p{N}_${PY_WS}.,;:!?\\-'"()\\[\\]{}/@#$%&*+=<>]`, 'gu');
const ARTIFACT_RE = /[�\x00-\x08\x0b\x0c\x0e-\x1f]/gu;

const MIN_TEXT_LENGTH = 200;
const MAX_SYMBOL_DENSITY = 0.15;
const MIN_AVG_WORD_LENGTH = 2.5;
const MAX_AVG_WORD_LENGTH = 20.0;

/** Python `f"{x:.{nd}f}"` (half-even on the exact value). */
const fixed = (x: number, nd: number): string => pyRound(x, nd).toFixed(nd);

export function checkExtractionQuality(text: string): { ok: boolean; reason: string } {
  if (!text || !pyStrip(text)) return { ok: false, reason: 'empty_extraction' };
  const stripped = pyStrip(text);
  const len = pyLen(stripped);

  if (len < MIN_TEXT_LENGTH) return { ok: false, reason: `too_short (${len} chars)` };

  const artifactCount = (stripped.match(ARTIFACT_RE) ?? []).length;
  if (artifactCount > 10) return { ok: false, reason: `encoding_artifacts (${artifactCount} found)` };

  const symbolCount = (stripped.match(SYMBOL_RE) ?? []).length;
  const density = symbolCount / len;
  if (density > MAX_SYMBOL_DENSITY) {
    return { ok: false, reason: `high_symbol_density (${fixed(density * 100, 1)}%)` };
  }

  const words = pySplit(stripped);
  if (words.length > 0) {
    let total = 0;
    for (const w of words) total += pyLen(w);
    const avg = total / words.length;
    if (avg < MIN_AVG_WORD_LENGTH || avg > MAX_AVG_WORD_LENGTH) {
      return { ok: false, reason: `abnormal_word_length (avg ${fixed(avg, 1)})` };
    }
  }

  const sample = Array.from(pySlice(stripped, 0, 1000));
  const trigrams = new Set<string>();
  for (let i = 0; i < sample.length - 2; i++) trigrams.add(sample.slice(i, i + 3).join(''));
  const ratio = trigrams.size / Math.max(sample.length - 2, 1);
  if (ratio < 0.05) return { ok: false, reason: `repetitive_content (trigram ratio ${fixed(ratio, 3)})` };

  return { ok: true, reason: 'ok' };
}
