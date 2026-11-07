import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker, type RunningWorker } from '../../src/worker/main.js';
import { CSRF_TEST_TOKEN, client, testApp, testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';
import { fakeProviders, type ChatPurpose } from '../helpers/fakeProviders.js';

const sql = testSql();
const SAMPLE = new Uint8Array(readFileSync(new URL('../fixtures/sample.pdf', import.meta.url)));
const WAIT = { timeout: 60000, interval: 100 };
const BASE = '/ficino/api';
// Four turns: fewer than MIN_SEGMENTS (4) would switch the job to its fallback script.
const PODCAST_SEGMENTS = [
  { speaker: 'host_a', text: 'Welcome to the chapter.' },
  { speaker: 'host_b', text: 'The sample study held up.' },
  { speaker: 'host_a', text: 'Even with one sample?' },
  { speaker: 'host_b', text: 'Next time, the second paper.' },
];

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

describe('reading lists and audio end to end: ordering, chapter, feed audio, dead-claim recovery, podcast, cleanup', () => {
  it('runs a reading list through its chapter feed, audio and podcast in one process with fake providers', async () => {
    const dirs = testStorageDirs();
    const env = {
      DATABASE_URL: process.env.DATABASE_URL,
      AUTH_PROVIDER: 'none',
      ENVIRONMENT: 'development',
      LOG_LEVEL: 'silent',
      OLLAMA_BASE_URL: 'http://fake-ollama:11434',
      ELEVENLABS_API_KEY: 'fake',
      UPLOAD_DIR: dirs.uploadDir,
      FIGURES_DIR: dirs.figuresDir,
      MEDIA_DIR: dirs.mediaDir,
    };
    const purposes: ChatPurpose[] = [];
    const f = fakeProviders({
      chat: (_b, info) => {
        purposes.push(info.purpose);
        switch (info.purpose) {
          case 'metadata':
            return '{"title": "Sample Study", "authors": ["Ada Reader"], "year": 2024, "doi": null, "tags": []}';
          case 'context':
            return 'A situating sentence.';
          case 'classify':
            return 'extends';
          case 'ordering': {
            // A valid ordering of exactly the ids in the prompt, in prompt order.
            const ids = [...info.system.matchAll(/^Paper ID: (\S+)$/gm)].map((m) => m[1]!);
            return JSON.stringify(
              ids.map((paper_id, i) => ({ paper_id, position: i + 1, rationale: `Read this one at step ${i + 1}.` })),
            );
          }
          case 'chapter':
          case 'persona':
            return JSON.stringify({ post_type: 'post', content: `A chapter take ${purposes.length}.` });
          case 'podcast':
            return JSON.stringify({ segments: PODCAST_SEGMENTS });
          default:
            return 'Page text.';
        }
      },
    });
    worker = await startWorker(env, { providers: f.deps });

    const app = testApp({
      user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' },
      providers: f.deps,
      config: { ollamaBaseUrl: 'http://fake-ollama:11434', elevenlabsApiKey: 'fake' },
    });
    const c = client(app);
    await sql`
      INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json({
        personas_enabled: { skeptic: true, hype: true, methodologist: true, practitioner: false, gradstudent: false },
        post_type_weights: { post: 1, thread: 0, quote: 0, reply: 0, figure: 0 },
        posts_per_generation: 2,
      } as never)})
      ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`;

    const upload = async (): Promise<string> => {
      const form = new FormData();
      form.set('file', new File([SAMPLE as BlobPart], 'sample.pdf', { type: 'application/pdf' }));
      const up = await app.request(`/papers?workspace_id=${seeded.workspace_a}`, {
        method: 'POST',
        body: form,
        headers: { cookie: `ficino_csrf=${CSRF_TEST_TOKEN}`, 'x-csrf-token': CSRF_TEST_TOKEN },
      });
      if (up.status >= 300) throw new Error(`upload ${up.status} ${await up.text()}`);
      const id = String((await up.json()).id);
      await vi.waitFor(async () => {
        const [p] = await sql`SELECT status FROM papers WHERE id = ${id}`;
        expect(p!.status).toBe('complete');
      }, WAIT);
      return id;
    };
    /** GET a media URL from GET /feed/{id} the way nginx forwards it (public base stripped), with a byte range. */
    const getMedia = async (url: string, range?: string) => {
      expect(url.startsWith(`${BASE}/media/`)).toBe(true);
      const res = await app.request(url.slice(BASE.length), range ? { headers: { range } } : {});
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    };
    const getFeed = async (feedId: string): Promise<Record<string, any>> => {
      const res = await c.get(`/feed/${feedId}`);
      expect(res.status).toBe(200);
      return res.json();
    };

    // 1. Two ingested papers.
    const paper1 = await upload();
    const paper2 = await upload();

    // 2. A reading list; the ordering job stores a rationale per paper.
    const created = await c.post('/reading-lists', { name: 'Two copies', paper_ids: [paper1, paper2] });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ paper_count: 2 });
    const listId = String(createdBody.id);
    let detail: Record<string, any> = {};
    await vi.waitFor(async () => {
      detail = await (await c.get(`/reading-lists/${listId}`)).json();
      expect(detail.papers.some((p: { rationale: string }) => p.rationale)).toBe(true);
    }, WAIT);
    expect(detail.papers.map((p: { id: string }) => p.id)).toEqual([paper1, paper2]);
    expect(detail.papers.map((p: { rationale: string }) => p.rationale)).toEqual([
      'Read this one at step 1.',
      'Read this one at step 2.',
    ]);
    expect(detail.chapters.map((ch: { status: string }) => ch.status)).toEqual(['unlocked', 'locked']);

    // 3. Chapter 0 becomes a feed and unlocks chapter 1.
    const gen = await c.post(`/reading-lists/${listId}/chapters/0/generate`);
    expect(gen.status).toBe(202);
    const { task_id: chapterTask } = await gen.json();
    let st: Record<string, any> = {};
    await vi.waitFor(async () => {
      st = await (await c.get(`/feed/status/${chapterTask}`)).json();
      expect(st.status).toBe('complete');
    }, WAIT);
    const feedId = String(st.feed_id);
    detail = await (await c.get(`/reading-lists/${listId}`)).json();
    expect(detail.chapters[0]).toMatchObject({ chapter_index: 0, status: 'complete', feed_id: feedId });
    expect(detail.chapters[1]).toMatchObject({ chapter_index: 1, status: 'unlocked', feed_id: null });
    const chapterFeed = await getFeed(feedId);
    expect(chapterFeed.posts.length).toBeGreaterThan(0);
    expect(chapterFeed.audio_status).toBeNull();

    // 4. Feed audio: one file per post, each playable through the stripped URL with a byte range.
    const audio = await c.post(`/feed/${feedId}/audio`);
    expect(audio.status).toBe(202);
    expect(await audio.json()).toMatchObject({ status: 'generating' });
    let feed: Record<string, any> = {};
    await vi.waitFor(async () => {
      feed = await getFeed(feedId);
      expect(feed.audio_status).toBe('ready');
    }, WAIT);
    const playable = (feed.posts as Array<{ audio_url?: string }>).filter((p) => p.audio_url);
    expect(playable).toHaveLength(feed.posts.length);
    for (const p of playable) {
      const r = await getMedia(p.audio_url!, 'bytes=0-1');
      expect(r.status).toBe(206);
      expect(r.bytes).toHaveLength(2);
    }
    const ttsCalls = f.calls.filter((call) => call.kind === 'elevenlabs-tts').length;
    expect(ttsCalls).toBe(feed.posts.length);

    // 5. Dead-job recovery (deliberate change 13): a SIGKILLed job leaves a stale claim and no audio keys.
    await sql`
      UPDATE feeds SET audio_status = 'generating', audio_claimed_at = NOW() - interval '1 day',
        posts = (SELECT jsonb_agg(p - 'audio_key' ORDER BY ord) FROM jsonb_array_elements(posts) WITH ORDINALITY AS t(p, ord))
      WHERE id = ${feedId}`;
    const stale = await getFeed(feedId);
    expect(stale.audio_status).toBe('generating');
    expect((stale.posts as Array<Record<string, unknown>>).every((p) => p.audio_url === undefined)).toBe(true);
    const again = await c.post(`/feed/${feedId}/audio`);
    expect(again.status).toBe(202);
    const againBody = await again.json();
    expect(againBody.status).toBe('generating');
    expect(typeof againBody.task_id).toBe('string');
    await vi.waitFor(async () => {
      feed = await getFeed(feedId);
      expect(feed.audio_status).toBe('ready');
    }, WAIT);
    expect((feed.posts as Array<{ audio_url?: string }>).every((p) => typeof p.audio_url === 'string')).toBe(true);
    expect(f.calls.filter((call) => call.kind === 'elevenlabs-tts')).toHaveLength(2 * ttsCalls);

    // 6. The podcast: one dialogue render, one episode file.
    const pod = await c.post(`/feed/${feedId}/podcast`);
    expect(pod.status).toBe(202);
    await vi.waitFor(async () => {
      feed = await getFeed(feedId);
      expect(feed.podcast_status).toBe('ready');
      expect(typeof feed.podcast_audio_url).toBe('string');
    }, WAIT);
    const episode = await getMedia(String(feed.podcast_audio_url));
    expect(episode.status).toBe(200);
    expect(episode.bytes.length).toBeGreaterThan(0);
    expect(feed.podcast_segments.map((s: { speaker: string; text: string }) => ({ speaker: s.speaker, text: s.text }))).toEqual(
      PODCAST_SEGMENTS,
    );
    const mediaDir = join(dirs.mediaDir, 'feeds', feedId);
    expect(existsSync(join(mediaDir, 'podcast', 'episode.mp3'))).toBe(true);

    // 7. Clearing feeds removes the feed's media directory.
    const cleared = await c.post('/settings/clear-feeds');
    expect(cleared.status).toBe(200);
    expect(existsSync(mediaDir)).toBe(false);

    // Every chat the fakes answered was recognised; the podcast was exactly one dialogue call.
    expect(purposes.filter((p) => p === 'other')).toEqual([]);
    for (const p of ['ordering', 'chapter', 'podcast'] as const) expect(purposes).toContain(p);
    const dialogue = f.calls.filter((call) => call.kind === 'elevenlabs-dialogue');
    expect(dialogue).toHaveLength(1);
    expect((dialogue[0]!.body as { inputs: Array<{ text: string }> }).inputs.map((i) => i.text)).toEqual(
      PODCAST_SEGMENTS.map((s) => s.text),
    );
    expect(f.calls.filter((call) => call.kind.startsWith('elevenlabs')).every((call) => call.apiKey === 'fake')).toBe(true);
  }, 240000);
});
