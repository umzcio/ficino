import { afterEach, expect, it, vi } from 'vitest';
import { createSql } from '../../src/db/sql.js';
import { createScratchDb } from '../helpers/db.js';

let drop: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await drop?.();
  drop = undefined;
});

it('createSql drops server NOTICEs instead of printing them', async () => {
  const scratch = await createScratchDb();
  drop = scratch.drop;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const sql = createSql(scratch.url, { max: 1 });
  try {
    await sql`DO $$ BEGIN RAISE NOTICE 'ficino-notice-probe'; END $$`;
    await sql`CREATE TABLE IF NOT EXISTS notice_probe (id int)`;
    await sql`CREATE TABLE IF NOT EXISTS notice_probe (id int)`; // "relation already exists, skipping"
  } finally {
    await sql.end();
  }
  expect(log).not.toHaveBeenCalled();
});
