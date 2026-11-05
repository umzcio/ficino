import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { Post } from '../../src/feed/types.js';
import { makeJobContext, type JobContext } from '../../src/jobs/context.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { providerConfig } from '../../src/providers/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';
import { embedModelId } from '../../src/providers/embed.js';
import type { Rng } from '../../src/shared/random.js';
import { uuid5 } from '../../src/shared/uuid5.js';
import { LocalStorage } from '../../src/storage/local.js';
import {
  detectContradictions,
  generateFeed,
  getPaperIdsForCorpus,
  loadFigures,
  loadOwnedFigure,
  tabOverrides,
  writeFeedPostsIndex,
} from '../../src/tasks/feed.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, fakeVector, type FakeCall, type FakeProviderOpts } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const storage = new LocalStorage(config, Buffer.from('k'.repeat(32)));
const MODEL = embedModelId(providerConfig({}, {}, config));
const CHUNKS_PER_PAPER = 20;

let s: Seeded;
let personaKeys: string[] = [];
/** a1 is s.paper_a (in workspace_a), a2 has no corpus; same for b. */
let w: { a1: string; a2: string; b1: string; b2: string };

// ---- helpers ---------------------------------------------------------------------------------------------

/** mulberry32: a seeded Rng so plans are reproducible. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Line = Record<string, unknown> & { msg?: string; level: number };
function captureLogger() {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (s: string) => void lines.push(JSON.parse(s) as Line) });
  return { logger, lines };
}
const logged = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg);

async function addPaper(userId: string, title: string, corpusId: string | null = null, status = 'complete') {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, title, authors, year, filename, file_path, status)
    VALUES (${id}, ${userId}, ${corpusId}, ${title}, ${[`Ada ${title.split(' ')[0]}`]}, 2024, ${`${id}.pdf`},
            ${`/papers/${id}.pdf`}, ${status})`;
  return id;
}

async function addChunks(paperId: string, userId: string, title: string, n = CHUNKS_PER_PAPER, model = MODEL) {
  const contents = Array.from({ length: n }, (_, i) => `${title} evidence ${i}: the effect held across cohorts.`);
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

/** personas_enabled with every DB persona off except `keys`. */
const only = (...keys: string[]) => Object.fromEntries(personaKeys.map((k) => [k, keys.includes(k)]));
/** Stored weights merge one level deep over the defaults, so every type is named. */
const weights = (w: Record<string, number>) => ({ post: 0, thread: 0, quote: 0, reply: 0, figure: 0, ...w });
/** One persona, plain posts only: n slots, all reaching the LLM. */
const simple = (n: number, extra: Record<string, unknown> = {}) => ({
  personas_enabled: only('skeptic'),
  post_type_weights: weights({ post: 1 }),
  posts_per_generation: n,
  ...extra,
});

function promptOf(c: FakeCall): { system: string; user: string } {
  const b = c.body as { system?: string; messages: Array<{ role: string; content: string }> };
  if (c.kind === 'anthropic') return { system: String(b.system), user: String(b.messages[0]!.content) };
  return {
    system: b.messages.find((m) => m.role === 'system')?.content ?? '',
    user: b.messages.find((m) => m.role === 'user')?.content ?? '',
  };
}
const isEmbed = (c: FakeCall) => c.kind.endsWith('-embed');
const isChat = (c: FakeCall) => !isEmbed(c);
const isPersonaCall = (c: FakeCall) => isChat(c) && promptOf(c).system.startsWith('You are one of five AI personas');

type RunOpts = {
  jobId?: string;
  providers?: ProviderDeps;
  queue?: JobQueue;
  signal?: AbortSignal;
  rng?: Rng;
};

function start(data: Parameters<typeof generateFeed>[0], o: RunOpts = {}) {
  const { logger, lines } = captureLogger();
  const metas: Record<string, unknown>[] = [];
  const jobId = o.jobId ?? randomUUID();
  const base = makeJobContext(
    { id: jobId, name: 'generate_feed', retryCount: 0, signal: o.signal ?? new AbortController().signal },
    sql,
    logger,
    600_000,
    2,
  );
  const ctx: JobContext = {
    ...base,
    async progress(m) {
      metas.push(m);
      await base.progress(m);
    },
  };
  const deps: WorkerDeps = {
    sql,
    config,
    env: {},
    logger,
    storage,
    queue: o.queue ?? testQueue(),
    providers: o.providers ?? fakeProviders().deps,
    rng: o.rng ?? seeded(7),
  };
  return { promise: generateFeed(data, ctx, deps) as Promise<Record<string, any>>, lines, metas, jobId };
}
async function run(data: Parameters<typeof generateFeed>[0], o: RunOpts = {}) {
  const r = start(data, o);
  return { ...r, result: await r.promise };
}

async function feedRow(id: string) {
  const [r] = await sql`SELECT * FROM feeds WHERE id = ${id}`;
  return r as (Record<string, any> & { posts: Post[] }) | undefined;
}
const paperIdsCited = (posts: Post[]) =>
  new Set(posts.flatMap((p) => (p.sources as Array<{ paper_id: string }>).map((src) => src.paper_id)));

