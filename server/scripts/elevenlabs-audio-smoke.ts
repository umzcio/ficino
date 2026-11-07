/**
 * Manual smoke test (not in CI). NEEDS A LOCAL OLLAMA at OLLAMA_BASE_URL (default http://127.0.0.1:11434) with the
 * default chat model (qwen3.8:27b) and embedding model (qwen3-embedding:latest) pulled. It makes real model calls and,
 * with a key, real (paid) ElevenLabs calls.
 *
 * What it does: starts a throwaway pgvector container published on 127.0.0.1 only (random port, removed on exit),
 * migrates it, boots the real worker and the API in this process (no listener: requests go through app.request),
 * ingests test/fixtures/sample.pdf twice, creates a reading list, waits for the ordering (prints each rationale's first
 * 120 characters, or the fallback), and generates chapter 0 with posts_per_generation 2. Then:
 *   - without ELEVENLABS_API_KEY it prints "SMOKE audio skipped (no ELEVENLABS_API_KEY)" and stops;
 *   - with a key it renders the podcast on the chapter feed (exactly one text-to-dialogue call, asserted);
 *   - only when SMOKE_FEED_AUDIO=1 is also set, it renders feed audio (one text-to-speech clip per post, the per-clip
 *     path that awaits the owner's decision) after the podcast. Without it no per-clip render happens.
 * It prints each step's status and time, the rendered/skipped counts, the podcast's segment count and total code
 * points, the byte sizes, whether a `Range: bytes=0-1` read returns 206, and every ElevenLabs response's endpoint,
 * voice id and HTTP status (the first 400 characters of the body on a non-2xx; never a request header). The mp3 files
 * are copied to SMOKE_OUT (default: a fresh temp directory, printed) so they can be listened to. It never prints,
 * logs or writes the key. It opens no port.
 *
 * Cost: planFeedPosts always plans three openers from distinct personas (W 9.11), so the chapter holds up to 3 posts.
 * By default one dialogue render of at most 2000 characters; with SMOKE_FEED_AUDIO=1 add up to 3 short TTS renders
 * (6 if the default-voice fallback fires for each).
 *
 * Usage (from server/; SCRATCH: any directory outside the repo):
 *   ELEVENLABS_API_KEY=… LOG_LEVEL=info npx tsx scripts/elevenlabs-audio-smoke.ts > "$SCRATCH/audio-smoke.log"
 * Lines starting with "SMOKE" are the summary.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { ensureStubUser } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createSql } from '../src/db/sql.js';
import { createBoss, ensureQueues, JobQueue } from '../src/jobs/queue.js';
import { logger } from '../src/logger.js';
import { DEFAULT_VOICE, VOICE_MAP } from '../src/providers/speak.js';
import { STUB_USER_ID } from '../src/shared/constants.js';
import { resolveSigningKey } from '../src/shared/signedUrl.js';
import { LocalStorage } from '../src/storage/local.js';
import { startWorker } from '../src/worker/main.js';
import { ownerLabelArgs } from '../test/helpers/sweep.js';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const say = (...a: unknown[]) => console.log('SMOKE', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cut = (s: unknown, n: number) => Array.from(String(s ?? '')).slice(0, n).join('');
const head = (s: unknown, n = 200) => JSON.stringify(cut(s, n));
const secs = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

const ollama = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const elevenKey = process.env.ELEVENLABS_API_KEY ?? '';
const feedAudio = process.env.SMOKE_FEED_AUDIO === '1';
const name = `ficino-ts-smoke-${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ficino-smoke-'));
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;

// ElevenLabs bookkeeping: calls per endpoint, and every status each voice answered.
const VOICE_NAMES = new Map<string, string>([[DEFAULT_VOICE, 'DEFAULT_VOICE']]);
for (const [key, id] of Object.entries(VOICE_MAP)) VOICE_NAMES.set(id, VOICE_NAMES.has(id) ? `${VOICE_NAMES.get(id)}/${key}` : key);
const endpointCalls = new Map<string, number>();
const voiceStatuses = new Map<string, number[]>();

/** `fetch` that reports every ElevenLabs response (endpoint, voice ids, status; a non-2xx body excerpt). */
const countingFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== 'api.elevenlabs.io') return globalThis.fetch(input, init);
  const path = url.pathname.replace(/^\/v1\//, '');
  const endpoint = path.startsWith('text-to-speech/') ? 'text-to-speech' : path;
  endpointCalls.set(endpoint, (endpointCalls.get(endpoint) ?? 0) + 1);
  let voices: string[] = [];
  if (endpoint === 'text-to-speech') voices = [path.slice('text-to-speech/'.length)];
  else {
    try {
      const body = JSON.parse(String(init?.body ?? 'null')) as { inputs?: Array<{ voice_id?: string }> };
      voices = [...new Set((body.inputs ?? []).map((i) => String(i.voice_id)))];
    } catch {
      voices = [];
    }
  }
  const t0 = performance.now();
  let res: Response;
  try {
    res = await globalThis.fetch(input, init);
  } catch (e) {
    say('elevenlabs', endpoint, voices.map((v) => `${VOICE_NAMES.get(v) ?? '?'}=${v}`).join(','), 'THREW', secs(t0),
      head(e instanceof Error ? `${e.name}: ${e.message}` : e));
    throw e;
  }
  for (const v of voices) voiceStatuses.set(v, [...(voiceStatuses.get(v) ?? []), res.status]);
  const tail = res.ok ? '' : ` body=${JSON.stringify(cut(await res.clone().text().catch(() => ''), 400))}`;
  say('elevenlabs', endpoint, voices.map((v) => `${VOICE_NAMES.get(v) ?? '?'}=${v}`).join(','), res.status, secs(t0) + tail);
  return res;
};

