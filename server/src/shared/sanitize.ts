// Prompt-injection defenses (port of shared/ficino_shared/sanitize.py).

const MAX_BLOCK_LEN = 8000;

// Role markers stripped at the start of a line. `(?<![^\n])` is "start of
// line" with Python's MULTILINE semantics (only \n counts, unlike JS `^`/m).
const ROLE_MARKER_RE =
  /(?<![^\n])[\s>*_#-]*(system|assistant|human|user|ai|instruction)[\s]*:[ \t]*/gi;

const FENCE_OPEN = '<untrusted>';
const FENCE_CLOSE = '</untrusted>';

// The escaped forms are the literal strings used by the Python source.
const ESCAPED_OPEN = '&lt;untrusted&gt;';
const ESCAPED_CLOSE = '&lt;/untrusted&gt;';

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
  cleaned = cleaned.replaceAll(FENCE_OPEN, ESCAPED_OPEN);
  cleaned = cleaned.replaceAll(FENCE_CLOSE, ESCAPED_CLOSE);

  const head = headCodePoints(cleaned, maxLen);
  if (head !== null) cleaned = head + '… [truncated]';

  return `${FENCE_OPEN}${cleaned}${FENCE_CLOSE}`;
}

export function sanitizeInline(text: string | null | undefined, maxLen = 200): string {
  if (text === null || text === undefined) return '';
  let s = String(text);
  s = stripRoleMarkers(s);
  s = s.replaceAll(FENCE_OPEN, ESCAPED_OPEN);
  s = s.replaceAll(FENCE_CLOSE, ESCAPED_CLOSE);
  s = s.replace(/\s+/g, ' ').trim();
  const head = headCodePoints(s, maxLen);
  if (head !== null) s = head + '…';
  return s;
}

export { MAX_BLOCK_LEN };
