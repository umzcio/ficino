import { afterEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
});

const ended: string[] = [];
vi.mock('../../src/app.js', () => ({
  createApp: () => {
    throw new Error('createApp boom');
  },
}));
vi.mock('../../src/db/sql.js', async (orig) => {
  const actual = await orig<typeof import('../../src/db/sql.js')>();
  return {
    ...actual,
    createSql: (...args: Parameters<typeof actual.createSql>) => {
      const sql = actual.createSql(...args);
      const end = sql.end.bind(sql);
      sql.end = ((...a: Parameters<typeof end>) => {
        ended.push('end');
        return end(...a);
      }) as typeof sql.end;
      return sql;
    },
  };
});

import { startApi } from '../../src/api/main.js';
import { createScratchDb } from '../helpers/db.js';

afterEach(() => {
  ended.length = 0;
});

it('startApi rejects and ends the pool when createApp throws', async () => {
  const scratch = await createScratchDb();
  try {
    await expect(startApi({ DATABASE_URL: scratch.url, PORT: '0', HOST: '127.0.0.1' })).rejects.toThrow(
      'createApp boom',
    );
    expect(ended).toEqual(['end']);
  } finally {
    await scratch.drop();
  }
});
