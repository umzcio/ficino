/**
 * Manual smoke test (not in CI). NEEDS A LOCAL OLLAMA at OLLAMA_BASE_URL (default http://127.0.0.1:11434) with the
 * default chat model (qwen3.8:27b) and embedding model (qwen3-embedding:latest) pulled. It makes real model calls and
 * can take several minutes.
 *
 * What it does: starts a throwaway pgvector container published on 127.0.0.1 only (random port, removed on exit),
 * migrates it, boots the real worker and the API in this process (no listener: requests go through app.request),
 * uploads test/fixtures/sample.pdf, waits for ingestion, runs generate_feed with num_posts 4 and prints the counts,
 * the dropped slots and the wall-clock time. It opens no port.
 *
 * Usage (from server/): LOG_LEVEL=info npx tsx scripts/ollama-feed-smoke.ts > <scratch>/smoke.log
 * Lines starting with "SMOKE" are the summary; the pino JSON lines around them carry the per-slot drop reasons.
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
import { resolveSigningKey } from '../src/shared/signedUrl.js';
import { LocalStorage } from '../src/storage/local.js';
import { startWorker } from '../src/worker/main.js';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const say = (...a: unknown[]) => console.log('SMOKE', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ollama = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const name = `ficino-ts-smoke-${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ficino-smoke-'));
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;

async function main() {
  const tags = await fetch(`${ollama}/api/tags`).then((r) => r.json() as Promise<{ models: Array<{ name: string }> }>);
  say('ollama models', tags.models.map((m) => m.name).filter((n) => /qwen3\.8:27b|qwen3-embedding/.test(n)));

  docker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_USER=ficino', '-e', 'POSTGRES_PASSWORD=ficino',
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
  const form = new FormData();
  form.set('file', new File([readFileSync(new URL('../test/fixtures/sample.pdf', import.meta.url)) as BlobPart], 'sample.pdf', { type: 'application/pdf' }));
  const up = await app.request('/papers', { method: 'POST', body: form, headers: csrf });
  if (up.status >= 300) throw new Error(`upload ${up.status} ${await up.text()}`);
  const paperId = String((await up.json()).id);

  let t0 = performance.now();
  for (;;) {
    const [p] = await sql`SELECT status, chunk_count, error_message FROM papers WHERE id = ${paperId}`;
    if (p!.status === 'complete' || p!.status === 'failed') {
      say('ingestion', p!.status, 'chunks', p!.chunk_count, 'error', p!.error_message ?? null, `${((performance.now() - t0) / 1000).toFixed(1)}s`);
      if (p!.status !== 'complete') throw new Error('ingestion failed');
      break;
    }
    await sleep(1000);
  }

  t0 = performance.now();
  const gen = await app.request('/feed/generate', {
    method: 'POST', headers: { ...csrf, 'content-type': 'application/json' }, body: JSON.stringify({ num_posts: 4 }),
  });
  const { task_id } = await gen.json();
  let st: Record<string, any> = {};
  for (;;) {
    st = await (await app.request(`/feed/status/${task_id}`)).json();
    if (st.status === 'complete' || st.status === 'failed') break;
    await sleep(1000);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  say('generate_feed', st.status, `${secs}s`, JSON.stringify(st));
  if (st.feed_id) {
    const feed = await (await app.request(`/feed/${st.feed_id}`)).json();
    const planned = 4;
    say('slots planned', planned, 'posts produced', feed.posts.length, 'dropped', planned - feed.posts.length);
    for (const p of feed.posts) say('post', p.persona, p.post_type, `sources=${p.sources?.length ?? 0}`, JSON.stringify(String(p.content).slice(0, 120)));
  }
  await sleep(2000); // let the fan-out jobs run
  const jobs = await sql`SELECT name, state FROM pgboss.job WHERE name IN ('check_post_feed','compute_preferences','check_contradictions')`;
  say('fan-out jobs', JSON.stringify(jobs));
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
