// Prompt-injection defenses (port of shared/ficino_shared/sanitize.py).

import { PY_WS, pyStrip } from './pystr.js';

const MAX_BLOCK_LEN = 8000;

// Role markers stripped at the start of a line. `(?<![^\n])` is "start of
// line" with Python's MULTILINE semantics (only \n counts, unlike JS `^`/m).
// This must strip a SUPERSET of what the Python regex strips (extra stripping,
// e.g. U+FEFF via JS \s, is fine): Python's Unicode \s also covers
// \x1c-\x1f and \x85, and its IGNORECASE folds U+017F (handled by the `u`
// flag) and dotted/dotless i, which Python treats as `i` in every keyword (hence `[i\u0131\u0130]` in assistant, ai and instruction).
const ROLE_MARKER_RE =
  /(?<![^\n])[\s\x1c-\x1f\x85>*_#-]*(system|ass[i\u0131\u0130]stant|human|user|a[i\u0131\u0130]|[i\u0131\u0130]nstruct[i\u0131\u0130]on)[\s\x1c-\x1f\x85]*:[ \t]*/giu;

// Python's `\s` on str (not JS's: Python adds \x1c-\x1f and \x85, and leaves out U+FEFF).
const PY_WS_RUN_RE = new RegExp(`[${PY_WS}]+`, 'g');

const FENCE_OPEN = '<untrusted>';
const FENCE_CLOSE = '</untrusted>';

// Anything a model could read as an opening or closing fence tag. Python escaped only the exact strings
// `<untrusted>` and `</untrusted>`; this also catches any case (Unicode case folding via the `iu` flags, so U+017F
// counts as `s`), fullwidth and small-form brackets and letters, a backslash or fullwidth slash, and whitespace or
// invisible format characters (\p{Cf}: zero-width space, soft hyphen, ...) anywhere inside the tag, plus attributes
// before the closing bracket. A tag with no closing bracket is still caught by its opening one. Each gap is a class
// that cannot match the character after it, so matching stays linear.
const TAG_GAP = '[\\s\\x1c-\\x1f\\x85\\p{Cf}]*';
const TAG_NAME = Array.from('untrusted', (ch) => `[${ch}${String.fromCodePoint(ch.codePointAt(0)! - 0x61 + 0xff41)}]`)
  .join(TAG_GAP);
const FENCE_TAG_RE = new RegExp(
  `[<\\uff1c\\ufe64](${TAG_GAP}(?:[/\\\\\\uff0f]${TAG_GAP})?${TAG_NAME})([^<>\\uff1c\\uff1e\\ufe64\\ufe65]{0,256})([>\\uff1e\\ufe65])?`,
  'giu',
);

/**
 * Escape every fence-tag look-alike as HTML entities, in place. For the exact tags this gives the strings the Python
 * source used (`&lt;untrusted&gt;`, `&lt;/untrusted&gt;`); other text is unchanged.
 */
function escapeFenceTags(s: string): string {
  return s.replace(FENCE_TAG_RE, (_m, name: string, rest: string, close: string | undefined) =>
    `&lt;${name}${rest}${close === undefined ? '' : '&gt;'}`,
  );
}

/** Python-style text[:n] (counts code points, not UTF-16 units). */
function headCodePoints(s: string, n: number): string | null {
  if (s.length <= n) return null; // UTF-16 length >= code point count
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n).join('') : null;
}

export function stripRoleMarkers(text: string): string {
  if (!text) return '';
  return text.replace(ROLE_MARKER_RE, '');
}

export function fenceUntrusted(text: string, maxLen: number = MAX_BLOCK_LEN): string {
  if (!text) return `${FENCE_OPEN}${FENCE_CLOSE}`;

  let cleaned = stripRoleMarkers(text);
  cleaned = escapeFenceTags(cleaned);

  const head = headCodePoints(cleaned, maxLen);
  if (head !== null) cleaned = head + '… [truncated]';

  return `${FENCE_OPEN}${cleaned}${FENCE_CLOSE}`;
}

export function sanitizeInline(text: string | null | undefined, maxLen = 200): string {
  if (text === null || text === undefined) return '';
  let s = String(text);
  s = stripRoleMarkers(s);
  s = escapeFenceTags(s);
  s = pyStrip(s.replace(PY_WS_RUN_RE, ' '));
  const head = headCodePoints(s, maxLen);
  if (head !== null) s = head + '…';
  return s;
}

export { MAX_BLOCK_LEN };
