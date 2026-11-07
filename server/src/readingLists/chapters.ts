// Chapter-row creation for reading lists, shared by the /reading-lists routes and the propose_ordering worker
// (port of CHAPTER_INSERT_SQL, shared/ficino_shared/constants.py, and REORDER_CHAPTER_INSERT_SQL,
// api/routers/reading_lists.py).
import type postgres from 'postgres';
import type { Sql } from '../db/sql.js';

/**
 * One chapter per paper, in order: index 0-based, the first `unlocked`, the rest `locked`. The initial state
 * of a list's chapter flow, used by create, apply-ordering and the ordering job.
 */
export async function insertChapters(
  db: Sql | postgres.TransactionSql,
  listId: string,
  paperIds: string[],
): Promise<void> {
  await db`
    INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
    SELECT ${listId}::uuid, (row_num - 1)::int, ARRAY[pid]::uuid[],
           CASE WHEN row_num = 1 THEN 'unlocked' ELSE 'locked' END
    FROM unnest(${paperIds}::uuid[]) WITH ORDINALITY AS t(pid, row_num)`;
}

/**
 * Reorder's chapters for the papers after the highest `complete` chapter: indexes start at `maxComplete + 1`
 * (`-1` when none is complete) and the first new chapter is `unlocked`. Completed chapters are kept by the caller.
 */
export async function insertReorderChapters(
  db: Sql | postgres.TransactionSql,
  listId: string,
  paperIds: string[],
  maxComplete: number,
): Promise<void> {
  await db`
    INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
    SELECT ${listId}::uuid, ${maxComplete}::int + row_num, ARRAY[pid]::uuid[],
           CASE WHEN row_num = 1 THEN 'unlocked' ELSE 'locked' END
    FROM unnest(${paperIds}::uuid[]) WITH ORDINALITY AS t(pid, row_num)`;
}
