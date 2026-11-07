import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { fallbackScript } from '../../src/audio/podcast.js';
import { loadConfig, type Config } from '../../src/config.js';
import { loadPersonas } from '../../src/feed/personas.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { providerConfig } from '../../src/providers/config.js';
import { embedModelId } from '../../src/providers/embed.js';
import { voiceIdFor } from '../../src/providers/speak.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import { pyLen } from '../../src/shared/pystr.js';
import { LocalStorage } from '../../src/storage/local.js';
import { generatePodcastForFeed } from '../../src/tasks/audio.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, fakeVector, type ChatInfo, type FakeCall, type TtsCall } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

// Plan 05 Task 7: generate_podcast_for_feed against the DB with fake providers and a real LocalStorage on the test
// media dir. Ports worker/tests/test_podcast_settings.py (the owner's settings drive the script call) and pins the
// audio quality bar (one text-to-dialogue call, one episode file, never split), deliberate changes 6 (local storage
// works), 14 (embed-model scope) and 17a/b (settings failure, NULL owner; 17a is in podcast-settings-failure.test.ts).

const sql = testSql();
const dirs = testStorageDirs();
const KEY = 'test-eleven-key';
const config = loadConfig({
  OLLAMA_BASE_URL: 'http://fake-ollama:11434',
  ELEVENLABS_API_KEY: KEY,
  UPLOAD_DIR: dirs.uploadDir,
  FIGURES_DIR: dirs.figuresDir,
  MEDIA_DIR: dirs.mediaDir,
});
const storage = new LocalStorage(dirs, Buffer.from('k'.repeat(32)));
const MODEL = embedModelId(providerConfig({}, {}, config));

type Line = Record<string, unknown> & { msg?: string };
type Row = Record<string, any>;
let s: Seeded;
let paper: string;

