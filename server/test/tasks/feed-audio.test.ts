import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimMedia, reclaimMinutes } from '../../src/audio/feedAudio.js';
import { loadConfig, type Config } from '../../src/config.js';
import { loadPersonas } from '../../src/feed/personas.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { DEFAULT_VOICE, VOICE_MAP } from '../../src/providers/speak.js';
import { LocalStorage } from '../../src/storage/local.js';
import { generateAudioForFeed } from '../../src/tasks/audio.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, type FakeCall, type TtsCall } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

// Plan 05 Task 6: generate_audio_for_feed against the DB with fake providers and a real LocalStorage on the test
// media dir. Ports worker/tests/test_media_claim_reclaim.py (the claim) and pins deliberate changes 6 (local
// storage works), 12 (TS error-class stages), 16 (a job abort is never a per-post failure) and 17c (a non-list
// `posts` fails).

const sql = testSql();
const dirs = testStorageDirs();
const KEY = 'test-eleven-key';
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434', ELEVENLABS_API_KEY: KEY, ...envDirs() });
const storage = new LocalStorage(dirs, Buffer.from('k'.repeat(32)));

function envDirs() {
  return { UPLOAD_DIR: dirs.uploadDir, FIGURES_DIR: dirs.figuresDir, MEDIA_DIR: dirs.mediaDir };
}

type Line = Record<string, unknown> & { msg?: string };
type Row = Record<string, any>;
let s: Seeded;

const SKEPTIC = { persona: 'skeptic', content: 'The effect held across cohorts.' };

async function setFeed(id: string, posts: unknown, audio: { status?: string | null; claimedAgoMin?: number | null } = {}) {
  await sql`
    UPDATE feeds SET posts = ${sql.json(posts as never)}, audio_status = ${audio.status ?? null},
      audio_claimed_at = CASE WHEN ${audio.claimedAgoMin ?? null}::int IS NULL THEN NULL
                              ELSE NOW() - make_interval(mins => ${audio.claimedAgoMin ?? 0}::int) END
    WHERE id = ${id}`;
}
const feedRow = async (id: string) => (await sql`SELECT * FROM feeds WHERE id = ${id}`)[0] as Row;

class FailingStorage extends LocalStorage {
  override async saveAudio(): Promise<string> {
    throw new Error('disk full');
  }
}

type HarnessOpts = {
  tts?: (call: TtsCall, n: number) => Uint8Array | Response | Promise<Uint8Array | Response>;
  controller?: AbortController;
  config?: Config;
  storage?: LocalStorage;
  fetch?: typeof fetch;
  onLog?: (line: Line) => void;
};

function harness(o: HarnessOpts = {}) {
  const lines: Line[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write: (x: string) => {
        const line = JSON.parse(x) as Line;
        lines.push(line);
        o.onLog?.(line);
      },
    },
  );
  let n = 0;
  const f = fakeProviders(o.tts ? { tts: (call) => o.tts!(call, ++n) } : {});
  const ctx = makeJobContext(
    {
      id: randomUUID(),
      name: 'generate_audio_for_feed',
      retryCount: 0,
      signal: (o.controller ?? new AbortController()).signal,
    },
    sql,
    logger,
    600_000,
    0,
  );
  const deps: WorkerDeps = {
    sql,
    config: o.config ?? config,
    env: {},
    logger,
    storage: o.storage ?? storage,
    queue: testQueue(),
    providers: o.fetch ? { ...f.deps, fetch: o.fetch } : f.deps,
    rng: () => 0.5,
  };
  return {
    lines,
    calls: f.calls,
    run: (feedId: string) => generateAudioForFeed({ feed_id: feedId }, ctx, deps) as Promise<Record<string, any>>,
  };
}
const logged = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg);
const tts = (calls: FakeCall[]) => calls.filter((c) => c.kind === 'elevenlabs-tts');
const voiceOf = (c: FakeCall) => c.url!.split('/').pop();
const textOf = (c: FakeCall) => (c.body as { text: string }).text;
const fail401 = () => new Response('nope', { status: 401 });

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
});

