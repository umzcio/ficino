import { afterAll, inject } from 'vitest';
import { stopTestBoss } from './helpers/queue.js';

process.env.DATABASE_URL = inject('databaseUrl');
process.env.LOG_LEVEL ??= 'silent'; // src/logger.ts reads this at import

afterAll(async () => {
  await stopTestBoss();
});
