import { describe, expect, it } from 'vitest';
import { PY_WORD, PY_WS, pyIsUpper, pyLen, pyRound, pySlice, pySplit, pyStrip } from '../../src/shared/pystr.js';

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
  it('regex sources', () => {
    expect(new RegExp(`^[${PY_WS}]$`, 'u').test('　')).toBe(true);
    expect(new RegExp(`^${PY_WORD}$`, 'u').test('é')).toBe(true);
    expect(new RegExp(`^${PY_WORD}$`, 'u').test('-')).toBe(false);
  });
});