describe('claimMedia', () => {
  const R = reclaimMinutes(600);

  it('claims NULL and failed, returning user_id, corpus_id and posts', async () => {
    await setFeed(s.feed_a, [SKEPTIC]);
    const got = await claimMedia(sql, s.feed_a, 'audio', R);
    expect(got).toEqual({ user_id: s.user_a, corpus_id: s.workspace_a, posts: [SKEPTIC], claim: expect.any(String) });
    const row = await feedRow(s.feed_a);
    expect(row.audio_status).toBe('generating');
    expect(row.audio_claimed_at).not.toBeNull();
    expect(row.podcast_status).toBeNull();

    await setFeed(s.feed_b, [], { status: 'failed' });
    expect(await claimMedia(sql, s.feed_b, 'audio', R)).toBeDefined();
  });

  it('skips ready and a fresh generating claim', async () => {
    await setFeed(s.feed_a, [], { status: 'ready' });
    expect(await claimMedia(sql, s.feed_a, 'audio', R)).toBeUndefined();
    expect((await feedRow(s.feed_a)).audio_status).toBe('ready');
    for (const ago of [0, 5]) {
      await setFeed(s.feed_b, [], { status: 'generating', claimedAgoMin: ago });
      expect(await claimMedia(sql, s.feed_b, 'audio', R)).toBeUndefined();
    }
  });

  it.each([21, 30, 90])('takes a generating claim %i minutes old', async (ago) => {
    await setFeed(s.feed_a, [], { status: 'generating', claimedAgoMin: ago });
    expect(await claimMedia(sql, s.feed_a, 'audio', R)).toBeDefined();
    const row = await sql`SELECT audio_claimed_at > NOW() - interval '1 minute' AS fresh FROM feeds WHERE id = ${s.feed_a}`;
    expect(row[0]!.fresh).toBe(true);
  });

  it('takes a generating row with a NULL claim', async () => {
    await setFeed(s.feed_a, [], { status: 'generating' });
    expect(await claimMedia(sql, s.feed_a, 'audio', R)).toBeDefined();
  });

  it('the window follows the job time limit', async () => {
    await setFeed(s.feed_a, [], { status: 'generating', claimedAgoMin: 25 });
    await setFeed(s.feed_b, [], { status: 'generating', claimedAgoMin: 25 });
    expect(await claimMedia(sql, s.feed_a, 'audio', reclaimMinutes(600))).toBeDefined();
    const before = await feedRow(s.feed_b);
    expect(await claimMedia(sql, s.feed_b, 'audio', reclaimMinutes(1800))).toBeUndefined();
    const after = await feedRow(s.feed_b);
    expect(after.audio_status).toBe('generating');
    expect(after.audio_claimed_at).toEqual(before.audio_claimed_at);
  });

  it("the 'podcast' column claims podcast_status only", async () => {
    await setFeed(s.feed_a, [], { status: 'ready' });
    expect(await claimMedia(sql, s.feed_a, 'podcast', R)).toBeDefined();
    const row = await feedRow(s.feed_a);
    expect([row.audio_status, row.podcast_status]).toEqual(['ready', 'generating']);
    expect(row.podcast_claimed_at).not.toBeNull();
    expect(await claimMedia(sql, s.feed_a, 'podcast', R)).toBeUndefined();
  });

  it('a non-UUID id claims nothing', async () => {
    expect(await claimMedia(sql, 'not-a-uuid', 'audio', R)).toBeUndefined();
  });
});

