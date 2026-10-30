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

export function createSql(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    connection: { TimeZone: 'UTC' },
    types: rawTimestamps,
  });
}
