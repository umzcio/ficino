import { afterAll, inject } from 'vitest';
import { stopTestBoss } from './helpers/queue.js';

process.env.DATABASE_URL = inject('databaseUrl');

afterAll(async () => {
  await stopTestBoss();
});
