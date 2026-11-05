import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker, type RunningWorker } from '../../src/worker/main.js';
import { CSRF_TEST_TOKEN, client, testApp, testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';
import { fakeProviders } from '../helpers/fakeProviders.js';

const sql = testSql();
const SAMPLE = new Uint8Array(readFileSync(new URL('../fixtures/sample.pdf', import.meta.url)));

let worker: RunningWorker | undefined;
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});
afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

/** A three-word phrase from the first source chunk in a persona prompt. */
function phraseFrom(user: string): string {
  const m = /\[Source 1:[^\n]*\n<untrusted>([\s\S]*?)<\/untrusted>/.exec(user);
  const words = (m?.[1] ?? '').match(/[A-Za-z]{6,}/g) ?? [];
  return words.slice(0, 3).join(' ');
}

describe('feed end to end: upload, ingest, generate, read, search, regenerate', () => {
  it('runs the whole pipeline in one process with fake providers', async () => {
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
    let personaCalls = 0;
    let firstPhrase = '';
    const f = fakeProviders({
      chat: (_b, info) => {
        if (info.purpose === 'metadata') return '{"title": "Sample Study", "authors": ["Ada Reader"], "year": 2024, "doi": null, "tags": []}';
        if (info.purpose === 'context') return 'A situating sentence.';
        if (info.purpose === 'classify') return 'extends';
        if (info.purpose === 'persona') {
          personaCalls += 1;
          const phrase = phraseFrom(info.user);
          if (personaCalls === 1) firstPhrase = phrase;
          return JSON.stringify({ post_type: 'post', content: `${phrase} take number ${personaCalls}` });
        }
        return 'Page text.';
      },
    });
    worker = await startWorker(env, { providers: f.deps });

    const app = testApp({ user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' } });
    const c = client(app);
    await sql`
      INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json({
        personas_enabled: { skeptic: true, hype: false, methodologist: false, practitioner: false, gradstudent: false },
        post_type_weights: { post: 1, thread: 0, quote: 0, reply: 0, figure: 0 },
        posts_per_generation: 3,
      } as never)})
      ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`;

    // 1. Upload the sample PDF through the API.
    const form = new FormData();
    form.set('file', new File([SAMPLE as BlobPart], 'sample.pdf', { type: 'application/pdf' }));
    const up = await app.request(`/papers?workspace_id=${seeded.workspace_a}`, {
      method: 'POST',
      body: form,
      headers: { cookie: `ficino_csrf=${CSRF_TEST_TOKEN}`, 'x-csrf-token': CSRF_TEST_TOKEN },
    });
    if (up.status >= 300) throw new Error(`upload ${up.status} ${await up.text()}`);
    const paperId = String((await up.json()).id);

    // 2. The real worker ingests it.
    await vi.waitFor(
      async () => {
        const [p] = await sql`SELECT status FROM papers WHERE id = ${paperId}`;
        expect(p!.status).toBe('complete');
      },
      { timeout: 60000, interval: 100 },
    );

    // 3-4. Generate and poll status.
    const gen = await c.post('/feed/generate', {});
    expect(gen.status).toBe(202);
    const { task_id } = await gen.json();
    let status: Record<string, any> = {};
    await vi.waitFor(
      async () => {
        status = await (await c.get(`/feed/status/${task_id}`)).json();
        expect(status.status).toBe('complete');
      },
      { timeout: 60000, interval: 100 },
    );
    const feedId = String(status.feed_id);

    // 5. The feed has post_count posts, each with sources.
    const feed = await (await c.get(`/feed/${feedId}`)).json();
    expect(status.post_count).toBeGreaterThan(0);
    expect(feed.posts).toHaveLength(status.post_count);
    for (const p of feed.posts) {
      expect(Array.isArray(p.sources)).toBe(true);
      expect(p.sources.length).toBeGreaterThan(0);
    }
    expect(firstPhrase).not.toBe('');

    // 6. Search finds the post by a phrase from its source chunk.
    const found = await (await c.get(`/search?q=${encodeURIComponent(firstPhrase)}`)).json();
    expect(found.posts.some((p: any) => p.feed_id === feedId)).toBe(true);
    expect(found.chunks.length).toBeGreaterThan(0);

    // 7. Regenerating post 0 changes it.
    const before = (await (await c.get(`/feed/${feedId}`)).json()).posts[0].content;
    const rg = await c.post(`/feed/${feedId}/regenerate/0`, {});
    expect(rg.status).toBe(202);
    await vi.waitFor(
      async () => {
        const now = (await (await c.get(`/feed/${feedId}`)).json()).posts[0].content;
        expect(now).not.toBe(before);
      },
      { timeout: 60000, interval: 100 },
    );

    // 8. Fan-out jobs both completed.
    await vi.waitFor(
      async () => {
        const rows = await sql`
          SELECT name, count(*)::int AS n FROM pgboss.job
          WHERE name IN ('check_post_feed', 'compute_preferences') AND state = 'completed' GROUP BY name`;
        expect(Object.fromEntries(rows.map((r) => [r.name, r.n]))).toMatchObject({
          check_post_feed: expect.any(Number),
          compute_preferences: expect.any(Number),
        });
      },
      { timeout: 60000, interval: 100 },
    );
  }, 180000);
});