async function main() {
  const tags = await fetch(`${ollama}/api/tags`).then((r) => r.json() as Promise<{ models: Array<{ name: string }> }>);
  say('ollama models', tags.models.map((m) => m.name).filter((n) => /qwen3\.8:27b|qwen3-embedding/.test(n)));

  // The sweep labels: a killed smoke run's container is removed by the next test run's globalSetup.
  docker('run', '-d', '--rm', '--name', name, ...ownerLabelArgs(), '-e', 'POSTGRES_USER=ficino', '-e', 'POSTGRES_PASSWORD=ficino',
    '-e', 'POSTGRES_DB=ficino', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg18');
  const mapping = docker('port', name, '5432/tcp').split('\n')[0]!;
  const url = `postgres://ficino:ficino@127.0.0.1:${mapping.slice(mapping.lastIndexOf(':') + 1)}/ficino`;
  for (let i = 0; ; i++) {
    const probe = createSql(url, { max: 1 });
    try {
      await probe`SELECT 1`;
      break;
    } catch (e) {
      if (i > 180) throw e;
      await sleep(500);
    } finally {
      await probe.end({ timeout: 1 }).catch(() => {});
    }
  }

  const env: Record<string, string> = {
    DATABASE_URL: url,
    AUTH_PROVIDER: 'none',
    ENVIRONMENT: 'development',
    OLLAMA_BASE_URL: ollama,
    UPLOAD_DIR: join(dir, 'uploads'),
    FIGURES_DIR: join(dir, 'figures'),
    MEDIA_DIR: join(dir, 'media'),
    FIGURE_DETECT_PROVIDER: 'none',
  };
  if (elevenKey) env.ELEVENLABS_API_KEY = elevenKey;
  const config = loadConfig(env);
  const sql = createSql(url, { max: 4 });
  await migrate(sql);
  await ensureStubUser(sql);
  const boss = createBoss(url, { max: 3, supervise: false, schedule: false });
  boss.on('error', () => undefined);
  await boss.start();
  await ensureQueues(boss, config.jobTimeLimitSec);
  const signingKey = resolveSigningKey(env);
  const queue = new JobQueue(boss, sql);
  const app = createApp({
    sql, queue, config, logger, storage: new LocalStorage(config, signingKey, logger), signingKey, env,
  });
  worker = await startWorker(env, { providers: { fetch: countingFetch } });

  const csrf = { cookie: 'ficino_csrf=smoke', 'x-csrf-token': 'smoke' };
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const post = async (path: string, payload: unknown = {}) => {
    const res = await app.request(path, {
      method: 'POST', headers: { ...csrf, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** Poll `fn` once a second until `done`, or give up after `limitMs`. */
  const poll = async <T>(fn: () => Promise<T>, done: (v: T) => boolean, limitMs = 15 * 60_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (done(v) || Date.now() - start > limitMs) return v;
      await sleep(1000);
    }
  };
  /** One step: a throw is reported as that step's failure, and the next step still runs. */
  const step = async (label: string, fn: () => Promise<void>) => {
    const t0 = performance.now();
    try {
      await fn();
    } catch (e) {
      say(label, 'THREW', secs(t0), head(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    say(label, 'took', secs(t0));
  };
  /** A media URL from GET /feed/{id}, read the way nginx forwards it (public base stripped), with `Range: bytes=0-1`. */
  const rangeRead = async (mediaUrl: string) => {
    const res = await app.request(mediaUrl.slice(config.publicApiBase.length), { headers: { range: 'bytes=0-1' } });
    const bytes = (await res.arrayBuffer()).byteLength;
    return `range bytes=0-1 -> ${res.status} (${bytes} bytes)${res.status === 206 && bytes === 2 ? '' : ' UNEXPECTED'}`;
  };
  const out = process.env.SMOKE_OUT || mkdtempSync(join(tmpdir(), 'ficino-audio-smoke-out-'));
  mkdirSync(out, { recursive: true });
  /** Copy one media file out of the throwaway MEDIA_DIR; returns its byte size. */
  const keep = (feedId: string, rel: string, as: string): number => {
    const src = join(config.mediaDir, 'feeds', feedId, rel);
    if (!existsSync(src)) return -1;
    copyFileSync(src, join(out, as));
    return statSync(src).size;
  };

  // 1. Two ingested papers.
  const upload = async (): Promise<string> => {
    const form = new FormData();
    form.set('file', new File([readFileSync(new URL('../test/fixtures/sample.pdf', import.meta.url)) as BlobPart], 'sample.pdf', { type: 'application/pdf' }));
    const up = await app.request('/papers', { method: 'POST', body: form, headers: csrf });
    if (up.status >= 300) throw new Error(`upload ${up.status} ${await up.text()}`);
    const paperId = String((await up.json()).id);
    const t0 = performance.now();
    for (;;) {
      const [p] = await sql`SELECT status, chunk_count, error_message FROM papers WHERE id = ${paperId}`;
      if (p!.status === 'complete' || p!.status === 'failed') {
        say('ingestion', p!.status, 'chunks', p!.chunk_count, 'error', p!.error_message ?? null, secs(t0));
        if (p!.status !== 'complete') throw new Error('ingestion failed');
        return paperId;
      }
      await sleep(1000);
    }
  };
  const paperIds = [await upload(), await upload()];

  // 2. The reading list and its ordering.
  let listId = '';
  await step('ordering', async () => {
    const created = await post('/reading-lists', { name: 'Smoke list', paper_ids: paperIds });
    say('reading list', created.status, JSON.stringify(created.body).slice(0, 200));
    if (created.status !== 201) throw new Error('reading list not created');
    listId = String(created.body.id);
    const st = await poll(
      () => queue.getJobState(String(created.body.task_id)),
      (s) => s.state === 'completed' || s.state === 'failed' || s.state === 'cancelled',
    );
    say('ordering job', st.state);
    const detail = await get(`/reading-lists/${listId}`);
    for (const p of (detail.body.papers ?? []) as Array<{ id: string; rationale: string }>) {
      say('rationale', p.id, p.rationale ? head(p.rationale, 120) : '(fallback: no rationale)');
    }
  });
  if (!listId) throw new Error('no reading list');

  // 3. Chapter 0 (posts_per_generation 2; planFeedPosts still plans three openers).
  let feedId: string | null = null;
  await step('chapter', async () => {
    await sql`
      INSERT INTO user_settings (user_id, settings) VALUES (${STUB_USER_ID}, ${sql.json({ posts_per_generation: 2 })})
      ON CONFLICT (user_id) DO UPDATE SET settings = user_settings.settings || EXCLUDED.settings`;
    const gen = await post(`/reading-lists/${listId}/chapters/0/generate`);
    say('chapter dispatch', gen.status, JSON.stringify(gen.body).slice(0, 200));
    const st = await poll(
      () => get(`/feed/status/${gen.body.task_id}`),
      (r) => ['complete', 'error', 'revoked'].includes(String(r.body.status)),
    );
    say('chapter status', JSON.stringify(st.body).slice(0, 200));
    if (!st.body.feed_id) throw new Error('chapter produced no feed');
    feedId = String(st.body.feed_id);
    const feed = await get(`/feed/${feedId}`);
    const posts = (feed.body.posts ?? []) as Array<{ persona?: string; content?: string }>;
    say('chapter posts', posts.length);
    posts.forEach((p, i) => say('post', i, p.persona ?? null, head(p.content, 120)));
  });
  if (!feedId) throw new Error('no chapter feed');
  const fid: string = feedId;

  if (!elevenKey) {
    say('audio skipped (no ELEVENLABS_API_KEY)');
  } else {
    say('media out', out);

    // 4. The podcast: one dialogue render, one file.
    await step('podcast', async () => {
      const r = await post(`/feed/${fid}/podcast`);
      say('podcast dispatch', r.status, JSON.stringify(r.body).slice(0, 200));
      const feed = await poll(
        () => get(`/feed/${fid}`),
        (f) => f.body.podcast_status === 'ready' || f.body.podcast_status === 'failed',
      );
      const segments = (feed.body.podcast_segments ?? []) as Array<{ speaker?: string; text?: string }>;
      const points = segments.reduce((n, s) => n + Array.from(String(s.text ?? '')).length, 0);
      say('podcast', feed.body.podcast_status, `segments=${segments.length}`, `code_points=${points}`);
      if (r.body.task_id) {
        const job = await queue.getJobState(String(r.body.task_id));
        say('podcast job', job.state, JSON.stringify(job.output ?? null).slice(0, 300));
      }
      const dialogueCalls = endpointCalls.get('text-to-dialogue') ?? 0;
      say('podcast text-to-dialogue calls', dialogueCalls, dialogueCalls === 1 ? 'OK' : 'ASSERT FAILED (expected 1)');
      if (dialogueCalls !== 1) process.exitCode = 1;
      if (feed.body.podcast_status !== 'ready') throw new Error('podcast did not render');
      say('podcast bytes', keep(fid, 'podcast/episode.mp3', 'podcast-episode.mp3'));
      say('podcast', await rangeRead(String(feed.body.podcast_audio_url)));
    });

    // 5. Feed audio (per-post TTS clips), only on request.
    if (!feedAudio) {
      say('feed audio skipped (SMOKE_FEED_AUDIO not set)');
    } else {
      await step('feed audio', async () => {
        const r = await post(`/feed/${fid}/audio`);
        say('feed audio dispatch', r.status, JSON.stringify(r.body).slice(0, 200));
        const feed = await poll(
          () => get(`/feed/${fid}`),
          (f) => f.body.audio_status === 'ready' || f.body.audio_status === 'failed',
        );
        say('feed audio', feed.body.audio_status);
        if (r.body.task_id) {
          const job = await queue.getJobState(String(r.body.task_id));
          const o = (job.output ?? {}) as Record<string, unknown>;
          say('feed audio job', job.state, `rendered=${o.rendered ?? null}`, `skipped=${o.skipped ?? null}`);
        }
        const posts = (feed.body.posts ?? []) as Array<{ audio_url?: string; audio_error?: string }>;
        for (const [i, p] of posts.entries()) {
          if (!p.audio_url) {
            say('post audio', i, 'none', p.audio_error ? head(p.audio_error) : '');
            continue;
          }
          say('post audio', i, `bytes=${keep(fid, `audio/post_${i}.mp3`, `feed-post-${i}.mp3`)}`, await rangeRead(p.audio_url));
        }
      });
    }
    say('text-to-dialogue calls (total)', endpointCalls.get('text-to-dialogue') ?? 0);
  }

  for (const [endpoint, n] of endpointCalls) say('elevenlabs calls', endpoint, n);
  for (const [voice, statuses] of voiceStatuses) say('voice', VOICE_NAMES.get(voice) ?? '?', voice, `statuses=${statuses.join(',')}`);

  await boss.stop({ graceful: true, timeout: 5000 });
  await sql.end({ timeout: 2 });
}

try {
  await main();
} catch (e) {
  say('FAILED', e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  await worker?.close().catch(() => {});
  try { docker('rm', '-f', name); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
  process.exit();
}
