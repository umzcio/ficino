/**
 * Manual smoke test (not in CI). NEEDS A LOCAL OLLAMA at OLLAMA_BASE_URL (default http://127.0.0.1:11434) with the
 * default chat model (qwen3.8:27b) and embedding model (qwen3-embedding:latest) pulled. It makes real model calls and
 * can take several minutes.
 *
 * What it does: starts a throwaway pgvector container published on 127.0.0.1 only (random port, removed on exit),
 * migrates it, boots the real worker and the API in this process (no listener: requests go through app.request),
 * uploads test/fixtures/sample.pdf and waits for ingestion. Then it runs one of each conversation surface:
 *   1. the paper summary (GET /messages/papers/:id, poll the status, read it back),
 *   2. a persona DM (POST /personas/skeptic/dm),
 *   3. a feed (posts_per_generation 2) so there is a post to answer, then a reply on post 0 (POST /replies),
 *   4. a zap on that thread (POST /replies/zap),
 *   5. an archivist post (POST /user-posts, poll the status, read it back).
 * For each it prints the status and the first 200 characters of the reply. It opens no port.
 *
 * Usage (from server/): LOG_LEVEL=info npx tsx scripts/ollama-conversations-smoke.ts > "$SCRATCH/smoke.log"
 * (SCRATCH: any directory outside the repo). Lines starting with "SMOKE" are the summary.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { ensureStubUser } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createSql } from '../src/db/sql.js';
import { createBoss, ensureQueues, JobQueue } from '../src/jobs/queue.js';
import { logger } from '../src/logger.js';
import { STUB_USER_ID } from '../src/shared/constants.js';
import { resolveSigningKey } from '../src/shared/signedUrl.js';
import { LocalStorage } from '../src/storage/local.js';
import { startWorker } from '../src/worker/main.js';
import { ownerLabelArgs } from '../test/helpers/sweep.js';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const say = (...a: unknown[]) => console.log('SMOKE', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const head = (s: unknown) => JSON.stringify(Array.from(String(s ?? '')).slice(0, 200).join(''));
const secs = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

const ollama = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const name = `ficino-ts-smoke-${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ficino-smoke-'));
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;

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

  const env = {
    DATABASE_URL: url,
    AUTH_PROVIDER: 'none',
    ENVIRONMENT: 'development',
    OLLAMA_BASE_URL: ollama,
    UPLOAD_DIR: join(dir, 'uploads'),
    FIGURES_DIR: join(dir, 'figures'),
    MEDIA_DIR: join(dir, 'media'),
    FIGURE_DETECT_PROVIDER: 'none',
  };
  const config = loadConfig(env);
  const sql = createSql(url, { max: 4 });
  await migrate(sql);
  await ensureStubUser(sql);
  const boss = createBoss(url, { max: 3, supervise: false, schedule: false });
  boss.on('error', () => undefined);
  await boss.start();
  await ensureQueues(boss, config.jobTimeLimitSec);
  const signingKey = resolveSigningKey(env);
  const app = createApp({
    sql, queue: new JobQueue(boss, sql), config, logger, storage: new LocalStorage(config, signingKey, logger), signingKey, env,
  });
  worker = await startWorker(env);

  const csrf = { cookie: 'ficino_csrf=smoke', 'x-csrf-token': 'smoke' };
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const post = async (path: string, payload: unknown) => {
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
      return;
    }
    say(label, 'took', secs(t0));
  };

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
      break;
    }
    await sleep(1000);
  }

  await step('summary', async () => {
    const first = await get(`/messages/papers/${paperId}`);
    say('summary dispatch', first.status, first.body.status);
    const st = await poll(
      () => get(`/messages/papers/${paperId}/status/${first.body.task_id}`),
      (r) => r.body.status !== 'generating',
    );
    say('summary status', JSON.stringify(st.body).slice(0, 200));
    const s = await get(`/messages/papers/${paperId}`);
    const msgs = (s.body.messages ?? []) as Array<{ type?: string; content?: string }>;
    say('summary', s.status, s.body.status, `messages=${msgs.length}`, head(msgs.map((m) => `${m.type}: ${m.content}`).join(' | ')));
  });

  await step('dm', async () => {
    const r = await post('/personas/skeptic/dm', { message: 'What is the weakest part of the sample paper?' });
    say('dm', r.status, head(r.body.latest_response ?? JSON.stringify(r.body)));
  });

  // A feed gives the reply and zap a real post to answer; posts_per_generation overrides num_posts (as in Python).
  let feedId: string | null = null;
  let postContent = 'A synthetic post about the sample paper.';
  await step('feed', async () => {
    await sql`
      INSERT INTO user_settings (user_id, settings) VALUES (${STUB_USER_ID}, ${sql.json({ posts_per_generation: 2 })})
      ON CONFLICT (user_id) DO UPDATE SET settings = user_settings.settings || EXCLUDED.settings`;
    const gen = await post('/feed/generate', { num_posts: 2 });
    const st = await poll(
      () => get(`/feed/status/${gen.body.task_id}`),
      (r) => ['complete', 'error', 'revoked'].includes(String(r.body.status)),
    );
    say('feed status', JSON.stringify(st.body).slice(0, 200));
    if (!st.body.feed_id) return;
    feedId = String(st.body.feed_id);
    const feed = await get(`/feed/${feedId}`);
    const posts = (feed.body.posts ?? []) as Array<{ content?: string }>;
    say('feed posts', posts.length);
    // With no post produced the reply still runs: the route needs an owned feed, and the post text comes in the body.
    if (posts[0]?.content) postContent = String(posts[0].content);
    say('post 0', head(postContent));
  });

  let replyText = '';
  await step('reply', async () => {
    if (!feedId) throw new Error('no feed to reply on');
    const r = await post('/replies', {
      feed_id: feedId, post_index: 0, persona_key: 'skeptic',
      user_message: 'What would change your mind about this?', post_content: postContent,
    });
    replyText = String(r.body.latest_response ?? '');
    say('reply', r.status, head(r.body.latest_response ?? JSON.stringify(r.body)));
  });

  await step('zap', async () => {
    if (!feedId) throw new Error('no feed to zap on');
    const r = await post('/replies/zap', {
      feed_id: feedId, post_index: 0, target_persona_key: 'hype', source_persona_key: 'skeptic',
      source_message: replyText || 'The sample is too small to generalize.', post_content: postContent,
    });
    say('zap', r.status, head(r.body.content ?? JSON.stringify(r.body)));
  });

  await step('archivist', async () => {
    const created = await post('/user-posts', { content: 'What does the sample paper conclude, and on what evidence?' });
    say('archivist dispatch', created.status, created.body.status);
    const st = await poll(
      () => get(`/user-posts/${created.body.id}/status`),
      (r) => r.body.status !== 'pending',
    );
    const p = await get(`/user-posts/${created.body.id}`);
    const reply = (p.body.replies ?? [])[0] as { content?: string } | undefined;
    say('archivist', st.body.status, `sources=${(p.body.sources ?? []).length}`, head(reply?.content ?? ''));
  });

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
