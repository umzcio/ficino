import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerConfig } from '../../src/providers/config.js';
import { embedModelId } from '../../src/providers/embed.js';
import { loadConfig } from '../../src/config.js';
import { MAX_POSTS_PER_GENERATION } from '../../src/shared/constants.js';
import { uuid5 } from '../../src/shared/uuid5.js';
import { HANDLERS } from '../../src/worker/handlers.js';
import { startWorker, type RunningWorker } from '../../src/worker/main.js';
import { client, testApp, testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';
import { fakeProviders, fakeVector } from '../helpers/fakeProviders.js';
import { testBoss } from '../helpers/queue.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const as = (config: Record<string, unknown> = {}) =>
  client(testApp({ user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' }, config }));

const jobData = async (id: string) => {
  const b = await testBoss();
  return (await b.getJobById('generate_feed', id))?.data;
};

describe('POST /feed/generate', () => {
  it('400 when the caller has no complete papers', async () => {
    await sql`UPDATE papers SET status = 'pending' WHERE user_id = ${USER_A_ID}`;
    const r = await as().post('/feed/generate', {});
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      detail: 'No processed papers available. Upload and wait for processing to complete.',
    });
  });

  it('400 when the named corpus has no complete papers (other users papers do not count)', async () => {
    const r = await as().post('/feed/generate', { corpus_id: seeded.workspace_b });
    expect(r.status).toBe(400);
  });

  it('422 on a non-uuid corpus_id with loc [body, corpus_id]', async () => {
    const r = await as().post('/feed/generate', { corpus_id: 'not-a-uuid' });
    expect(r.status).toBe(422);
    expect((await r.json()).detail[0].loc).toEqual(['body', 'corpus_id']);
  });

  it('404 Feed not found for another users append_to_feed_id, and for a malformed one', async () => {
    for (const id of [seeded.feed_b, 'nope']) {
      const r = await as().post('/feed/generate', { append_to_feed_id: id });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: 'Feed not found' });
    }
  });

  it('202 with a uuid task_id; job data has only the always-present keys when options are empty', async () => {
    const r = await as().post('/feed/generate', { tab_focus: '', persona_key: null, num_posts: 0, extra: 'ignored' });
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.status).toBe('queued');
    expect(j.task_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await jobData(j.task_id)).toEqual({ corpus_id: null, tag_filter: null, user_id: USER_A_ID });
  });

  it('202 forwards every truthy option', async () => {
    const r = await as().post('/feed/generate', {
      corpus_id: seeded.workspace_a.toUpperCase(),
      tag_filter: ['x'],
      append_to_feed_id: seeded.feed_a,
      tab_focus: 'debates',
      persona_key: 'skeptic',
      num_posts: '4',
    });
    expect(r.status).toBe(202);
    expect(await jobData((await r.json()).task_id)).toEqual({
      corpus_id: seeded.workspace_a,
      tag_filter: ['x'],
      user_id: USER_A_ID,
      append_to_feed_id: seeded.feed_a,
      tab_focus: 'debates',
      persona_key: 'skeptic',
      num_posts: 4,
    });
  });

  it('num_posts is bounded to 0..MAX_POSTS_PER_GENERATION: out of range is 422 and enqueues nothing', async () => {
    expect(MAX_POSTS_PER_GENERATION).toBe(50);
    await testBoss();
    const c = as();
    for (const n of [51, '51', -1, '-3', '9'.repeat(400), 9007199254740991]) {
      const r = await c.post('/feed/generate', { persona_key: 'skeptic', num_posts: n });
      expect(r.status, `num_posts ${String(n).slice(0, 12)}`).toBe(422);
      expect((await r.json()).detail[0].loc).toEqual(['body', 'num_posts']);
    }
    expect(await sql`SELECT 1 FROM pgboss.job WHERE name = 'generate_feed'`).toHaveLength(0);

    const r = await c.post('/feed/generate', { persona_key: 'skeptic', num_posts: '50' });
    expect(r.status).toBe(202);
    expect(await jobData((await r.json()).task_id)).toMatchObject({ persona_key: 'skeptic', num_posts: 50 });
  });

  it('after 20 generates the next is 429; a 422 body still uses a slot', async () => {
    const app = as({ authProvider: 'basic' });
    expect((await app.post('/feed/generate', { corpus_id: 'bad' })).status).toBe(422);
    for (let i = 0; i < 19; i++) expect((await app.post('/feed/generate', {})).status).toBe(202);
    const r = await app.post('/feed/generate', {});
    expect(r.status).toBe(429);
    expect((await r.json()).detail).toMatch(/^Rate limit exceeded: 20 feed_generation per 24h/);
  });
});

