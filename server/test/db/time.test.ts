import { expect, it } from 'vitest';
import { createSql } from '../../src/db/sql.js';
import { toIsoformat, toPydanticIso } from '../../src/db/time.js';
import { dbName, testSql } from '../helpers/db.js';

it.each([
  ['2026-01-01 01:02:03+00', '2026-01-01T01:02:03Z', '2026-01-01T01:02:03+00:00'],
  ['2026-01-01 01:02:03.000005+00', '2026-01-01T01:02:03.000005Z', '2026-01-01T01:02:03.000005+00:00'],
  ['2026-01-01 01:02:03.12+00', '2026-01-01T01:02:03.120000Z', '2026-01-01T01:02:03.120000+00:00'],
])('%s', (pg, pyd, iso) => {
  expect(toPydanticIso(pg)).toBe(pyd);
  expect(toIsoformat(pg)).toBe(iso);
});

it('null passes through', () => {
  expect(toPydanticIso(null)).toBeNull();
  expect(toIsoformat(null)).toBeNull();
});

it('non-UTC database default still yields Z', async () => {
  const sql = testSql();
  await sql`ALTER DATABASE ${sql(dbName())} SET timezone TO 'America/Denver'`;
  try {
    const fresh = createSql(process.env.DATABASE_URL!);
    try {
      const [r] = await fresh`SELECT '2026-01-01T01:02:03Z'::timestamptz AS t`;
      expect(toPydanticIso(r!.t)).toBe('2026-01-01T01:02:03Z');
    } finally {
      await fresh.end();
    }
  } finally {
    await sql`ALTER DATABASE ${sql(dbName())} RESET timezone`;
  }
});