beforeAll(async () => {
  personaKeys = (await sql`SELECT key FROM personas`).map((r) => String(r.key));
});

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  await sql`UPDATE papers SET title = 'Alpha One', authors = ${['Ada Alpha']}, year = 2024 WHERE id = ${s.paper_a}`;
  await sql`UPDATE papers SET title = 'Beta One', authors = ${['Bo Beta']}, year = 2023 WHERE id = ${s.paper_b}`;
  w = {
    a1: s.paper_a,
    a2: await addPaper(s.user_a, 'Alpha Two'),
    b1: s.paper_b,
    b2: await addPaper(s.user_b, 'Beta Two'),
  };
  await addChunks(w.a1, s.user_a, 'Alpha One');
  await addChunks(w.a2, s.user_a, 'Alpha Two');
  await addChunks(w.b1, s.user_b, 'Beta One');
  await addChunks(w.b2, s.user_b, 'Beta Two');
});

// ---- idempotency (worker/tests/test_generate_feed_idempotency.py) ----------------------------------------

describe('generate_feed idempotency', () => {
  it('test_fresh_feed_redelivery_is_idempotent', async () => {
    await setSettings(s.user_a, simple(2));
    const f = fakeProviders();
    const jobId = randomUUID();
    const first = await run({ user_id: s.user_a, num_posts: 2 }, { jobId, providers: f.deps });
    const expected = uuid5(`ficino:feed:${jobId}`);
    expect(first.result.feed_id).toBe(expected);
    expect(first.result.post_count).toBe(2);
    expect(f.calls.filter(isPersonaCall)).toHaveLength(2);
    expect((await sql`SELECT id FROM feeds WHERE user_id = ${s.user_a} AND id <> ${s.feed_a}`).map((r) => r.id)).toEqual([
      expected,
    ]);

    const callsBefore = f.calls.filter(isChat).length;
    const second = await run({ user_id: s.user_a, num_posts: 2 }, { jobId, providers: f.deps });
    expect(second.result).toEqual({ feed_id: expected, post_count: 2, duration_ms: 0, idempotent: true });
    expect(f.calls.filter(isChat).length).toBe(callsBefore);
    expect(await sql`SELECT id FROM feeds WHERE id = ${expected}`).toHaveLength(1);
    expect(logged(second.lines, 'generate_feed_idempotent_skip')).toHaveLength(1);
  });

  it('test_fresh_feed_new_dispatch_gets_new_feed_id', async () => {
    await setSettings(s.user_a, simple(2));
    const f = fakeProviders();
    const first = await run({ user_id: s.user_a }, { providers: f.deps });
    const second = await run({ user_id: s.user_a }, { providers: f.deps });
    expect(second.result.feed_id).not.toBe(first.result.feed_id);
    expect(second.result).not.toHaveProperty('idempotent');
    expect(await sql`SELECT id FROM feeds WHERE id IN ${sql([first.result.feed_id, second.result.feed_id])}`).toHaveLength(2);
    expect(f.calls.filter(isPersonaCall)).toHaveLength(4);
  });

  it('test_empty_feed_redelivery_does_not_error_or_duplicate', async () => {
    await sql`UPDATE papers SET status = 'pending' WHERE user_id = ${s.user_a}`;
    const jobId = randomUUID();
    const first = await run({ user_id: s.user_a }, { jobId });
    const second = await run({ user_id: s.user_a }, { jobId });
    expect(first.result).toEqual({ status: 'complete', feed_id: uuid5(`ficino:feed:${jobId}`), post_count: 0 });
    expect(second.result).toEqual(first.result);
    const rows = await sql`SELECT posts, post_count, paper_count, generation_duration_ms FROM feeds WHERE id = ${first.result.feed_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ posts: [], post_count: 0, paper_count: 0, generation_duration_ms: 0 });
  });

  it('test_empty_attempt_then_successful_redelivery_recovers_posts', async () => {
    await setSettings(s.user_a, simple(2));
    await sql`DELETE FROM chunks WHERE user_id = ${s.user_a}`;
    const f = fakeProviders();
    const jobId = randomUUID();
    const first = await run({ user_id: s.user_a }, { jobId, providers: f.deps });
    expect(first.result.post_count).toBe(0);
    expect(f.calls.filter(isChat)).toHaveLength(0); // no chunks: every slot skipped before the LLM
    expect((await feedRow(first.result.feed_id))!.post_count).toBe(0);

    await addChunks(w.a1, s.user_a, 'Alpha One');
    const second = await run({ user_id: s.user_a }, { jobId, providers: f.deps });
    expect(second.result.post_count).toBe(2);
    expect(second.result).not.toHaveProperty('idempotent');
    expect(second.result.feed_id).toBe(first.result.feed_id);
    expect(await sql`SELECT id FROM feeds WHERE id = ${first.result.feed_id}`).toHaveLength(1);
    const row = (await feedRow(first.result.feed_id))!;
    expect(row.post_count).toBe(2);
    expect(row.posts).toHaveLength(2);
  });
});

// ---- append mode -----------------------------------------------------------------------------------------

describe('generate_feed append mode', () => {
  it('appends with continuing ids and times, sums durations, and a same-job retry appends nothing', async () => {
    await setSettings(s.user_a, simple(2));
    const fresh = await run({ user_id: s.user_a });
    const feedId = fresh.result.feed_id as string;
    const appendJob = randomUUID();
    const app = await run({ user_id: s.user_a, append_to_feed_id: feedId }, { jobId: appendJob });
    expect(app.result).toMatchObject({ status: 'complete', feed_id: feedId, post_count: 4, paper_count: 2 });

    const row = (await feedRow(feedId))!;
    expect(row.post_count).toBe(4);
    expect(row.posts.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(row.posts.map((p) => p.time)).toEqual(['2m', '4m', '6m', '8m']);
    expect(row.posts.slice(2).every((p) => p._task_id === appendJob)).toBe(true);
    expect(row.posts.slice(0, 2).every((p) => p._task_id === fresh.jobId)).toBe(true);
    expect(row.generation_duration_ms).toBe(fresh.result.duration_ms + app.result.duration_ms);
    // Appended posts stake out new chunks: none reuses a chunk an earlier post was grounded on.
    const chunkIds = row.posts.flatMap((p) => (p.sources as Array<{ chunk_id: string }>).map((x) => x.chunk_id));
    expect(new Set(chunkIds).size).toBe(chunkIds.length);

    const fp = await sql`SELECT post_index FROM feed_posts WHERE feed_id = ${feedId} ORDER BY post_index`;
    expect(fp.map((r) => r.post_index)).toEqual([0, 1, 2, 3]);

    const retry = await run({ user_id: s.user_a, append_to_feed_id: feedId }, { jobId: appendJob });
    expect(retry.result).toEqual({ feed_id: feedId, post_count: 4, duration_ms: 0, idempotent: true });
    expect((await feedRow(feedId))!.posts).toHaveLength(4);
  });

  it('two different append jobs running concurrently both land (no lost slice)', async () => {
    await setSettings(s.user_a, simple(2));
    const fresh = await run({ user_id: s.user_a });
    const feedId = fresh.result.feed_id as string;
    const f = fakeProviders({ delayMs: 5 });
    const [x, y] = await Promise.all([
      run({ user_id: s.user_a, append_to_feed_id: feedId }, { providers: f.deps, rng: seeded(1) }),
      run({ user_id: s.user_a, append_to_feed_id: feedId }, { providers: f.deps, rng: seeded(2) }),
    ]);
    const row = (await feedRow(feedId))!;
    expect(row.posts).toHaveLength(6);
    expect(row.post_count).toBe(6);
    const byTask = (id: string) => row.posts.filter((p) => p._task_id === id).length;
    expect([byTask(fresh.jobId), byTask(x.jobId), byTask(y.jobId)]).toEqual([2, 2, 2]);
  });

  it("deliberate change 7: another user's feed id fails before any LLM or embed call, touching nothing", async () => {
    await setSettings(s.user_a, simple(1));
    const victimPosts = [{ id: 1, persona: 'hype', post_type: 'post', content: 'victim post', category: 'findings' }];
    await sql`UPDATE feeds SET posts = ${sql.json(victimPosts)}, post_count = 1 WHERE id = ${s.feed_b}`;
    await writeFeedPostsIndex(sql, s.feed_b, victimPosts, 0, s.user_b);
    const indexBefore = await sql`SELECT * FROM feed_posts WHERE feed_id = ${s.feed_b} ORDER BY post_index`;

    const f = fakeProviders();
    const r = start({ user_id: s.user_a, append_to_feed_id: s.feed_b }, { providers: f.deps });
    await expect(r.promise).rejects.toThrow(`Feed ${s.feed_b} not found`);
    expect(f.calls).toHaveLength(0);
    expect(r.metas).toEqual([]);
    const row = (await feedRow(s.feed_b))!;
    expect(row.posts).toEqual(victimPosts);
    expect(row.post_count).toBe(1);
    expect(await sql`SELECT * FROM feed_posts WHERE feed_id = ${s.feed_b} ORDER BY post_index`).toEqual(indexBefore);
    expect(await sql`SELECT 1 FROM pgboss.job WHERE name IN ('check_post_feed', 'compute_preferences')`).toHaveLength(0);
  });
});

// ---- progress, garbage output, isolation ------------------------------------------------------------------

describe('generate_feed pipeline', () => {
  it('progress: the four steps with exactly {step, feed_id}, then one post_progress per plan entry', async () => {
    await setSettings(s.user_a, simple(3));
    const { metas, result, jobId } = await run({ user_id: s.user_a });
    const feedId = result.feed_id;
    expect(metas.slice(0, 4)).toEqual(
      ['scoping', 'retrieving', 'classifying', 'generating'].map((step) => ({ step, feed_id: feedId })),
    );
    expect(metas.slice(4)).toEqual(
      ['1/3', '2/3', '3/3'].map((pp) => ({ step: 'generating', feed_id: feedId, post_progress: pp })),
    );
    const [row] = await sql`SELECT meta FROM job_progress WHERE job_id = ${jobId}`;
    expect(row!.meta).toEqual({ step: 'generating', feed_id: feedId, post_progress: '3/3' });
  });

  it('Review Focus 3: garbage LLM output drops only its slot', async () => {
    await setSettings(s.user_a, simple(6));
    const replies = [
      '{"post_type": "post", "content": "A valid take."}',
      'Plain prose with no JSON at all, but a real opinion.',
      '"str"',
      '[1]',
      'x'.repeat(4001),
      '{"posts": [{"text": "preamble shape", "type": "standalone"}]}',
    ];
    let n = 0;
    const f = fakeProviders({
      chat: (_b, info) => (info.purpose === 'persona' ? replies[n++]! : 'extends'),
    });
    const { result, lines } = await run({ user_id: s.user_a }, { providers: f.deps });
    expect(n).toBe(6);
    expect(result.post_count).toBe(2);
    const row = (await feedRow(result.feed_id))!;
    expect(row.posts.map((p) => p.content)).toEqual([
      'A valid take.',
      'Plain prose with no JSON at all, but a real opinion.',
    ]);
    expect(row.posts.map((p) => p.id)).toEqual([1, 2]);
    expect(logged(lines, 'post_generation_failed')).toHaveLength(4);
  });

  it('Review Focus 1: concurrent feeds for two users never cross keys, embed providers or papers', async () => {
    await setSettings(s.user_a, {
      ...simple(3),
      llm_provider: 'api',
      anthropic_api_key: 'sk-a',
      embed_provider: 'openai',
      openai_api_key: 'ek-a',
    });
    await setSettings(s.user_b, { ...simple(3), llm_provider: 'ollama' });
    // Each user's chunks carry that user's embed model, so retrieval only works if the right provider embeds the query.
    const modelA = embedModelId(providerConfig({ embed_provider: 'openai', openai_api_key: 'ek-a' }, {}, config));
    await sql`DELETE FROM chunks WHERE user_id = ${s.user_a}`;
    await addChunks(w.a1, s.user_a, 'Alpha One', CHUNKS_PER_PAPER, modelA);
    await addChunks(w.a2, s.user_a, 'Alpha Two', CHUNKS_PER_PAPER, modelA);
    const f = fakeProviders({ delayMs: 3 });
    const [a, b] = await Promise.all([
      run({ user_id: s.user_a }, { providers: f.deps }),
      run({ user_id: s.user_b }, { providers: f.deps }),
    ]);
    const anthropic = f.calls.filter((c) => c.kind === 'anthropic');
    const ollamaChat = f.calls.filter((c) => c.kind === 'ollama-chat');
    expect(anthropic.length).toBeGreaterThan(0);
    expect(ollamaChat.length).toBeGreaterThan(0);
    expect(anthropic.every((c) => c.apiKey === 'sk-a')).toBe(true);
    // Embeds: every one is either A's (OpenAI with A's key) or B's (Ollama); none crosses over.
    const openaiEmbeds = f.calls.filter((c) => c.kind === 'openai-embed');
    const ollamaEmbeds = f.calls.filter((c) => c.kind === 'ollama-embed');
    expect(openaiEmbeds.length).toBeGreaterThan(0);
    expect(ollamaEmbeds.length).toBeGreaterThan(0);
    expect(f.calls.filter(isEmbed)).toHaveLength(openaiEmbeds.length + ollamaEmbeds.length);
    expect(openaiEmbeds.every((c) => c.apiKey === 'ek-a')).toBe(true);
    expect(ollamaEmbeds.every((c) => c.model === 'qwen3-embedding:latest')).toBe(true);
    // A's calls (Anthropic) only ever see A's papers, B's (Ollama) only B's.
    expect(anthropic.every((c) => !promptOf(c).user.includes('Beta'))).toBe(true);
    expect(anthropic.some((c) => promptOf(c).user.includes('Alpha'))).toBe(true);
    expect(ollamaChat.every((c) => !promptOf(c).user.includes('Alpha'))).toBe(true);
    expect(ollamaChat.some((c) => promptOf(c).user.includes('Beta'))).toBe(true);

    const postsA = (await feedRow(a.result.feed_id))!.posts;
    const postsB = (await feedRow(b.result.feed_id))!.posts;
    expect(postsA).toHaveLength(3);
    expect(postsB).toHaveLength(3);
    for (const pid of paperIdsCited(postsA)) expect([w.a1, w.a2]).toContain(pid);
    for (const pid of paperIdsCited(postsB)) expect([w.b1, w.b2]).toContain(pid);
  });

  it('Review Focus 4: chunks from another embed model are never cited, and the mismatch is logged once', async () => {
    await setSettings(s.user_a, simple(4));
    await sql`DELETE FROM chunks WHERE paper_id = ${w.a2}`;
    await addChunks(w.a2, s.user_a, 'Alpha Two', 7, 'voyage:voyage-4-large@1024');
    const { result, lines } = await run({ user_id: s.user_a });
    const posts = (await feedRow(result.feed_id))!.posts;
    expect(posts.length).toBeGreaterThan(0);
    expect(paperIdsCited(posts).has(w.a2)).toBe(false);
    const warn = logged(lines, 'embed_model_mismatch');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ expected: MODEL, excluded_chunks: 7 });
  });

  it('every in-scope chunk on another embed model: throws the clear error before any persona or LLM call', async () => {
    await setSettings(s.user_a, simple(4));
    await sql`UPDATE chunks SET metadata = ${sql.json({ embed_model: 'voyage:voyage-4-large@1024' })} WHERE user_id = ${s.user_a}`;
    const f = fakeProviders();
    await expect(run({ user_id: s.user_a }, { providers: f.deps })).rejects.toThrow(
      `No chunks embedded with ${MODEL}: ${CHUNKS_PER_PAPER * 2} chunks in scope use a different embedding model. Re-process your papers or switch the embedding model back.`,
    );
    expect(f.calls).toHaveLength(0);
  });

  it('no mismatch warning when every in-scope chunk matches the model', async () => {
    await setSettings(s.user_a, simple(1));
    const { lines } = await run({ user_id: s.user_a });
    expect(logged(lines, 'embed_model_mismatch')).toHaveLength(0);
  });

  it('a failed batch query embed falls back to per-persona embedding', async () => {
    await setSettings(s.user_a, simple(1));
    let embeds = 0;
    const base = fakeProviders();
    const providers: ProviderDeps = {
      ...base.deps,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/api/embed') && embeds++ === 0) return new Response('boom', { status: 400 });
        return base.deps.fetch(input, init);
      }) as typeof fetch,
    };
    const { result, lines } = await run({ user_id: s.user_a }, { providers });
    expect(logged(lines, 'persona_query_batch_embed_failed')).toHaveLength(1);
    expect(result.post_count).toBe(1);
  });
});

// ---- re-retrieve with exclusion ---------------------------------------------------------------------------

describe('generate_feed re-retrieve with exclusion', () => {
  // simple(3): one persona with 3 slots over its top-10, so each slot's window is 3 chunks. Slot 1 has no used
  // chunks (no re-retrieve); slots 2 and 3 have fewer than 5 fresh chunks and a non-empty budget.
  const afterExclusion = (lines: Line[]) => logged(lines, 'persona_chunks_after_exclusion');
  const excludedRetrievals = (lines: Line[]) =>
    logged(lines, 'retrieval_start').filter((l) => (l.excluded as number) > 0);
  const sourceIds = (p: Post) => (p.sources as Array<{ chunk_id: string }>).map((x) => x.chunk_id);

  it('fires when under 5 fresh chunks remain: the retrieval excludes used ids and its result replaces the window', async () => {
    await setSettings(s.user_a, simple(3));
    const { result, lines } = await run({ user_id: s.user_a });
    const logs = afterExclusion(lines);
    expect(logs.map((l) => l.re_retrieved)).toEqual([false, true, true]);
    expect(logs[1]).toMatchObject({ pre_exclusion_count: 3, excluded_count: 3, available_count: 10 });
    // The re-retrieval calls carried the used chunk ids: 3 after post 1, 8 after post 2 (3 + 5 sources).
    expect(excludedRetrievals(lines).map((l) => l.excluded)).toEqual([3, 8]);
    const posts = (await feedRow(result.feed_id))!.posts;
    expect(posts.map((p) => sourceIds(p).length)).toEqual([3, 5, 5]);
    const all = posts.flatMap(sourceIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps the original window when the fresh result is smaller', async () => {
    await setSettings(s.user_a, simple(3));
    let first = true;
    const f = fakeProviders({
      chat: async (_b, info) => {
        if (info.purpose !== 'persona') return 'extends';
        // After the first post, the user's chunks vanish: every re-retrieval comes back empty.
        if (first) await sql`DELETE FROM chunks WHERE user_id = ${s.user_a}`;
        first = false;
        return '{"post_type": "post", "content": "A grounded take."}';
      },
    });
    const { result, lines } = await run({ user_id: s.user_a }, { providers: f.deps });
    const logs = afterExclusion(lines);
    expect(logs.map((l) => l.re_retrieved)).toEqual([false, false, false]);
    expect(logs.map((l) => l.available_count)).toEqual([3, 3, 3]);
    expect(excludedRetrievals(lines)).toHaveLength(2); // it did try
    const posts = (await feedRow(result.feed_id))!.posts;
    expect(posts.map((p) => sourceIds(p).length)).toEqual([3, 3, 3]);
    const all = posts.flatMap(sourceIds);
    expect(new Set(all).size).toBe(9);
  });

  it('a failed re-retrieval is logged as re_retrieve_failed and the slot keeps its window', async () => {
    await setSettings(s.user_a, simple(3));
    // Embed calls: 1 = the batch (fails, so each retrieval embeds its own query), 2 = the initial retrieval (ok),
    // 3+ = the re-retrievals (fail).
    let embeds = 0;
    const base = fakeProviders();
    const providers: ProviderDeps = {
      ...base.deps,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/api/embed') && ++embeds !== 2) return new Response('boom', { status: 400 });
        return base.deps.fetch(input, init);
      }) as typeof fetch,
    };
    const { result, lines } = await run({ user_id: s.user_a }, { providers });
    const failed = logged(lines, 're_retrieve_failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ persona: 'skeptic' });
    expect(afterExclusion(lines).map((l) => [l.re_retrieved, l.available_count])).toEqual([
      [false, 3],
      [false, 3],
      [false, 3],
    ]);
    expect(result.post_count).toBe(3);
  });
});

describe('generate_feed prompt failures', () => {
  it('a throw inside buildPostPrompt fails the job (it sits outside the per-slot try)', async () => {
    // A quote's parent is grounded on a chunk id that is not a UUID, so loading its anchors throws.
    const bogus = [{ id: 1, time: '2m', persona: 'hype', post_type: 'post', content: 'old', sources: [{ chunk_id: 'nope' }] }];
    await sql`UPDATE feeds SET posts = ${sql.json(bogus)}, post_count = 1 WHERE id = ${s.feed_a}`;
    await setSettings(s.user_a, simple(2, { post_type_weights: weights({ quote: 1 }) }));
    let n = 0;
    const f = fakeProviders({
      // The opener's reply is dropped, so the quote slot can only pick the bogus parent.
      chat: (_b, info) => (info.purpose === 'persona' ? (n++ === 0 ? '[1]' : '{"content": "q"}') : 'extends'),
    });
    const r = start({ user_id: s.user_a, append_to_feed_id: s.feed_a }, { providers: f.deps });
    await expect(r.promise).rejects.toThrow();
    expect(n).toBe(1); // the quote slot never reached the LLM
    expect(logged(r.lines, 'post_generation_failed')).toHaveLength(1); // the opener only
    expect(logged(r.lines, 'feed_generation_failed')).toHaveLength(1);
    expect((await feedRow(s.feed_a))!.posts).toEqual(bogus);
  });
});

// ---- scoping ---------------------------------------------------------------------------------------------

describe('getPaperIdsForCorpus', () => {
  it("tag_filter uses only the user's own tags, even when another user has a same-named tag", async () => {
    const [ta] = await sql`INSERT INTO tags (user_id, name) VALUES (${s.user_a}, 'ML') RETURNING id`;
    const [tb] = await sql`INSERT INTO tags (user_id, name) VALUES (${s.user_b}, 'ML') RETURNING id`;
    await sql`INSERT INTO paper_tags (paper_id, tag_id) VALUES (${w.a1}, ${ta!.id}), (${w.b1}, ${tb!.id})`;
    // A's tag on B's paper would only appear by joining on name alone.
    await sql`INSERT INTO paper_tags (paper_id, tag_id) VALUES (${w.b2}, ${ta!.id})`;
    expect(await getPaperIdsForCorpus(sql, null, ['ML'], s.user_a)).toEqual([w.a1]);
    expect(await getPaperIdsForCorpus(sql, null, ['ML', 'none'], s.user_b)).toEqual([w.b1]);
  });

  it('corpus_id uses only that corpus (and only the caller’s papers in it)', async () => {
    await addPaper(s.user_b, 'Beta Intruder', s.workspace_a);
    await addPaper(s.user_a, 'Alpha Pending', s.workspace_a, 'pending');
    expect(await getPaperIdsForCorpus(sql, s.workspace_a, null, s.user_a)).toEqual([w.a1]);
  });

  it('no filter: every complete paper the user owns', async () => {
    expect((await getPaperIdsForCorpus(sql, null, [], s.user_a)).sort()).toEqual([w.a1, w.a2].sort());
  });

  it('a corpus-scoped feed cites only that corpus', async () => {
    await setSettings(s.user_a, simple(3));
    // An empty tag_filter is falsy, so the corpus branch applies (and [] is stored as-is).
    const { result } = await run({ user_id: s.user_a, corpus_id: s.workspace_a, tag_filter: [] });
    expect(result.paper_count).toBe(1);
    const row = (await feedRow(result.feed_id))!;
    expect([...paperIdsCited(row.posts)]).toEqual([w.a1]);
    expect(row.corpus_id).toBe(s.workspace_a);
    expect(row.tag_filter).toEqual([]);
  });
});

// ---- figures, persona_key, tab focus ---------------------------------------------------------------------

async function addFigure(paperId: string, figureType: string | null, idx = 0) {
  const id = randomUUID();
  await sql`
    INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, figure_index, figure_type,
                         caption, figure_number, data_claim, description)
    VALUES (${id}, ${paperId}, 2, ${`${paperId}/fig${idx}.png`}, 'detector', ${idx}, ${figureType},
            'Share of turns by speaker.', '3', 'Turns cluster.', 'legacy description')`;
  return id;
}

describe('figure loaders', () => {
  it('loadFigures maps every figure of the papers; loadOwnedFigure is scoped to the owner', async () => {
    const fig = await addFigure(w.a1, 'chart_bar');
    await addFigure(w.b1, 'diagram');
    const figs = await loadFigures(sql, storage, [w.a1, w.a2]);
    expect(figs).toHaveLength(1);
    expect(figs[0]).toMatchObject({
      id: fig,
      paper_id: w.a1,
      page_number: 2,
      description: 'legacy description',
      claim_summary: '',
      figure_index: 0,
      paper_ref: 'Alpha One',
      figure_type: 'chart_bar',
      caption: 'Share of turns by speaker.',
      figure_number: '3',
      data_claim: 'Turns cluster.',
      referenced_paragraph: '',
      detector_confidence: null,
    });
    expect(figs[0]!.image_url).toMatch(new RegExp(`^/figures/${w.a1}/${fig}\\?token=`));
    expect(await loadOwnedFigure(sql, storage, fig, s.user_a)).toEqual(figs[0]);
    expect(await loadOwnedFigure(sql, storage, fig, s.user_b)).toBeNull();
  });
});

describe('generate_feed figure slots', () => {
  it('a typed figure of an allowed type lands on the post with url, id and caption', async () => {
    await setSettings(s.user_a, simple(3, { post_type_weights: weights({ figure: 1 }) }));
    const fig = await addFigure(w.a1, 'chart_bar');
    const f = fakeProviders();
    const { result } = await run({ user_id: s.user_a }, { providers: f.deps });
    const posts = (await feedRow(result.feed_id))!.posts;
    const figurePosts = posts.filter((p) => p.figure_id);
    expect(figurePosts).toHaveLength(2); // the opener is a plain post
    for (const p of figurePosts) {
      expect(p.figure_id).toBe(fig);
      expect(p.figure_url).toMatch(new RegExp(`^/figures/${w.a1}/${fig}\\?token=`));
      expect(p.figure_caption).toBe('Fig. 3, p.2 — Share of turns by speaker.. Alpha One');
    }
    expect(f.calls.filter(isPersonaCall).filter((c) => promptOf(c).user.includes('Share of turns'))).toHaveLength(2);
  });

  it('untyped figures are never chosen: their slots are skipped', async () => {
    await setSettings(s.user_a, simple(3, { post_type_weights: weights({ figure: 1 }) }));
    await addFigure(w.a1, null);
    const { result, lines } = await run({ user_id: s.user_a });
    const posts = (await feedRow(result.feed_id))!.posts;
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toHaveProperty('figure_id');
    const skips = logged(lines, 'figure_post_skipped_no_eligible_figure');
    expect(skips).toHaveLength(2);
    expect(skips[0]).toMatchObject({ persona: 'skeptic', available_types: [] });
    expect((skips[0]!.allowed as string[]).sort()).toContain('chart_bar');
  });

  it('a figure slot with no figures at all is skipped', async () => {
    await setSettings(s.user_a, simple(2, { post_type_weights: weights({ figure: 1 }) }));
    const { result, lines } = await run({ user_id: s.user_a });
    expect(result.post_count).toBe(1);
    expect(logged(lines, 'figure_post_skipped_no_figures_in_paper')).toHaveLength(1);
  });
});

describe('generate_feed persona_key and tab_focus', () => {
  it('persona_key uses only that persona and honors the request num_posts', async () => {
    await setSettings(s.user_a, { posts_per_generation: 12 });
    const f = fakeProviders();
    const { result } = await run({ user_id: s.user_a, persona_key: 'methodologist', num_posts: 2 }, { providers: f.deps });
    const posts = (await feedRow(result.feed_id))!.posts;
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.persona === 'methodologist')).toBe(true);
    expect(f.calls.filter(isPersonaCall)).toHaveLength(2);
  });

  it("tab_focus 'methods' sets category 'methods' on every post", async () => {
    await setSettings(s.user_a, { posts_per_generation: 5 });
    const { result } = await run({ user_id: s.user_a, tab_focus: 'methods' });
    const posts = (await feedRow(result.feed_id))!.posts;
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.category === 'methods')).toBe(true);
    expect(posts.every((p) => ['skeptic', 'methodologist'].includes(p.persona as string))).toBe(true);
  });

  it('tabOverrides: debates keeps all, methods/findings intersect (or fall back), unknown is null', () => {
    const all = new Set(['skeptic', 'hype', 'gradstudent']);
    expect(tabOverrides('debates', all)).toEqual({
      personas: all,
      post_weights: { post: 0.1, thread: 0.05, quote: 0.4, reply: 0.4, figure: 0.05 },
    });
    expect(tabOverrides('methods', all)!.personas).toEqual(new Set(['skeptic']));
    expect(tabOverrides('findings', new Set(['skeptic']))!.personas).toEqual(new Set(['skeptic']));
    expect(Object.keys(tabOverrides('findings', all)!.post_weights)).toEqual(['post', 'thread', 'quote', 'reply', 'figure']);
    expect(tabOverrides('nope', all)).toBeNull();
  });
});

// ---- contradictions --------------------------------------------------------------------------------------

describe('detectContradictions', () => {
  const chunk = (id: string, paper: string, content: string) =>
    ({ id, paper_id: paper, paper_title: `T-${paper}`, paper_filename: null, content }) as never;
  const p = providerConfig({}, {}, config);

  it('one paper gives no pairs and no LLM calls', async () => {
    const f = fakeProviders();
    const { logger } = captureLogger();
    expect(await detectContradictions(seeded(1), p, f.deps, [chunk('1', 'x', 'a')], { logger })).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('classifies up to 5 pairs serially, keeps contradicts/supports, else the first 2', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const f = fakeProviders({
      chat: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return 'extends';
      },
    });
    const { logger, lines } = captureLogger();
    const chunks = [chunk('1', 'x', 'a'), chunk('2', 'y', 'b'), chunk('3', 'z', 'c')];
    const out = await detectContradictions(seeded(3), p, f.deps, chunks, { logger });
    expect(f.calls.filter(isChat)).toHaveLength(5);
    expect(maxInflight).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ relationship: 'extends' });
    expect(out[0]!.paper_a).toMatch(/^T-/);
    expect(logged(lines, 'contradictions_detected')[0]).toMatchObject({ total_pairs: 5, interesting: 0 });

    let k = 0;
    const g = fakeProviders({ chat: () => (k++ % 2 === 0 ? 'contradicts' : 'extends') });
    const out2 = await detectContradictions(seeded(3), p, g.deps, chunks, { logger });
    expect(out2.map((c) => c.relationship)).toEqual(['contradicts', 'contradicts', 'contradicts']);
  });

  it('a failed classification is logged and skipped', async () => {
    let k = 0;
    const f = fakeProviders({
      chat: () => {
        // An empty reply is a non-retryable provider error.
        if (k++ === 0) return '';
        return 'supports';
      },
    });
    const { logger, lines } = captureLogger();
    const chunks = [chunk('1', 'x', 'a'), chunk('2', 'y', 'b')];
    const out = await detectContradictions(seeded(3), p, f.deps, chunks, { logger, maxPairs: 3 });
    expect(out).toHaveLength(2);
    expect(logged(lines, 'contradiction_classify_failed')).toHaveLength(1);
  });
});

// ---- persistence, fan-out, abort -------------------------------------------------------------------------

describe('generate_feed persistence and fan-out', () => {
  it('every feed_posts row matches its post at the same index, with data stored as an object', async () => {
    await setSettings(s.user_a, simple(3));
    const { result } = await run({ user_id: s.user_a });
    const posts = (await feedRow(result.feed_id))!.posts;
    const rows = await sql`
      SELECT post_index, user_id, content_text, persona, post_type, category, paper_ref, data, deleted,
             jsonb_typeof(data) AS t
      FROM feed_posts WHERE feed_id = ${result.feed_id} ORDER BY post_index`;
    expect(rows).toHaveLength(posts.length);
    rows.forEach((r, i) => {
      const p = posts[i]!;
      expect(r.t).toBe('object');
      expect(r.data).toEqual(p);
      expect(r).toMatchObject({
        post_index: i,
        user_id: s.user_a,
        content_text: p.content,
        persona: p.persona,
        post_type: p.post_type,
        category: p.category,
        paper_ref: p.paper_ref,
        deleted: false,
      });
    });
  });

  it('writeFeedPostsIndex upserts on (feed_id, post_index) in one statement', async () => {
    const posts = [
      { content: 'one', persona: 'skeptic', post_type: 'post', category: 'methods', paper_ref: 'X 2024' },
      { content: 'two', persona: 'hype', post_type: 'post', category: 'findings', paper_ref: null, deleted: true },
    ];
    await writeFeedPostsIndex(sql, s.feed_a, posts, 3, s.user_a);
    await writeFeedPostsIndex(sql, s.feed_a, [{ ...posts[0]!, content: 'one again' }], 3, s.user_a);
    const rows = await sql`SELECT post_index, content_text, deleted, data FROM feed_posts WHERE feed_id = ${s.feed_a} ORDER BY post_index`;
    expect(rows.map((r) => [r.post_index, r.content_text, r.deleted])).toEqual([
      [3, 'one again', false],
      [4, 'two', true],
    ]);
    expect(rows[1]!.data).toEqual(posts[1]);
  });

  it('a feed_posts index failure is logged and swallowed', async () => {
    await setSettings(s.user_a, simple(1));
    await sql`ALTER TABLE feed_posts ADD CONSTRAINT feed_posts_test_block CHECK (post_index < 0) NOT VALID`;
    try {
      const { result, lines } = await run({ user_id: s.user_a });
      expect(result.status).toBe('complete');
      expect((await feedRow(result.feed_id))!.posts).toHaveLength(1);
      expect(logged(lines, 'feed_posts_index_sync_failed')[0]).toMatchObject({ feed_id: result.feed_id });
    } finally {
      await sql`ALTER TABLE feed_posts DROP CONSTRAINT feed_posts_test_block`;
    }
  });

  it('fans out one check_post_feed and one compute_preferences', async () => {
    await setSettings(s.user_a, simple(1));
    const { result } = await run({ user_id: s.user_a });
    const jobs = await sql`SELECT name, data FROM pgboss.job WHERE name IN ('check_post_feed', 'compute_preferences') ORDER BY name`;
    expect(jobs.map((j) => [j.name, j.data])).toEqual([
      ['check_post_feed', { feed_id: result.feed_id }],
      ['compute_preferences', { user_id: s.user_a }],
    ]);
  });

  it('a queue.send that throws does not fail the job', async () => {
    await setSettings(s.user_a, simple(1));
    const queue = {
      send: async () => {
        throw new Error('queue down');
      },
    } as unknown as JobQueue;
    const { result, lines } = await run({ user_id: s.user_a }, { queue });
    expect(result.status).toBe('complete');
    for (const msg of ['post_feed_alert_dispatch_failed', 'preference_recompute_dispatch_failed']) {
      expect(logged(lines, msg)).toHaveLength(1);
      expect(logged(lines, msg)[0]).toMatchObject({ error_type: 'Error', error: 'queue down' });
    }
  });

  it('no papers in scope: empty feed, no fan-out', async () => {
    const { result } = await run({ user_id: s.user_a, tag_filter: ['nothing'] });
    expect(result).toEqual({ status: 'complete', feed_id: result.feed_id, post_count: 0 });
    expect(await sql`SELECT 1 FROM pgboss.job WHERE name IN ('check_post_feed', 'compute_preferences')`).toHaveLength(0);
    expect((await feedRow(result.feed_id))!.tag_filter).toEqual(['nothing']);
  });

  it('abort: a never-settling LLM plus an aborted signal throws promptly and writes no feed row', async () => {
    await setSettings(s.user_a, simple(3));
    const ac = new AbortController();
    let abortedAt = 0;
    const f = fakeProviders({
      chat: (_b, info) => {
        if (info.purpose !== 'persona') return 'extends';
        setTimeout(() => {
          abortedAt = Date.now();
          ac.abort(new Error('cancelled'));
        }, 50);
        return new Promise<string>(() => undefined);
      },
    });
    const r = start({ user_id: s.user_a }, { providers: f.deps, signal: ac.signal });
    await expect(r.promise).rejects.toThrow('cancelled');
    expect(Date.now() - abortedAt).toBeLessThan(1000);
    expect(await feedRow(uuid5(`ficino:feed:${r.jobId}`))).toBeUndefined();
    expect(f.calls.filter(isPersonaCall)).toHaveLength(1);
    expect(logged(r.lines, 'feed_generation_failed')).toHaveLength(1);
  });

  it('is registered in HANDLERS', () => {
    expect(typeof HANDLERS.generate_feed).toBe('function');
  });
});
