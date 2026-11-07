import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, expect, it, vi } from 'vitest';

// Plan 05 Task 7, deliberate change 17a: the owner's settings load runs inside the podcast's failure catch, so a
// settings failure ends `podcast_status = 'failed'` (Python's apply_provider_settings ran before its `try` and left
// the row `generating`). In its own file because the module mock would leak into the other podcast cases.

vi.mock('../../src/providers/config.js', async (orig) => {
  const actual = await orig<typeof import('../../src/providers/config.js')>();
  return {
    ...actual,
    loadJobSettings: async () => {
      throw new Error('settings store unavailable');
    },
  };
});

import { loadConfig } from '../../src/config.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { LocalStorage } from '../../src/storage/local.js';
import { generatePodcastForFeed } from '../../src/tasks/audio.js';
import type { WorkerDeps } from '../../src/worker/handlers.js';
import { testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
const dirs = testStorageDirs();
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434', ELEVENLABS_API_KEY: 'test-eleven-key' });
let s: Seeded;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
});

it('a settings failure ends the podcast failed with no chat or ElevenLabs call', async () => {
  await sql`
    UPDATE feeds SET posts = ${sql.json([{ persona: 'skeptic', content: 'A take.' }])}
    WHERE id = ${s.feed_a}`;
  const lines: Array<{ msg: string }> = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x)) });
  const f = fakeProviders();
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'generate_podcast_for_feed', retryCount: 0, signal: new AbortController().signal },
    sql,
    logger,
    600_000,
    0,
  );
  const deps: WorkerDeps = {
    sql,
    config,
    env: {},
    logger,
    storage: new LocalStorage(dirs, Buffer.from('k'.repeat(32))),
    queue: testQueue(),
    providers: f.deps,
    rng: () => 0.5,
  };

  await expect(generatePodcastForFeed({ feed_id: s.feed_a }, ctx, deps)).rejects.toThrow('settings store unavailable');

  const [row] = await sql`SELECT podcast_status, podcast_segments FROM feeds WHERE id = ${s.feed_a}`;
  expect(row!.podcast_status).toBe('failed');
  expect(row!.podcast_segments).toBeNull();
  expect(f.calls).toHaveLength(0);
  expect(lines.map((l) => l.msg)).toContain('feed_podcast_failed');
});