async function addPaper(userId: string, title: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, title, authors, year, filename, file_path, status)
    VALUES (${id}, ${userId}, ${title}, ${['Ada Alpha']}, 2024, ${`${id}.pdf`}, ${`/papers/${id}.pdf`}, 'complete')`;
  return id;
}

async function addChunks(paperId: string, userId: string, n: number, model = MODEL) {
  const contents = Array.from({ length: n }, (_, i) => `Finding ${i}: the effect held across synthetic cohorts.`);
  const vecs = contents.map((c) => `[${fakeVector(c, 1024).join(',')}]`);
  await sql`
    INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count, embedding, metadata)
    SELECT ${paperId}::uuid, ${userId}::uuid, 'results', t.c, (t.i - 1)::int, 12, t.v::vector,
           ${sql.json({ embed_model: model })}
    FROM unnest(${contents}::text[], ${vecs}::text[]) WITH ORDINALITY AS t(c, v, i)`;
}

async function setSettings(userId: string, settings: Record<string, unknown>) {
  await sql`
    INSERT INTO user_settings (user_id, settings) VALUES (${userId}, ${sql.json(settings as never)})
    ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`;
}

async function setFeed(
  id: string,
  posts: unknown,
  podcast: { status?: string | null; claimedAgoMin?: number | null } = {},
) {
  await sql`
    UPDATE feeds SET posts = ${sql.json(posts as never)}, podcast_status = ${podcast.status ?? null},
      podcast_claimed_at = CASE WHEN ${podcast.claimedAgoMin ?? null}::int IS NULL THEN NULL
                                ELSE NOW() - make_interval(mins => ${podcast.claimedAgoMin ?? 0}::int) END
    WHERE id = ${id}`;
}
const feedRow = async (id: string) => (await sql`SELECT * FROM feeds WHERE id = ${id}`)[0] as Row;
const podcastDir = (feedId: string) => join(dirs.mediaDir, 'feeds', feedId, 'podcast');
const episodePath = (feedId: string) => join(podcastDir(feedId), 'episode.mp3');

const post = (persona: unknown, content: string, papers: string[] = []) => ({
  persona,
  post_type: 'post',
  content,
  sources: papers.map((paper_id) => ({ paper_id })),
});

const turns = (n: number, len = 0) =>
  JSON.stringify({
    segments: Array.from({ length: n }, (_, i) => ({
      speaker: i % 2 === 0 ? 'host_a' : 'host_b',
      text: len ? String(i % 10).repeat(len) : `Turn ${i}: a short synthetic line.`,
    })),
  });

type HarnessOpts = {
  chat?: (info: ChatInfo) => string | Promise<string>;
  tts?: (call: TtsCall) => Uint8Array | Response | Promise<Uint8Array | Response>;
  controller?: AbortController;
  config?: Config;
  delayMs?: number;
};

function harness(o: HarnessOpts = {}) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x) as Line) });
  const infos: ChatInfo[] = [];
  const f = fakeProviders({
    chat: (_b, info) => {
      infos.push(info);
      return o.chat ? o.chat(info) : turns(6);
    },
    ...(o.tts ? { tts: o.tts } : {}),
    ...(o.delayMs ? { delayMs: o.delayMs } : {}),
  });
  const ctx = makeJobContext(
    {
      id: randomUUID(),
      name: 'generate_podcast_for_feed',
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
    storage,
    queue: testQueue(),
    providers: f.deps,
    rng: () => 0.5,
  };
  return {
    lines,
    infos,
    calls: f.calls,
    run: (feedId: string) => generatePodcastForFeed({ feed_id: feedId }, ctx, deps) as Promise<Record<string, any>>,
  };
}
const logged = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg);
const eleven = (calls: FakeCall[]) => calls.filter((c) => c.kind.startsWith('elevenlabs'));
const dialogue = (calls: FakeCall[]) => calls.filter((c) => c.kind === 'elevenlabs-dialogue');
type Inputs = Array<{ text: string; voice_id: string }>;
const inputsOf = (c: FakeCall) => (c.body as { inputs: Inputs }).inputs;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  paper = await addPaper(s.user_a, 'Synthetic Seminars');
  await addChunks(paper, s.user_a, 4);
});

describe('generate_podcast_for_feed', () => {
  it('is registered', () => {
    expect(HANDLERS.generate_podcast_for_feed).toBeTypeOf('function');
  });

  it('renders ONE dialogue call into ONE episode file (the audio quality bar)', async () => {
    await setSettings(s.user_a, { ollama_llm_model: 'owner-llm:1' });
    await setFeed(s.feed_a, [post('skeptic', 'The effect looks fragile.', [paper])]);
    const h = harness();
    const result = await h.run(s.feed_a);

    expect(eleven(h.calls).map((c) => c.kind)).toEqual(['elevenlabs-dialogue']);
    const [call] = dialogue(h.calls);
    expect(call!.apiKey).toBe(KEY);
    const inputs = inputsOf(call!);
    expect(inputs).toHaveLength(6);
    expect(inputs.map((i) => i.voice_id)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => voiceIdFor(i % 2 === 0 ? 'host_a' : 'host_b')),
    );
    expect(voiceIdFor('host_a')).not.toBe(voiceIdFor('host_b'));

    expect(readdirSync(podcastDir(s.feed_a))).toEqual(['episode.mp3']);
    const bytes = readFileSync(episodePath(s.feed_a));
    expect(bytes.toString('utf8')).toBe('ID3fake:' + JSON.stringify(call!.body));
    expect(result).toEqual({ status: 'complete', segments: 6, bytes: bytes.byteLength });

    const row = await feedRow(s.feed_a);
    expect(row.podcast_status).toBe('ready');
    expect(row.podcast_generated_at).not.toBeNull();
    expect(row.audio_status).toBeNull();
    expect(row.podcast_segments).toEqual(
      inputs.map((inp, index) => ({
        index,
        speaker: index % 2 === 0 ? 'host_a' : 'host_b',
        text: inp.text,
        voice_id: inp.voice_id,
      })),
    );

    // The script call is the owner's (test_podcast_settings.py) and grounded in the paper's chunks.
    expect(h.infos.map((i) => i.purpose)).toEqual(['podcast']);
    expect(h.calls.find((c) => c.kind === 'ollama-chat')!.model).toBe('owner-llm:1');
    expect(h.infos[0]!.user).toContain('covering these papers: Synthetic Seminars.');
    expect(h.infos[0]!.user).toContain('Finding 0: the effect held across synthetic cohorts.');
    expect(logged(h.lines, 'podcast_dialogue_start')[0]).toMatchObject({
      segments: 6,
      total_chars: inputs.reduce((n, i) => n + pyLen(i.text), 0),
    });
    expect(logged(h.lines, 'feed_podcast_complete')).toHaveLength(1);
  });

  it('trims a long script to the producer cap and still makes exactly one call (Review Focus 1)', async () => {
    await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
    const h = harness({ chat: () => turns(12, 300) });
    await h.run(s.feed_a);

    expect(eleven(h.calls)).toHaveLength(1);
    const inputs = inputsOf(dialogue(h.calls)[0]!);
    expect(inputs).toHaveLength(5);
    expect(inputs.reduce((n, i) => n + pyLen(i.text), 0)).toBe(1500);
    expect(readdirSync(podcastDir(s.feed_a))).toEqual(['episode.mp3']);
    expect(logged(h.lines, 'podcast_script_fallback')).toHaveLength(0);
  });

  it('fails over the dialogue cap without any ElevenLabs call (Review Focus 1)', async () => {
    const longKey = 'x'.repeat(2100);
    await setFeed(s.feed_a, [post(longKey, 'A custom persona with a very long key.', [paper])]);
    const h = harness({ chat: () => '' });
    await expect(h.run(s.feed_a)).rejects.toThrow(/^dialogue exceeds 2000-char cap: \d+$/);

    expect(eleven(h.calls)).toHaveLength(0);
    expect(logged(h.lines, 'podcast_dialogue_too_long')).toHaveLength(1);
    const row = await feedRow(s.feed_a);
    expect(row.podcast_status).toBe('failed');
    expect(row.podcast_segments.length).toBeGreaterThanOrEqual(2);
    expect(row.podcast_segments[0].text).toContain(`X${'x'.repeat(2099)}`);
    expect(existsSync(podcastDir(s.feed_a))).toBe(false);
  });

  it('a dialogue 500 ends failed with the transcript kept and no episode file', async () => {
    await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
    const h = harness({ tts: () => new Response('upstream broke', { status: 500 }) });
    await expect(h.run(s.feed_a)).rejects.toThrow('HTTP 500');

    expect(eleven(h.calls)).toHaveLength(1);
    expect(logged(h.lines, 'podcast_dialogue_http_error')[0]).toMatchObject({
      status_code: 500,
      body: 'upstream broke',
    });
    const row = await feedRow(s.feed_a);
    expect(row.podcast_status).toBe('failed');
    expect(row.podcast_segments).toHaveLength(6);
    expect(existsSync(episodePath(s.feed_a))).toBe(false);
  });

  it('skips a ready podcast and a fresh claim without any call', async () => {
    await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])], { status: 'ready' });
    await setFeed(s.feed_b, [], { status: 'generating', claimedAgoMin: 5 });
    for (const id of [s.feed_a, s.feed_b, 'not-a-uuid']) {
      const h = harness();
      expect(await h.run(id)).toEqual({ status: 'skipped', reason: 'claimed_or_ready' });
      expect(logged(h.lines, 'feed_podcast_skipped_already_claimed_or_ready')).toHaveLength(1);
      expect(h.calls).toHaveLength(0);
    }
    expect((await feedRow(s.feed_a)).podcast_status).toBe('ready');
    expect((await feedRow(s.feed_b)).podcast_status).toBe('generating');
  });

  it('takes over a stale generating claim', async () => {
    await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])], { status: 'generating', claimedAgoMin: 90 });
    const h = harness();
    expect((await h.run(s.feed_a)).status).toBe('complete');
    expect((await feedRow(s.feed_a)).podcast_status).toBe('ready');
  });

  it('takes over a generating row with a NULL claim (a row from before the claim existed)', async () => {
    await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])], { status: 'generating' });
    const h = harness();
    expect((await h.run(s.feed_a)).status).toBe('complete');
    expect(dialogue(h.calls)).toHaveLength(1);
    const row = await feedRow(s.feed_a);
    expect(row.podcast_status).toBe('ready');
    expect(row.podcast_claimed_at).not.toBeNull();
    expect(logged(h.lines, 'feed_podcast_skipped_already_claimed_or_ready')).toHaveLength(0);
  });

  describe('deliberate change 18: the job stops once it no longer owns the feed', () => {
    it('a feed deleted while the script is written gets no dialogue call', async () => {
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      const h = harness({
        chat: async () => {
          await sql`DELETE FROM feeds WHERE id = ${s.feed_a}`;
          return turns(6);
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'feed_deleted' });
      expect(eleven(h.calls)).toHaveLength(0);
      expect(existsSync(join(dirs.mediaDir, 'feeds', s.feed_a))).toBe(false);
      expect(logged(h.lines, 'feed_podcast_feed_deleted')).toHaveLength(1);
      expect(logged(h.lines, 'feed_podcast_failed')).toHaveLength(0);
    });

    it('a feed deleted during the dialogue render saves no episode and leaves no media directory', async () => {
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      const h = harness({
        tts: async () => {
          await sql`DELETE FROM feeds WHERE id = ${s.feed_a}`;
          await storage.deleteFeedMedia(s.feed_a);
          return new Uint8Array([1, 2, 3]);
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'feed_deleted' });
      expect(dialogue(h.calls)).toHaveLength(1);
      expect(existsSync(join(dirs.mediaDir, 'feeds', s.feed_a))).toBe(false);
    });

    it('a claim taken over during the dialogue render writes no episode file', async () => {
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      const h = harness({
        tts: async () => {
          await sql`UPDATE feeds SET podcast_status = NULL, podcast_claimed_at = NULL WHERE id = ${s.feed_a}`;
          return new Uint8Array([1, 2, 3]);
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'claim_lost' });
      expect(existsSync(episodePath(s.feed_a))).toBe(false);
      expect((await feedRow(s.feed_a)).podcast_status).toBeNull();
    });

    it('a claim taken over while the script is written stops before the render and keeps the new state', async () => {
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      const h = harness({
        chat: async () => {
          await sql`UPDATE feeds SET podcast_status = NULL, podcast_claimed_at = NULL WHERE id = ${s.feed_a}`;
          return turns(6);
        },
      });
      expect(await h.run(s.feed_a)).toEqual({ status: 'skipped', reason: 'claim_lost' });
      expect(eleven(h.calls)).toHaveLength(0);
      const row = await feedRow(s.feed_a);
      expect(row.podcast_status).toBeNull();
      expect(row.podcast_segments).toBeNull();
      expect(logged(h.lines, 'feed_podcast_claim_lost')).toHaveLength(1);
    });
  });

  it('an empty ElevenLabs key ends failed', async () => {
    await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
    const h = harness({ config: { ...config, elevenlabsApiKey: '  ' } });
    await expect(h.run(s.feed_a)).rejects.toThrow('ELEVENLABS_API_KEY is not set');
    expect(eleven(h.calls)).toHaveLength(0);
    const row = await feedRow(s.feed_a);
    expect(row.podcast_status).toBe('failed');
    expect(row.podcast_segments).toHaveLength(6);
  });

  describe('deliberate change 17', () => {
    it('a NULL owner reads the stub user settings', async () => {
      await sql`INSERT INTO users (id, email) VALUES (${STUB_USER_ID}, 'stub@ficino.dev') ON CONFLICT (id) DO NOTHING`;
      await setSettings(STUB_USER_ID, { ollama_llm_model: 'stub-llm:1' });
      await setSettings(s.user_a, { ollama_llm_model: 'owner-llm:1' });
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      await sql`UPDATE feeds SET user_id = NULL WHERE id = ${s.feed_a}`;
      const h = harness();
      expect((await h.run(s.feed_a)).status).toBe('complete');
      expect(h.calls.filter((c) => c.kind === 'ollama-chat').map((c) => c.model)).toEqual(['stub-llm:1']);
      expect((await feedRow(s.feed_a)).podcast_status).toBe('ready');
    });

    it('a non-list posts is coerced to [] and renders the fallback script', async () => {
      await setFeed(s.feed_a, {});
      const h = harness({ chat: () => '' });
      expect((await h.run(s.feed_a)).status).toBe('complete');
      const expected = fallbackScript([], await loadPersonas(sql), [], []);
      expect(inputsOf(dialogue(h.calls)[0]!).map((i) => i.text)).toEqual(expected.map((x) => x.text));
      expect(logged(h.lines, 'podcast_script_start')[0]).toMatchObject({ n_posts: 0, n_paper_ids: 0 });
      expect(logged(h.lines, 'podcast_script_fallback')).toHaveLength(1);
    });
  });

  describe('deliberate change 14: embed-model scope', () => {
    it('fails before any LLM or ElevenLabs spend when every in-scope chunk uses another model', async () => {
      const other = await addPaper(s.user_a, 'Other Model');
      await addChunks(other, s.user_a, 3, 'some-other-embedder');
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [other])]);
      const h = harness();
      await expect(h.run(s.feed_a)).rejects.toThrow(`No chunks embedded with ${MODEL}: 3 chunks in scope`);
      expect(h.calls).toHaveLength(0);
      expect((await feedRow(s.feed_a)).podcast_status).toBe('failed');
    });

    it('a partial mismatch logs embed_model_mismatch and renders', async () => {
      const other = await addPaper(s.user_a, 'Other Model');
      await addChunks(other, s.user_a, 2, 'some-other-embedder');
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper, other, 'not-a-uuid'])]);
      const h = harness();
      expect((await h.run(s.feed_a)).status).toBe('complete');
      expect(logged(h.lines, 'embed_model_mismatch')[0]).toMatchObject({ expected: MODEL, excluded_chunks: 2 });
      // The scope check skips the non-UUID id; retrieval and titles cast it and fail soft, as in Python.
      expect(logged(h.lines, 'podcast_retrieval_failed')).toHaveLength(1);
      expect(logged(h.lines, 'podcast_paper_titles_failed')).toHaveLength(1);
      expect(dialogue(h.calls)).toHaveLength(1);
    });
  });

  describe('the job abort', () => {
    it('during the script call ends failed with no fallback and no ElevenLabs call', async () => {
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      const controller = new AbortController();
      const h = harness({
        controller,
        chat: () => {
          setTimeout(() => controller.abort(), 5);
          return new Promise<string>(() => {});
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      expect(eleven(h.calls)).toHaveLength(0);
      expect(logged(h.lines, 'podcast_llm_failed')).toHaveLength(0);
      expect(logged(h.lines, 'podcast_script_fallback')).toHaveLength(0);
      const row = await feedRow(s.feed_a);
      expect(row.podcast_status).toBe('failed');
      expect(row.podcast_segments).toBeNull();
    });

    it('during retrieval ends failed with no soft-fail log and no LLM or ElevenLabs call', async () => {
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      const controller = new AbortController();
      // Every fake provider call waits 60 s (abortably); the first one is retrieval's embed.
      const h = harness({ controller, delayMs: 60_000 });
      setTimeout(() => controller.abort(), 20);
      await expect(h.run(s.feed_a)).rejects.toThrow();
      expect(h.calls.map((c) => c.kind)).toEqual(['ollama-embed']);
      expect(logged(h.lines, 'podcast_retrieval_failed')).toHaveLength(0);
      expect(logged(h.lines, 'podcast_paper_titles_failed')).toHaveLength(0);
      expect((await feedRow(s.feed_a)).podcast_status).toBe('failed');
    });

    it('reaches the dialogue call', async () => {
      await setFeed(s.feed_a, [post('skeptic', 'A take.', [paper])]);
      const controller = new AbortController();
      const h = harness({
        controller,
        tts: () => {
          setTimeout(() => controller.abort(), 5);
          return new Promise<Uint8Array>(() => {});
        },
      });
      await expect(h.run(s.feed_a)).rejects.toThrow();
      expect(dialogue(h.calls)).toHaveLength(1);
      expect((await feedRow(s.feed_a)).podcast_status).toBe('failed');
      expect(existsSync(episodePath(s.feed_a))).toBe(false);
    });
  });
});
