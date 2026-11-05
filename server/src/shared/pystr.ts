/** Python string/number semantics (code points, str.split/strip/isupper, round, \w). */

/** Regex source for the characters Python's `str.isspace` accepts (verified against CPython). */
export const PY_WS =
  '\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

/** Regex source for Python's `\w` on str (use with the `u` flag). */
export const PY_WORD = '[\\p{L}\\p{N}_]';

const WS_CHAR_RE = new RegExp(`^[${PY_WS}]$`);
const SPLIT_RE = new RegExp(`[${PY_WS}]+`);

/**
 * `str.strip()` with no argument. A linear scan from both ends: the regex `[ws]+$` retries from every interior
 * whitespace run and went quadratic (160k interior spaces took 16.6 s). Every PY_WS character is in the BMP, so
 * testing single UTF-16 units is exact (a surrogate half never matches).
 */
export function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && WS_CHAR_RE.test(s[start]!)) start++;
  while (end > start && WS_CHAR_RE.test(s[end - 1]!)) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** `str.split()` with no argument: split on whitespace runs, drop empties. */
export function pySplit(s: string): string[] {
  return s.split(SPLIT_RE).filter((p) => p !== '');
}

/** `len(s)`: code points, not UTF-16 units. */
export function pyLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** `s[start:end]` by code points, for non-negative start/end. */
export function pySlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join('');
}

/** `str.isupper()`: at least one cased character and no lowercase/titlecase ones. */
export function pyIsUpper(s: string): boolean {
  return /[\p{Lu}\p{Ll}\p{Lt}]/u.test(s) && !/[\p{Ll}\p{Lt}]/u.test(s);
}

/** Python's `round(x, nd)`: half-even on the exact binary value of x. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const bits = buf.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let m = bits & ((1n << 52n) - 1n);
  let e: number;
  if (expBits === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = expBits - 1075;
  }
  // |x| = m * 2^e ; scaled = |x| * 10^nd = num / den
  let num = m;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den <<= BigInt(-e);
  if (nd >= 0) num *= 10n ** BigInt(nd);
  else den *= 10n ** BigInt(-nd);
  let q = num / den;
  const r = num % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  const out = nd >= 0 ? Number(q) / 10 ** nd : Number(q) * 10 ** -nd;
  return neg ? -out : out;
}

/** Python `str(x)` for a JSON value (ints print as ints; JS cannot tell 5.0 from 5). */
export function pyStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

/** `json.dumps(s)` for a string under the default ensure_ascii=True: non-ASCII UTF-16 units become lowercase \\uXXXX. */
export function pyJsonString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
