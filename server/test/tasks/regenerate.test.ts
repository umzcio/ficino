import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { Post } from '../../src/feed/types.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { providerConfig } from '../../src/providers/config.js';
import { embedModelId } from '../../src/providers/embed.js';
import { LocalStorage } from '../../src/storage/local.js';
import { regeneratePost } from '../../src/tasks/regenerate.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, fakeVector, type FakeCall } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const storage = new LocalStorage(config, Buffer.from('k'.repeat(32)));
const MODEL = embedModelId(providerConfig({}, {}, config));

let s: Seeded;

type Line = Record<string, unknown> & { msg?: string };

async function seedChunks(paperId: string, userId: string) {
  const contents = Array.from({ length: 12 }, (_, i) => `Alpha One evidence ${i}: the effect held across cohorts.`);
  const vecs = contents.map((c) => `[${fakeVector(c, 1024).join(',')}]`);
  await sql`
    INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count, embedding, metadata)
    SELECT ${paperId}::uuid, ${userId}::uuid, 'results', t.c, (t.i - 1)::int, 12, t.v::vector,
           ${sql.json({ embed_model: MODEL })}
    FROM unnest(${contents}::text[], ${vecs}::text[]) WITH ORDINALITY AS t(c, v, i)`;
}

async function addFigure(paperId: string) {
  const id = randomUUID();
  await sql`
    INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, figure_index, figure_type,
                         caption, figure_number, data_claim, description)
    VALUES (${id}, ${paperId}, 2, ${`${paperId}/fig.png`}, 'detector', 0, 'chart_bar',
            'Share of turns by speaker.', '3', 'Turns cluster.', 'legacy description')`;
  return id;
}

const post = (i: number, extra: Record<string, unknown> = {}): Post => ({
  id: i + 1,
  time: `${i * 2}m`,
  persona: 'skeptic',
  post_type: 'post',
  content: `old content ${i}`,
  paper_ref: 'Old Ref',
  category: 'methods',
  _task_id: 'job-x',
  ...extra,
});

async function addFeed(userId: string, posts: Post[], corpusId: string | null = null) {
  const id = randomUUID();
  await sql`
    INSERT INTO feeds (id, user_id, corpus_id, posts, paper_count, post_count, generation_duration_ms)
    VALUES (${id}, ${userId}, ${corpusId}, ${sql.json(posts as never)}, 1, ${posts.length}, 0)`;
  await sql`
    INSERT INTO feed_posts (feed_id, user_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
    SELECT ${id}::uuid, ${userId}::uuid, (t.ord - 1)::int, t.value->>'content', 'skeptic', 'post', 'methods', 'Old Ref', t.value, false
    FROM jsonb_array_elements(${sql.json(posts as never)}) WITH ORDINALITY AS t(value, ord)`;
  return id;
}
const feedPosts = async (id: string) => ((await sql`SELECT posts FROM feeds WHERE id = ${id}`)[0]!.posts as Post[]);

async function regen(data: Parameters<typeof regeneratePost>[0], providers = fakeProviders()) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x)) });
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'regenerate_post', retryCount: 0, signal: new AbortController().signal },
    sql,
    logger,
    600_000,
    0,
  );
  const deps: WorkerDeps = {
    sql,
    config,
    env: {},
    logger,
    storage,
    queue: testQueue(),
    providers: providers.deps,
    rng: () => 0.5,
  };
  const result = await regeneratePost(data, ctx, deps);
  return { result, lines, calls: providers.calls };
}
const userPrompts = (calls: FakeCall[]) =>
  calls
    .filter((c) => c.kind !== 'ollama-embed')
    .map((c) => {
      const b = c.body as { messages: Array<{ role: string; content: string }> };
      return b.messages.find((m) => m.role === 'user')?.content ?? '';
    });

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  await sql`UPDATE papers SET title = 'Alpha One', authors = ${['Ada Alpha']}, year = 2024 WHERE id = ${s.paper_a}`;
  await seedChunks(s.paper_a, s.user_a);
});

