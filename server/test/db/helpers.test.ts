import { beforeEach, expect, it } from 'vitest';
import { resetDb, seedUsers, testSql } from '../helpers/db.js';

beforeEach(() => resetDb(testSql()));

it('seedUsers inserts two users with a workspace, feed and paper each', async () => {
  const sql = testSql();
  const s = await seedUsers(sql);
  const [r] = await sql`
    SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM corpora)::int AS c,
           (SELECT count(*) FROM feeds)::int AS f, (SELECT count(*) FROM papers)::int AS p`;
  expect(r).toEqual({ u: 2, c: 2, f: 2, p: 2 });
  expect(s.paper_a).not.toBe(s.paper_b);
});

it('resetDb empties tables but keeps personas and migrations', async () => {
  const sql = testSql();
  await seedUsers(sql);
  await resetDb(sql);
  const [r] = await sql`
    SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM personas)::int AS pe,
           (SELECT count(*) FROM schema_migrations)::int AS m`;
  expect(r).toEqual({ u: 0, pe: 7, m: 1 });
});
