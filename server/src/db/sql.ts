import postgres from 'postgres';

export type Sql = postgres.Sql;

/** timestamptz/timestamp stay raw PG text so microseconds survive (see time.ts). */
const rawTimestamps = {
  rawTimestamps: {
    to: 1184,
    from: [1184, 1114],
    serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
    parse: (x: string) => x,
  },
};

/**
 * Server NOTICEs (e.g. "relation already exists, skipping" on every boot's migrations) are dropped unless the caller
 * routes them somewhere; postgres.js would otherwise console.log each one.
 */
export function createSql(url: string, opts: { max?: number; onnotice?: (notice: postgres.Notice) => void } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: opts.onnotice ?? (() => undefined),
    connection: { TimeZone: 'UTC' },
    types: rawTimestamps,
  });
}