describe('regenerate_post', () => {
  it('replaces a text post in place: id and time kept, regenerated set, others untouched, index synced', async () => {
    const posts = [post(0), post(1), post(2)];
    const feed = await addFeed(s.user_a, posts);
    const { result } = await regen({ feed_id: feed, post_index: 1, user_id: s.user_a });
    expect(result).toEqual({ status: 'complete', feed_id: feed, post_index: 1 });
    const after = await feedPosts(feed);
    expect(after).toHaveLength(3);
    expect(after[0]).toEqual(posts[0]);
    expect(after[2]).toEqual(posts[2]);
    expect(after[1]).toMatchObject({ id: 2, time: '2m', persona: 'skeptic', content: 'A grounded take.', regenerated: true });
    expect(after[1]).not.toHaveProperty('_task_id');
    expect(after[1]!.paper_ref).toBe('Alpha 2024');
    expect((after[1]!.sources as unknown[]).length).toBeGreaterThan(0);
    const [row] = await sql`SELECT content_text, data FROM feed_posts WHERE feed_id = ${feed} AND post_index = 1`;
    expect(row!.content_text).toBe('A grounded take.');
    expect(row!.data).toEqual(after[1]);
    const [other] = await sql`SELECT content_text FROM feed_posts WHERE feed_id = ${feed} AND post_index = 0`;
    expect(other!.content_text).toBe('old content 0');
  });

  it('regenerates a quote post with a post prompt', async () => {
    const feed = await addFeed(s.user_a, [post(0), post(1, { post_type: 'quote', quoted_post: { content: 'x' } })]);
    const { calls } = await regen({ feed_id: feed, post_index: 1, user_id: s.user_a });
    const prompts = userPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('PARENT POST');
    expect(prompts[0]).not.toContain('SPECIFIC extracted figure');
    expect(prompts[0]).toContain('"post_type": "post"');
  });

  it('deliberate change 1: a figure post is regenerated about its own figure with a fresh url', async () => {
    const fig = await addFigure(s.paper_a);
    const feed = await addFeed(s.user_a, [
      post(0, { post_type: 'figure', figure_id: fig, figure_url: '/figures/old?token=stale', figure_caption: 'old' }),
    ]);
    const { calls } = await regen({ feed_id: feed, post_index: 0, user_id: s.user_a });
    expect(userPrompts(calls)[0]).toContain('Share of turns by speaker');
    const [p] = await feedPosts(feed);
    expect(p).toMatchObject({
      id: 1,
      regenerated: true,
      figure_id: fig,
      figure_caption: 'Fig. 3, p.2 — Share of turns by speaker.. Alpha One',
    });
    expect(p!.figure_url).toMatch(new RegExp(`^/figures/${s.paper_a}/${fig}\\?token=`));
    expect(p!.figure_url).not.toContain('stale');
  });

  it('a figure post whose figure was deleted regenerates with a post prompt and does not throw', async () => {
    const fig = await addFigure(s.paper_a);
    const feed = await addFeed(s.user_a, [post(0, { post_type: 'figure', figure_id: fig })]);
    await sql`DELETE FROM figures WHERE id = ${fig}`;
    const { calls } = await regen({ feed_id: feed, post_index: 0, user_id: s.user_a });
    expect(userPrompts(calls)[0]).not.toContain('SPECIFIC extracted figure');
    const [p] = await feedPosts(feed);
    expect(p).toMatchObject({ regenerated: true, post_type: 'post' });
    expect(p).not.toHaveProperty('figure_url');
  });

  it('stores none of the server-owned fields a model reply sets (security review)', async () => {
    const feed = await addFeed(s.user_a, [post(0)]);
    const reply = JSON.stringify({
      post_type: 'figure',
      content: 'An injected take.',
      figure_url: 'https://attacker.example/x.png?d=leak',
      figure_id: randomUUID(),
      figure_caption: 'fake',
      audio_url: 'https://attacker.example/a.mp3',
      audio_key: 'k',
      deleted: true,
      likes: 1,
    });
    await regen({ feed_id: feed, post_index: 0, user_id: s.user_a }, fakeProviders({ chat: () => reply }));
    const [p] = await feedPosts(feed);
    expect(p).toMatchObject({ id: 1, post_type: 'post', content: 'An injected take.', regenerated: true });
    for (const k of ['figure_url', 'figure_id', 'figure_caption', 'audio_url', 'audio_key', 'deleted']) {
      expect(p).not.toHaveProperty(k);
    }
    expect(p!.likes).not.toBe(1);
  });

  it("another user's figure id is never loaded", async () => {
    const fig = await addFigure(s.paper_b);
    const feed = await addFeed(s.user_a, [post(0, { post_type: 'figure', figure_id: fig })]);
    const { calls } = await regen({ feed_id: feed, post_index: 0, user_id: s.user_a });
    expect(userPrompts(calls)[0]).not.toContain('Share of turns');
    expect((await feedPosts(feed))[0]).not.toHaveProperty('figure_id');
  });

  it("another user's feed throws not found and is unchanged", async () => {
    const feed = await addFeed(s.user_b, [post(0)]);
    const before = await feedPosts(feed);
    await expect(regen({ feed_id: feed, post_index: 0, user_id: s.user_a })).rejects.toThrow(`Feed ${feed} not found`);
    expect(await feedPosts(feed)).toEqual(before);
  });

  it('out-of-range index and missing persona throw the Python messages', async () => {
    const feed = await addFeed(s.user_a, [post(0), { id: 2, content: 'no persona' }]);
    await expect(regen({ feed_id: feed, post_index: 2, user_id: s.user_a })).rejects.toThrow(
      'Post index 2 out of range (feed has 2 posts)',
    );
    await expect(regen({ feed_id: feed, post_index: -1, user_id: s.user_a })).rejects.toThrow(
      'Post index -1 out of range (feed has 2 posts)',
    );
    await expect(regen({ feed_id: feed, post_index: 1, user_id: s.user_a })).rejects.toThrow(
      `Post at feed ${feed} index 1 has no persona — cannot regenerate`,
    );
  });

  it('no papers in the corpus throws', async () => {
    const empty = randomUUID();
    await sql`INSERT INTO corpora (id, user_id, name) VALUES (${empty}, ${s.user_a}, 'empty')`;
    const feed = await addFeed(s.user_a, [post(0)], empty);
    await expect(regen({ feed_id: feed, post_index: 0, user_id: s.user_a })).rejects.toThrow('No papers in corpus');
  });

  it('logs one embed_model_mismatch warning and ignores other-model chunks', async () => {
    await sql`UPDATE chunks SET metadata = ${sql.json({ embed_model: 'other' })} WHERE chunk_index < 3`;
    const feed = await addFeed(s.user_a, [post(0)]);
    const { lines } = await regen({ feed_id: feed, post_index: 0, user_id: s.user_a });
    const w = lines.filter((l) => l.msg === 'embed_model_mismatch');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ expected: MODEL, excluded_chunks: 3 });
  });

  it('is registered in HANDLERS', () => {
    expect(typeof HANDLERS.regenerate_post).toBe('function');
  });
});