describe('GET /feed/status/:task_id', () => {
  it('is pending for a non-uuid and for an unknown uuid', async () => {
    const c = as();
    for (const id of ['not-a-uuid', randomUUID()]) {
      const r = await c.get(`/feed/status/${id}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: 'pending', task_id: id });
    }
  });

  it('401 without a session under basic', async () => {
    const r = await client(testApp({ config: { authProvider: 'basic' } })).get(`/feed/status/${randomUUID()}`);
    expect(r.status).toBe(401);
  });

  it('a queued, unclaimed job is pending', async () => {
    const c = as();
    const { task_id } = await (await c.post('/feed/generate', {})).json();
    expect((await (await c.get(`/feed/status/${task_id}`)).json()).status).toBe('pending');
  });
});

describe('feed status end to end through the real worker', () => {
  let worker: RunningWorker | undefined;
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  it('retry then complete: same derived feed_id, one feed row, posts and feed_posts written once, no second LLM spend', async () => {
    const dirs = testStorageDirs();
    const env = {
      DATABASE_URL: process.env.DATABASE_URL,
      AUTH_PROVIDER: 'none',
      ENVIRONMENT: 'development',
      LOG_LEVEL: 'silent',
      OLLAMA_BASE_URL: 'http://fake-ollama:11434',
      UPLOAD_DIR: dirs.uploadDir,
      FIGURES_DIR: dirs.figuresDir,
      MEDIA_DIR: dirs.mediaDir,
    };
    // Complete paper (seeded) with chunks tagged with the embed model the worker will expect.
    const model = embedModelId(providerConfig({}, {}, loadConfig(env)));
    const contents = Array.from({ length: 20 }, (_, i) => `Alpha evidence ${i}: the effect held.`);
    const vecs = contents.map((t) => `[${fakeVector(t, 1024).join(',')}]`);
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count, embedding, metadata)
      SELECT ${seeded.paper_a}::uuid, ${USER_A_ID}::uuid, 'results', t.c, (t.i - 1)::int, 12, t.v::vector,
             ${sql.json({ embed_model: model })}
      FROM unnest(${contents}::text[], ${vecs}::text[]) WITH ORDINALITY AS t(c, v, i)`;
    const keys = (await sql`SELECT key FROM personas`).map((r) => String(r.key));
    const settings = {
      personas_enabled: Object.fromEntries(keys.map((k) => [k, k === 'skeptic'])),
      post_type_weights: { post: 1, thread: 0, quote: 0, reply: 0, figure: 0 },
      posts_per_generation: 3,
    };
    await sql`
      INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json(settings as never)})
      ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`;

    const f = fakeProviders();
    const attempts: number[] = [];
    let callsAfterFirst = -1;
    const isPersona = (c: (typeof f.calls)[number]) =>
      c.kind !== 'ollama-embed' &&
      JSON.stringify(c.body).includes('You are one of five AI personas');
    worker = await startWorker(env, {
      providers: f.deps,
      queueOverrides: { generate_feed: { retryDelay: 1 } },
      handlers: {
        generate_feed: async (data, ctx, deps) => {
          attempts.push(ctx.retryCount);
          const out = await HANDLERS.generate_feed!(data, ctx, deps); // writes the feed and its posts
          if (ctx.retryCount === 0) {
            callsAfterFirst = f.calls.filter(isPersona).length;
            throw new Error('boom after insert');
          }
          return out;
        },
      },
    });
    const c = as();
    const r = await c.post('/feed/generate', {});
    expect(r.status).toBe(202);
    const { task_id } = await r.json();

    const seen: string[] = [];
    let last: Record<string, any> = {};
    await vi.waitFor(
      async () => {
        last = await (await c.get(`/feed/status/${task_id}`)).json();
        if (seen.at(-1) !== last.status) seen.push(last.status);
        expect(last.status).toBe('complete');
      },
      { timeout: 30000, interval: 50 },
    );
    expect(seen).toContain('retry');
    expect(attempts).toEqual([0, 1]);
    const feedId = uuid5(`ficino:feed:${task_id}`);
    expect(last).toMatchObject({ task_id, feed_id: feedId });

    const rows = await sql`
      SELECT post_count, jsonb_array_length(posts) AS n, posts FROM feeds WHERE id = ${feedId}`;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.post_count).toBeGreaterThan(0);
    expect(row.n).toBe(row.post_count);
    expect(last.post_count).toBe(row.post_count);
    const ids = (row.posts as Array<{ id: string }>).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const [{ n: indexed }] = await sql`SELECT COUNT(*)::int AS n FROM feed_posts WHERE feed_id = ${feedId}`;
    expect(indexed).toBe(row.post_count);
    // Attempt 2 was the idempotent skip: no further persona LLM calls.
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(f.calls.filter(isPersona).length).toBe(callsAfterFirst);
  });
});