describe('generate_audio_for_feed', () => {
  it('is registered as the generate_audio_for_feed handler', () => {
    expect(HANDLERS.generate_audio_for_feed).toBeTypeOf('function');
  });

  it('renders each speakable post to its own file on local storage', async () => {
    const posts = [
      SKEPTIC,
      { persona: 'methodologist', content: 'Removed.', deleted: true },
      { persona: 'hype', content: '  \n ' },
      { persona: 'my_persona', content: 'A custom voice.', thread_posts: ['Second part.'] },
    ];
    await setFeed(s.feed_a, posts);
    const h = harness();
    const out = await h.run(s.feed_a);
    expect(out).toEqual({ status: 'complete', rendered: 2, skipped: 2 });

    const row = await feedRow(s.feed_a);
    expect(row.audio_status).toBe('ready');
    expect(row.audio_generated_at).not.toBeNull();
    expect(row.posts[0].audio_key).toBe(`feeds/${s.feed_a}/audio/post_0.mp3`);
    expect(row.posts[3].audio_key).toBe(`feeds/${s.feed_a}/audio/post_3.mp3`);
    expect(row.posts[1].audio_key).toBeUndefined();
    expect(row.posts[2].audio_key).toBeUndefined();

    const calls = tts(h.calls);
    expect(calls.map(voiceOf)).toEqual([VOICE_MAP.skeptic, DEFAULT_VOICE]);
    expect(h.calls.every((c) => c.kind === 'elevenlabs-tts')).toBe(true);
    expect(calls.every((c) => c.apiKey === KEY && c.model === 'eleven_turbo_v2_5')).toBe(true);
    const name = (await loadPersonas(sql)).get('skeptic')!.name;
    expect(textOf(calls[0]!)).toBe(`${name} says: The effect held across cohorts.`);
    expect(textOf(calls[1]!)).toBe('My_Persona says: A custom voice.\n\nSecond part.');

    for (const [i, c] of [
      [0, calls[0]!],
      [3, calls[1]!],
    ] as const) {
      const path = join(dirs.mediaDir, 'feeds', s.feed_a, 'audio', `post_${i}.mp3`);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('ID3fake:' + JSON.stringify(c.body));
    }
    expect(logged(h.lines, 'feed_audio_complete')).toHaveLength(1);
  });

  it('skips a ready feed without any call', async () => {
    await setFeed(s.feed_a, [SKEPTIC], { status: 'ready' });
    const h = harness();
    expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'claimed_or_ready' });
    expect(h.calls).toEqual([]);
    expect(logged(h.lines, 'feed_audio_skipped_already_claimed_or_ready')).toHaveLength(1);
  });

  it('a 401 for the persona voice falls back to the default voice and leaves no audio_error', async () => {
    await setFeed(s.feed_a, [SKEPTIC]);
    const h = harness({ tts: (c) => (c.voiceId === VOICE_MAP.skeptic ? fail401() : new Uint8Array([1, 2])) });
    expect(await h.run(s.feed_a)).toEqual({ status: 'complete', rendered: 1, skipped: 0 });
    expect(tts(h.calls).map(voiceOf)).toEqual([VOICE_MAP.skeptic, DEFAULT_VOICE]);
    const row = await feedRow(s.feed_a);
    expect(row.posts[0].audio_key).toBe(`feeds/${s.feed_a}/audio/post_0.mp3`);
    expect(row.posts[0]).not.toHaveProperty('audio_error');
    expect(logged(h.lines, 'synthesis_voice_failed')).toHaveLength(1);
    expect(logged(h.lines, 'synthesis_fallback_ok')).toHaveLength(1);
  });

  it('a 401 for both voices records the fallback stage and the job still ends ready', async () => {
    await setFeed(s.feed_a, [SKEPTIC]);
    const h = harness({ tts: fail401 });
    expect(await h.run(s.feed_a)).toEqual({ status: 'complete', rendered: 0, skipped: 1 });
    const row = await feedRow(s.feed_a);
    expect(row.audio_status).toBe('ready');
    expect(row.posts[0].audio_error).toBe('fallback_HttpStatusError: HTTP 401: nope body=nope');
    expect(row.posts[0].audio_key).toBeUndefined();
    expect(logged(h.lines, 'synthesis_fallback_failed')).toHaveLength(1);
  });

  it('a 401 for the default voice itself does not retry it', async () => {
    await setFeed(s.feed_a, [{ persona: 'my_persona', content: 'Custom.' }]);
    const h = harness({ tts: fail401 });
    expect(await h.run(s.feed_a)).toEqual({ status: 'complete', rendered: 0, skipped: 1 });
    expect(tts(h.calls)).toHaveLength(1);
    expect((await feedRow(s.feed_a)).posts[0].audio_error).toBe(`http_401_voice_${DEFAULT_VOICE}: nope`);
  });

  it('a non-HTTP fallback failure records its class and an empty body', async () => {
    await setFeed(s.feed_a, [SKEPTIC]);
    const h = harness({
      tts: (c) => {
        if (c.voiceId === VOICE_MAP.skeptic) return fail401();
        throw new Error('socket closed');
      },
    });
    expect(await h.run(s.feed_a)).toEqual({ status: 'complete', rendered: 0, skipped: 1 });
    const err = (await feedRow(s.feed_a)).posts[0].audio_error as string;
    expect(err).toBe('fallback_NetworkError: network error: socket closed body=');
    expect(err.startsWith('fallback_NetworkError: network error: ')).toBe(true);
    expect(err.endsWith(' body=')).toBe(true);
  });

  it('a rejected fetch records exception_NetworkError', async () => {
    await setFeed(s.feed_a, [SKEPTIC]);
    const h = harness({
      fetch: (async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
    });
    expect(await h.run(s.feed_a)).toEqual({ status: 'complete', rendered: 0, skipped: 1 });
    expect((await feedRow(s.feed_a)).posts[0].audio_error).toBe(
      'exception_NetworkError: network error: connection refused',
    );
    expect(logged(h.lines, 'synthesis_error')).toHaveLength(1);
  });

  it('caps a recorded detail at 300 code points', async () => {
    await setFeed(s.feed_a, [{ persona: 'my_persona', content: 'Custom.' }]);
    const body = '\u{1F600}'.repeat(400);
    const h = harness({ tts: () => new Response(body, { status: 500 }) });
    await h.run(s.feed_a);
    expect((await feedRow(s.feed_a)).posts[0].audio_error).toBe(
      `http_500_voice_${DEFAULT_VOICE}: ${'\u{1F600}'.repeat(300)}`,
    );
  });

  it("a non-list posts fails the feed with 'feed posts is not a list'", async () => {
    await setFeed(s.feed_a, {});
    const h = harness();
    await expect(h.run(s.feed_a)).rejects.toThrow('feed posts is not a list');
    expect((await feedRow(s.feed_a)).audio_status).toBe('failed');
    expect(h.calls).toEqual([]);
    expect(logged(h.lines, 'feed_audio_failed')).toHaveLength(1);
  });

  it('a non-object item fails the feed as Python did', async () => {
    await setFeed(s.feed_a, ['x']);
    const h = harness();
    await expect(h.run(s.feed_a)).rejects.toThrow("'str' object has no attribute 'get'");
    expect((await feedRow(s.feed_a)).audio_status).toBe('failed');
    expect(h.calls).toEqual([]);
  });

  it('posts before a null item stay rendered and keyed, then the feed fails', async () => {
    await setFeed(s.feed_a, [SKEPTIC, null]);
    const h = harness();
    await expect(h.run(s.feed_a)).rejects.toThrow("'NoneType' object has no attribute 'get'");
    const row = await feedRow(s.feed_a);
    expect(row.audio_status).toBe('failed');
    expect(row.posts[0].audio_key).toBe(`feeds/${s.feed_a}/audio/post_0.mp3`);
    expect(tts(h.calls)).toHaveLength(1);
  });

  it("a post whose persona is false speaks with no '... says: ' prefix in the default voice", async () => {
    await setFeed(s.feed_a, [{ persona: false, content: 'Plain words.' }]);
    const h = harness();
    expect(await h.run(s.feed_a)).toEqual({ status: 'complete', rendered: 1, skipped: 0 });
    const [c] = tts(h.calls);
    expect(textOf(c!)).toBe('Plain words.');
    expect(voiceOf(c!)).toBe(DEFAULT_VOICE);
  });

  it('an empty key fails the whole feed', async () => {
    await setFeed(s.feed_a, [SKEPTIC]);
    const h = harness({ config: { ...config, elevenlabsApiKey: '  ' } });
    await expect(h.run(s.feed_a)).rejects.toThrow('ELEVENLABS_API_KEY is not set');
    const row = await feedRow(s.feed_a);
    expect(row.audio_status).toBe('failed');
    expect(row.posts[0]).not.toHaveProperty('audio_error');
    expect(h.calls).toEqual([]);
  });

  it('a failed save records upload_Error and the job ends ready', async () => {
    await setFeed(s.feed_a, [SKEPTIC]);
    const h = harness({ storage: new FailingStorage(dirs, Buffer.from('k'.repeat(32))) });
    expect(await h.run(s.feed_a)).toEqual({ status: 'complete', rendered: 0, skipped: 1 });
    const row = await feedRow(s.feed_a);
    expect(row.audio_status).toBe('ready');
    expect(row.posts[0].audio_error).toBe('upload_Error: disk full');
    expect(logged(h.lines, 'post_audio_upload_failed')).toHaveLength(1);
  });

  it('a later render clears an earlier audio_error', async () => {
    await setFeed(s.feed_a, [{ ...SKEPTIC, audio_error: 'upload_Error: old' }], { status: 'failed' });
    await harness().run(s.feed_a);
    const row = await feedRow(s.feed_a);
    expect(row.posts[0]).not.toHaveProperty('audio_error');
    expect(row.posts[0].audio_key).toBe(`feeds/${s.feed_a}/audio/post_0.mp3`);
  });

  describe('deliberate change 18: the job stops once it no longer owns the feed', () => {
    const FOUR = [SKEPTIC, { persona: 'hype', content: 'Two.' }, { persona: 'hype', content: 'Three.' }, SKEPTIC];
    const feedDir = (id: string) => join(dirs.mediaDir, 'feeds', id);

    it('a feed deleted during a render gets no further render and no media directory', async () => {
      await setFeed(s.feed_a, FOUR);
      const h = harness({
        tts: async (_c, n) => {
          // What every delete path does: the row, then its media directory.
          if (n === 2) {
            await sql`DELETE FROM feeds WHERE id = ${s.feed_a}`;
            await storage.deleteFeedMedia(s.feed_a);
          }
          return new Uint8Array([1]);
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'feed_deleted' });
      expect(tts(h.calls)).toHaveLength(2);
      expect(existsSync(feedDir(s.feed_a))).toBe(false);
      expect(logged(h.lines, 'feed_audio_feed_deleted')).toHaveLength(1);
      expect(logged(h.lines, 'feed_audio_failed')).toHaveLength(0);
      // The key write for post 1 matched no row, so post 1 never counts as rendered.
      expect(logged(h.lines, 'post_rendered').map((l) => l.post_index)).toEqual([0]);
    });

    it('a feed deleted during the last render, which failed, never ends ready', async () => {
      await setFeed(s.feed_a, [{ persona: 'my_persona', content: 'Custom.' }]);
      const h = harness({
        tts: async () => {
          await sql`DELETE FROM feeds WHERE id = ${s.feed_a}`;
          return fail401();
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'feed_deleted' });
      expect(logged(h.lines, 'feed_audio_complete')).toHaveLength(0);
    });

    it('a feed deleted during a failed render is noticed before the next paid call', async () => {
      // A failed render writes no key, so only the check before each render can see the delete.
      await setFeed(s.feed_a, [{ persona: 'my_persona', content: 'Custom.' }, SKEPTIC, SKEPTIC]);
      const h = harness({
        tts: async (_c, n) => {
          if (n === 1) await sql`DELETE FROM feeds WHERE id = ${s.feed_a}`;
          return fail401();
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'feed_deleted' });
      expect(tts(h.calls)).toHaveLength(1);
      expect(logged(h.lines, 'feed_audio_feed_deleted')).toHaveLength(1);
    });

    it('a claim taken over mid-job stops this job and leaves the row and files to the new owner', async () => {
      await setFeed(s.feed_a, FOUR);
      const h = harness({
        tts: async (_c, n) => {
          if (n === 2) await sql`UPDATE feeds SET audio_claimed_at = NOW() + interval '1 second' WHERE id = ${s.feed_a}`;
          return new Uint8Array([1]);
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'claim_lost' });
      expect(tts(h.calls)).toHaveLength(2);
      const row = await feedRow(s.feed_a);
      expect(row.audio_status).toBe('generating');
      expect(row.posts[0].audio_key).toBe(`feeds/${s.feed_a}/audio/post_0.mp3`);
      expect(row.posts[1].audio_key).toBeUndefined();
      expect(existsSync(join(feedDir(s.feed_a), 'audio', 'post_0.mp3'))).toBe(true);
      expect(logged(h.lines, 'feed_audio_claim_lost')).toHaveLength(1);
    });

    it('a job that fails after its claim was reset does not overwrite the new state with failed', async () => {
      await setFeed(s.feed_a, [SKEPTIC]);
      const controller = new AbortController();
      const h = harness({
        controller,
        tts: async () => {
          await sql`UPDATE feeds SET audio_status = NULL, audio_claimed_at = NULL WHERE id = ${s.feed_a}`;
          controller.abort();
          return new Promise<Uint8Array>(() => {});
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      expect((await feedRow(s.feed_a)).audio_status).toBeNull();
      expect(logged(h.lines, 'feed_audio_failed')).toHaveLength(1);
    });
  });

  describe('the job abort (deliberate change 16)', () => {
    it('reaches the first ElevenLabs call', async () => {
      await setFeed(s.feed_a, [SKEPTIC]);
      const controller = new AbortController();
      const h = harness({
        controller,
        tts: () => {
          setTimeout(() => controller.abort(), 5);
          return new Promise<Uint8Array>(() => {});
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      const row = await feedRow(s.feed_a);
      expect(row.audio_status).toBe('failed');
      expect(row.posts[0]).not.toHaveProperty('audio_error');
      expect(logged(h.lines, 'synthesis_error')).toHaveLength(0);
    });

    it('reaches the default-voice fallback call', async () => {
      await setFeed(s.feed_a, [SKEPTIC]);
      const controller = new AbortController();
      const h = harness({
        controller,
        tts: (c) => {
          if (c.voiceId === VOICE_MAP.skeptic) return fail401();
          setTimeout(() => controller.abort(), 5);
          return new Promise<Uint8Array>(() => {});
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      expect(tts(h.calls).map(voiceOf)).toEqual([VOICE_MAP.skeptic, DEFAULT_VOICE]);
      const row = await feedRow(s.feed_a);
      expect(row.audio_status).toBe('failed');
      // The 401 breadcrumb was a real per-post failure; the abort adds no fallback stage.
      expect(row.posts[0].audio_error).toBe(`http_401_voice_${VOICE_MAP.skeptic}: nope`);
      expect(logged(h.lines, 'synthesis_fallback_failed')).toHaveLength(0);
    });

    it('an abort inside the last post never ends ready and leaves no AbortError breadcrumb', async () => {
      await setFeed(s.feed_a, [SKEPTIC, { persona: 'hype', content: 'Last one.' }]);
      const controller = new AbortController();
      const h = harness({
        controller,
        tts: (_c, n) => {
          if (n === 2) controller.abort();
          return new Uint8Array([1]);
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      const row = await feedRow(s.feed_a);
      expect(row.audio_status).toBe('failed');
      expect(row.posts[0].audio_key).toBe(`feeds/${s.feed_a}/audio/post_0.mp3`);
      expect(row.posts[1]).not.toHaveProperty('audio_error');
      expect(row.posts[1].audio_key).toBeUndefined();
      expect(JSON.stringify(row.posts)).not.toContain('AbortError');
    });

    it('an abort between posts stops before the next one', async () => {
      await setFeed(s.feed_a, [SKEPTIC, { persona: 'hype', content: 'Never spoken.' }]);
      const controller = new AbortController();
      const h = harness({
        controller,
        onLog: (l) => {
          if (l.msg === 'post_rendered') controller.abort();
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      const row = await feedRow(s.feed_a);
      expect(row.audio_status).toBe('failed');
      expect(row.posts[0].audio_key).toBe(`feeds/${s.feed_a}/audio/post_0.mp3`);
      expect(row.posts[1].audio_key).toBeUndefined();
      expect(tts(h.calls)).toHaveLength(1);
    });

    it('an abort after the last post rendered still ends failed, not ready', async () => {
      await setFeed(s.feed_a, [SKEPTIC, { persona: 'hype', content: 'Last one.' }]);
      const controller = new AbortController();
      const h = harness({
        controller,
        onLog: (l) => {
          if (l.msg === 'post_rendered' && l.post_index === 1) controller.abort();
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      const row = await feedRow(s.feed_a);
      expect(row.audio_status).toBe('failed');
      expect(row.audio_generated_at).toBeNull();
      expect(row.posts.map((p: Row) => p.audio_key)).toEqual([0, 1].map((i) => `feeds/${s.feed_a}/audio/post_${i}.mp3`));
    });

    it('an abort during the save is not an upload failure', async () => {
      await setFeed(s.feed_a, [SKEPTIC]);
      const controller = new AbortController();
      class AbortingStorage extends LocalStorage {
        override async saveAudio(): Promise<string> {
          controller.abort();
          throw new Error('interrupted');
        }
      }
      const h = harness({ controller, storage: new AbortingStorage(dirs, Buffer.from('k'.repeat(32))) });
      await expect(h.run(s.feed_a)).rejects.toThrow('interrupted');
      const row = await feedRow(s.feed_a);
      expect(row.audio_status).toBe('failed');
      expect(row.posts[0]).not.toHaveProperty('audio_error');
    });
  });
});
