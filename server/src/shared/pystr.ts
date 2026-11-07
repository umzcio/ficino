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

/** Python truthiness of a JSON value: `None`, `False`, `0`, `""`, `[]` and `{}` are false. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/**
 * Python's type name for a JSON value, as in `'<type>' object has no attribute 'get'`. A jsonb `1.0` is a Python
 * float but a JS integer; that edge is out of scope.
 */
export function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/**
 * Every code point whose Python `c.title()` differs from `c.upper()` (CPython 3.11, Unicode 14): the `Lt` digraphs,
 * full special casing (`ß -> Ss`, `ﬁ -> Fi`) and Georgian Mkhedruli, which titlecases to itself. Copied from the
 * golden `feed-audio.json` (`title_exceptions`); `test/shared/pystr.test.ts` pins the two equal.
 */
export const PY_TITLE_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  '\u{DF}': 'Ss', '\u{1C4}': '\u{1C5}', '\u{1C5}': '\u{1C5}', '\u{1C6}': '\u{1C5}', '\u{1C7}': '\u{1C8}',
  '\u{1C8}': '\u{1C8}', '\u{1C9}': '\u{1C8}', '\u{1CA}': '\u{1CB}', '\u{1CB}': '\u{1CB}', '\u{1CC}': '\u{1CB}',
  '\u{1F1}': '\u{1F2}', '\u{1F2}': '\u{1F2}', '\u{1F3}': '\u{1F2}', '\u{587}': '\u{535}\u{582}',
  '\u{10D0}': '\u{10D0}', '\u{10D1}': '\u{10D1}', '\u{10D2}': '\u{10D2}', '\u{10D3}': '\u{10D3}',
  '\u{10D4}': '\u{10D4}', '\u{10D5}': '\u{10D5}', '\u{10D6}': '\u{10D6}', '\u{10D7}': '\u{10D7}',
  '\u{10D8}': '\u{10D8}', '\u{10D9}': '\u{10D9}', '\u{10DA}': '\u{10DA}', '\u{10DB}': '\u{10DB}',
  '\u{10DC}': '\u{10DC}', '\u{10DD}': '\u{10DD}', '\u{10DE}': '\u{10DE}', '\u{10DF}': '\u{10DF}',
  '\u{10E0}': '\u{10E0}', '\u{10E1}': '\u{10E1}', '\u{10E2}': '\u{10E2}', '\u{10E3}': '\u{10E3}',
  '\u{10E4}': '\u{10E4}', '\u{10E5}': '\u{10E5}', '\u{10E6}': '\u{10E6}', '\u{10E7}': '\u{10E7}',
  '\u{10E8}': '\u{10E8}', '\u{10E9}': '\u{10E9}', '\u{10EA}': '\u{10EA}', '\u{10EB}': '\u{10EB}',
  '\u{10EC}': '\u{10EC}', '\u{10ED}': '\u{10ED}', '\u{10EE}': '\u{10EE}', '\u{10EF}': '\u{10EF}',
  '\u{10F0}': '\u{10F0}', '\u{10F1}': '\u{10F1}', '\u{10F2}': '\u{10F2}', '\u{10F3}': '\u{10F3}',
  '\u{10F4}': '\u{10F4}', '\u{10F5}': '\u{10F5}', '\u{10F6}': '\u{10F6}', '\u{10F7}': '\u{10F7}',
  '\u{10F8}': '\u{10F8}', '\u{10F9}': '\u{10F9}', '\u{10FA}': '\u{10FA}', '\u{10FD}': '\u{10FD}',
  '\u{10FE}': '\u{10FE}', '\u{10FF}': '\u{10FF}', '\u{1F80}': '\u{1F88}', '\u{1F81}': '\u{1F89}',
  '\u{1F82}': '\u{1F8A}', '\u{1F83}': '\u{1F8B}', '\u{1F84}': '\u{1F8C}', '\u{1F85}': '\u{1F8D}',
  '\u{1F86}': '\u{1F8E}', '\u{1F87}': '\u{1F8F}', '\u{1F88}': '\u{1F88}', '\u{1F89}': '\u{1F89}',
  '\u{1F8A}': '\u{1F8A}', '\u{1F8B}': '\u{1F8B}', '\u{1F8C}': '\u{1F8C}', '\u{1F8D}': '\u{1F8D}',
  '\u{1F8E}': '\u{1F8E}', '\u{1F8F}': '\u{1F8F}', '\u{1F90}': '\u{1F98}', '\u{1F91}': '\u{1F99}',
  '\u{1F92}': '\u{1F9A}', '\u{1F93}': '\u{1F9B}', '\u{1F94}': '\u{1F9C}', '\u{1F95}': '\u{1F9D}',
  '\u{1F96}': '\u{1F9E}', '\u{1F97}': '\u{1F9F}', '\u{1F98}': '\u{1F98}', '\u{1F99}': '\u{1F99}',
  '\u{1F9A}': '\u{1F9A}', '\u{1F9B}': '\u{1F9B}', '\u{1F9C}': '\u{1F9C}', '\u{1F9D}': '\u{1F9D}',
  '\u{1F9E}': '\u{1F9E}', '\u{1F9F}': '\u{1F9F}', '\u{1FA0}': '\u{1FA8}', '\u{1FA1}': '\u{1FA9}',
  '\u{1FA2}': '\u{1FAA}', '\u{1FA3}': '\u{1FAB}', '\u{1FA4}': '\u{1FAC}', '\u{1FA5}': '\u{1FAD}',
  '\u{1FA6}': '\u{1FAE}', '\u{1FA7}': '\u{1FAF}', '\u{1FA8}': '\u{1FA8}', '\u{1FA9}': '\u{1FA9}',
  '\u{1FAA}': '\u{1FAA}', '\u{1FAB}': '\u{1FAB}', '\u{1FAC}': '\u{1FAC}', '\u{1FAD}': '\u{1FAD}',
  '\u{1FAE}': '\u{1FAE}', '\u{1FAF}': '\u{1FAF}', '\u{1FB2}': '\u{1FBA}\u{345}', '\u{1FB3}': '\u{1FBC}',
  '\u{1FB4}': '\u{386}\u{345}', '\u{1FB7}': '\u{391}\u{342}\u{345}', '\u{1FBC}': '\u{1FBC}',
  '\u{1FC2}': '\u{1FCA}\u{345}', '\u{1FC3}': '\u{1FCC}', '\u{1FC4}': '\u{389}\u{345}',
  '\u{1FC7}': '\u{397}\u{342}\u{345}', '\u{1FCC}': '\u{1FCC}', '\u{1FF2}': '\u{1FFA}\u{345}', '\u{1FF3}': '\u{1FFC}',
  '\u{1FF4}': '\u{38F}\u{345}', '\u{1FF7}': '\u{3A9}\u{342}\u{345}', '\u{1FFC}': '\u{1FFC}', '\u{FB00}': 'Ff',
  '\u{FB01}': 'Fi', '\u{FB02}': 'Fl', '\u{FB03}': 'Ffi', '\u{FB04}': 'Ffl', '\u{FB05}': 'St', '\u{FB06}': 'St',
  '\u{FB13}': '\u{544}\u{576}', '\u{FB14}': '\u{544}\u{565}', '\u{FB15}': '\u{544}\u{56B}',
  '\u{FB16}': '\u{54E}\u{576}', '\u{FB17}': '\u{544}\u{56D}',
});

