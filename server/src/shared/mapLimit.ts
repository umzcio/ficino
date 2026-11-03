/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results keep input order;
 * the first rejection rejects the whole call and stops starting new items.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : n }, worker));
  return results;
}
