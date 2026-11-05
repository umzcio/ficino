/** Random helpers over an injectable source. An Rng returns a float in [0, 1); production passes Math.random. */
export type Rng = () => number;

const idx = (rng: Rng, n: number): number => Math.floor(rng() * n);

/** `random.randint(lo, hi)`: inclusive on both ends. */
export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + idx(rng, hi - lo + 1);
}

/** `random.choice`. */
export function choice<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('Cannot choose from an empty sequence');
  return items[idx(rng, items.length)]!;
}

/** `random.sample`: k distinct items (partial Fisher-Yates over a copy). */
export function sample<T>(rng: Rng, items: readonly T[], k: number): T[] {
  if (k < 0 || k > items.length) throw new Error('Sample larger than population or is negative');
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    const j = idx(rng, pool.length);
    out.push(pool[j]!);
    pool[j] = pool[pool.length - 1]!;
    pool.pop();
  }
  return out;
}

/** `random.choices(items, weights)[0]`: one weighted pick. */
export function choices<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error('Total of weights must be greater than zero');
  const x = rng() * total;
  let acc = 0;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i]! <= 0) continue;
    acc += weights[i]!;
    last = i;
    if (x < acc) return items[i]!;
  }
  return items[last]!;
}
