import { describe, expect, it } from 'vitest';
import { PY_WORD, PY_WS, pyIsUpper, pyJsonString, pyStr, pyLen, pyRound, pySlice, pySplit, pyStrip } from '../../src/shared/pystr.js';

// Every expected value below was checked with `python3 -I -c`.
describe('pystr', () => {
  it.each([
    [2.675, 2, 2.67],
    [0.125, 2, 0.12],
    [10.25, 1, 10.2],
    [0.5, 0, 0],
    [1.5, 0, 2],
    [-2.5, 0, -2],
    [2.5, 0, 2],
    [1234.5678, -2, 1200],
  ])('pyRound(%d, %d) = %d', (x, nd, want) => {
    expect(pyRound(x, nd)).toBe(want);
  });
  it('pyRound defaults nd to 0', () => {
    expect(pyRound(1.5)).toBe(2);
  });
  it('pySplit', () => expect(pySplit(' a b\x1cc  ')).toEqual(['a', 'b', 'c']));
  it('pyLen counts code points', () => expect(pyLen('a😀')).toBe(2));
  it('pySlice is by code points', () => {
    expect(pySlice('😀abc', 0, 2)).toBe('😀a');
    expect(pySlice('😀abc', 1)).toBe('abc');
  });
  it('pyIsUpper', () => {
    expect(pyIsUpper('ABC 1')).toBe(true);
    expect(pyIsUpper('AbC')).toBe(false);
    expect(pyIsUpper('123')).toBe(false);
    expect(pyIsUpper('ÉCOLE')).toBe(true);
  });
  it('pyStrip', () => expect(pyStrip('\x85 x 　')).toBe('x'));
  it('pyStrip edge cases', () => {
    expect(pyStrip('')).toBe('');
    expect(pyStrip(' \t\n\x1c\u3000')).toBe('');
    expect(pyStrip('x')).toBe('x');
    expect(pyStrip('\u200b x\u200b ')).toBe('\u200b x\u200b'); // U+200B is not Python whitespace
    expect(pyStrip(' a \u2028 b\u205f')).toBe('a \u2028 b');
    expect(pyStrip(' 😀 ')).toBe('😀');
  });
  it('pyStrip is linear on interior whitespace runs', () => {
    const s = `a${' '.repeat(200_000)}b`;
    const t = performance.now();
    expect(pyStrip(` ${s}\n`)).toBe(s);
    expect(performance.now() - t).toBeLessThan(2000);
  });
  it('regex sources', () => {
    expect(new RegExp(`^[${PY_WS}]$`, 'u').test('　')).toBe(true);
    expect(new RegExp(`^${PY_WORD}$`, 'u').test('é')).toBe(true);
    expect(new RegExp(`^${PY_WORD}$`, 'u').test('-')).toBe(false);
  });
});

// Expected values from `python3 -I -c 'import json;print(json.dumps(...))'` (ensure_ascii escapes DEL too).
describe('pyJsonString / pyStr', () => {
  it('matches json.dumps', () => {
    expect(pyJsonString('é "q" \n 😀')).toBe('"\\u00e9 \\"q\\" \\n \\ud83d\\ude00"');
    expect(pyJsonString('\x7fé ')).toBe('"\\u007f\\u00e9\\u2028"');
  });
  it('pyStr prints Python scalars', () => {
    expect([pyStr(null), pyStr(true), pyStr(5), pyStr('x'), pyStr([1])]).toEqual(['None', 'True', '5', 'x', '[1]']);
  });
});
