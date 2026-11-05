import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { loadConfig } from '../../src/config.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { LocalStorage } from '../../src/storage/local.js';
import { computePreferences } from '../../src/tasks/preferences.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';
import { fakeProviders } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
let s: Seeded;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  await sql`DELETE FROM feeds`;
});

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
function harness() {
  const logger = pino({ level: 'silent' });
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'x', retryCount: 0, signal: new AbortController().signal },
    sql,
    logger,
    600_000,
  );
  const deps: WorkerDeps = {
    sql,
    config,
    env: {},
    logger,
    storage: new LocalStorage(config, Buffer.from('k'.repeat(32))),
    queue: testQueue(),
    providers: fakeProviders().deps,
    rng: () => 0.5,
  };
  return { ctx, deps };
}

async function feed(posts: unknown[]) {
  const id = randomUUID();
  await sql`INSERT INTO feeds (id, user_id, posts, post_count) VALUES (${id}, ${s.user_a}, ${sql.json(posts as never)}, ${posts.length})`;
  return id;
}
async function like(feedId: string, idx: number, persona: string | null, type: string | null, cat: string | null) {
  await sql`INSERT INTO user_likes (user_id, feed_id, post_index, persona_key, post_type, category)
            VALUES (${s.user_a}, ${feedId}, ${idx}, ${persona}, ${type}, ${cat})`;
}

describe('computePreferences', () => {
  it('stores no-signal preferences with 4 likes, visible via GET /settings', async () => {
    const f = await feed([{}, {}, {}, {}]);
    for (let i = 0; i < 4; i++) await like(f, i, 'skeptic', 'take', 'a');
    const h = harness();
    const out = await computePreferences({ user_id: s.user_a }, h.ctx, h.deps);
    const expected = {
      persona_weights: {}, post_type_weights: {}, category_weights: {},
      liked_paper_titles: [], total_likes: 4, has_signal: false,
    };
    expect(out).toEqual(expected);
    const r = await client(testApp({ user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' } })).get('/settings');
    expect((await r.json()).preferences).toEqual(expected);
  });

  it('computes boosted weights and liked titles with 6 likes', async () => {
    const f = await feed([
      { paper_ref: 'Ref One', sources: [{ paper_title: 'Title A' }, { paper_title: 'Title B' }, {}] },
      { paper_ref: 'Ref One', sources: [{ paper_title: 'Title A' }] },
      { sources: [{ paper_title: 'Title C' }] },
      { paper_ref: 'Ref Two' },
      { paper_ref: 'Never Liked' },
    ]);
    await like(f, 0, 'skeptic', 'take', 'methods');
    await like(f, 1, 'hype', 'take', 'methods');
    await like(f, 2, 'skeptic', 'thread', null);
    await like(f, 3, 'skeptic', null, 'results');
    await like(f, 3 + 10, 'hype', 'take', 'methods'); // past the end of posts: ignored for titles
    // annotate posts 0 and 2
    await sql`INSERT INTO annotations (user_id, feed_id, post_index, body) VALUES (${s.user_a}, ${f}, 0, 'n'), (${s.user_a}, ${f}, 2, 'n')`;
    await like(f, 4, 'skeptic', 'take', 'methods'); // sixth like (post 4 is 'Never Liked')
    const h = harness();
    const out = await computePreferences({ user_id: s.user_a }, h.ctx, h.deps);
        // persona: skeptic 2+2+1+1=6, hype 1+1=2 => 0.75/0.25
    expect(out.total_likes).toBe(6);
    expect(out.has_signal).toBe(true);
    expect(out.persona_weights).toEqual({ skeptic: 0.75, hype: 0.25 });
    // type: take 2+1+1+1=5, thread 2 => 5/7, 2/7
    expect(out.post_type_weights).toEqual({ take: 0.7143, thread: 0.2857 });
    // category: methods 2+1+1+1=5, results 1 => 5/6, 1/6
    expect(out.category_weights).toEqual({ methods: 0.8333, results: 0.1667 });
    expect(Object.keys(out.persona_weights)).toEqual(['skeptic', 'hype']);
    expect(new Set(out.liked_paper_titles)).toEqual(
      new Set(['Ref One', 'Title A', 'Title B', 'Title C', 'Ref Two', 'Never Liked']),
    );
    const [row] = await sql`SELECT settings FROM user_settings WHERE user_id = ${s.user_a}`;
    expect(row!.settings.preferences).toEqual(out);
  });

  it('keeps a concurrent user setting', async () => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${s.user_a}, ${sql.json({ theme: 'light' } as never)})`;
    const h = harness();
    await computePreferences({ user_id: s.user_a }, h.ctx, h.deps);
    const [row] = await sql`SELECT settings FROM user_settings WHERE user_id = ${s.user_a}`;
    expect(row!.settings.theme).toBe('light');
    expect(row!.settings.preferences.has_signal).toBe(false);
  });

  it('inserts a user_settings row when none exists', async () => {
    await sql`DELETE FROM user_settings WHERE user_id = ${s.user_a}`;
    const h = harness();
    await computePreferences({ user_id: s.user_a }, h.ctx, h.deps);
    const rows = await sql`SELECT settings FROM user_settings WHERE user_id = ${s.user_a}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settings.preferences.total_likes).toBe(0);
  });

  it('is registered in HANDLERS', () => {
    expect(HANDLERS.compute_preferences).toBeTypeOf('function');
  });
});
