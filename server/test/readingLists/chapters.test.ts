import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { insertChapters, insertReorderChapters } from '../../src/readingLists/chapters.js';
import { resetDb, seedUsers, testSql, USER_A_ID } from '../helpers/db.js';

const sql = testSql();

async function newList(): Promise<string> {
  const [row] = await sql`
    INSERT INTO reading_lists (user_id, name) VALUES (${USER_A_ID}, 'L') RETURNING id`;
  return String(row!.id);
}

const chapters = async (listId: string) =>
  sql`SELECT chapter_index, paper_ids, status FROM reading_list_chapters
      WHERE reading_list_id = ${listId} ORDER BY chapter_index`;

beforeEach(async () => {
  await resetDb(sql);
  await seedUsers(sql);
});

describe('insertChapters (port of CHAPTER_INSERT_SQL)', () => {
  it('one chapter per paper, 0-based, the first unlocked and the rest locked', async () => {
    const listId = await newList();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await insertChapters(sql, listId, ids);
    expect([...(await chapters(listId))]).toEqual([
      { chapter_index: 0, paper_ids: [ids[0]], status: 'unlocked' },
      { chapter_index: 1, paper_ids: [ids[1]], status: 'locked' },
      { chapter_index: 2, paper_ids: [ids[2]], status: 'locked' },
    ]);
  });

  it('runs on a transaction handle', async () => {
    const listId = await newList();
    const ids = [randomUUID(), randomUUID()];
    await sql.begin(async (tx) => {
      await insertChapters(tx, listId, ids);
    });
    expect((await chapters(listId)).map((r) => r.status)).toEqual(['unlocked', 'locked']);
  });
});

describe('insertReorderChapters (port of REORDER_CHAPTER_INSERT_SQL)', () => {
  it('starts after maxComplete and unlocks only the first new chapter', async () => {
    const listId = await newList();
    const [x, y] = [randomUUID(), randomUUID()];
    await insertReorderChapters(sql, listId, [x, y], 1);
    expect([...(await chapters(listId))]).toEqual([
      { chapter_index: 2, paper_ids: [x], status: 'unlocked' },
      { chapter_index: 3, paper_ids: [y], status: 'locked' },
    ]);
  });

  it('maxComplete -1 starts at index 0', async () => {
    const listId = await newList();
    const [x, y] = [randomUUID(), randomUUID()];
    await insertReorderChapters(sql, listId, [x, y], -1);
    expect((await chapters(listId)).map((r) => [r.chapter_index, r.status])).toEqual([
      [0, 'unlocked'],
      [1, 'locked'],
    ]);
  });
});
