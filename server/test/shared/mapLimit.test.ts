import { expect, it } from 'vitest';
import { mapLimit } from '../../src/shared/mapLimit.js';

it('never exceeds limit in flight and keeps input order', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, n * 5));
    active--;
    return n * 10;
  });
  expect(out).toEqual([50, 10, 40, 20, 30, 0]);
  expect(peak).toBe(2);
});
it('first rejection rejects the call', async () => {
  await expect(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
  ).rejects.toThrow('boom');
});
it('handles empty input', async () => {
  expect(await mapLimit([], 3, async (x) => x)).toEqual([]);
});
