import { describe, expect, it } from 'vitest';
import { choice, choices, randInt, sample } from '../../src/shared/random.js';

const seq = (...v: number[]) => {
  let i = 0;
  return () => v[i++ % v.length]!;
};

describe('random', () => {
  it('randInt is inclusive on both ends', () => {
    expect(randInt(seq(0), 3, 6)).toBe(3);
    expect(randInt(seq(0.9999), 3, 6)).toBe(6);
    expect(randInt(seq(0.5), 3, 6)).toBe(5);
  });
  it('choice picks by floor(rng*n) and throws on empty', () => {
    expect(choice(seq(0.5), ['a', 'b', 'c', 'd'])).toBe('c');
    expect(() => choice(seq(0), [])).toThrow();
  });
  it('sample returns k distinct items and throws when k > n', () => {
    expect(sample(seq(0, 0, 0), [1, 2, 3], 3).sort()).toEqual([1, 2, 3]);
    expect(sample(seq(0.9, 0), [1, 2, 3], 2)).toEqual([3, 1]);
    expect(() => sample(seq(0), [1, 2], 3)).toThrow();
  });
  it('choices is weighted and rejects zero total', () => {
    expect(() => choices(seq(0), ['a', 'b'], [0, 0])).toThrow('Total of weights must be greater than zero');
    for (const x of [0, 0.3, 0.9999]) expect(choices(seq(x), ['a', 'b'], [0, 1])).toBe('b');
    expect(choices(seq(0.24), ['a', 'b'], [1, 3])).toBe('a');
    expect(choices(seq(0.25), ['a', 'b'], [1, 3])).toBe('b');
  });
});