const CASED_RE = /^\p{Cased}$/u;
const CASE_IGNORABLE_RE = /^\p{Case_Ignorable}$/u;

/**
 * CPython's `handle_capital_sigma`: `ς` when a cased character precedes the sigma and none follows it, skipping
 * case-ignorable characters in each direction; else `σ`.
 */
function capitalSigma(cps: string[], i: number): string {
  let j = i - 1;
  while (j >= 0 && CASE_IGNORABLE_RE.test(cps[j]!)) j--;
  let final = j >= 0 && CASED_RE.test(cps[j]!);
  if (final) {
    let k = i + 1;
    while (k < cps.length && CASE_IGNORABLE_RE.test(cps[k]!)) k++;
    final = k === cps.length || !CASED_RE.test(cps[k]!);
  }
  return final ? 'ς' : 'σ';
}

/**
 * `str.title()` (CPython `do_title`), by code points: a character after a cased one is lower-cased (`Σ` by its
 * final-sigma context), any other gets its titlecase mapping (`PY_TITLE_EXCEPTIONS`, else the full uppercase).
 * "Cased" is read from each input character, never from its mapping.
 */
export function pyTitle(s: string): string {
  const cps = Array.from(s);
  let out = '';
  let previousIsCased = false;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (previousIsCased) out += c === 'Σ' ? capitalSigma(cps, i) : c.toLowerCase();
    else out += PY_TITLE_EXCEPTIONS[c] ?? c.toUpperCase();
    previousIsCased = CASED_RE.test(c);
  }
  return out;
}
