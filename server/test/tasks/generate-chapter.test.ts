import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { feedStatusFromJob } from '../../src/feed/status.js';
import type { Post } from '../../src/feed/types.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { providerConfig } from '../../src/providers/config.js';
import { embedModelId } from '../../src/providers/embed.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import { uuid5 } from '../../src/shared/uuid5.js';
import { LocalStorage } from '../../src/storage/local.js';
import { insertChapters } from '../../src/readingLists/chapters.js';
import { generateChapter, type GenerateChapterData } from '../../src/tasks/readingLists.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, fakeVector, type ChatInfo } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

// Plan 05 Task 4: generate_chapter against the DB with fake providers. Ports
// worker/tests/test_wave3_task_fixes.py::test_generate_chapter_writes_feed_posts_index and
// worker/tests/test_chapter_post_validation.py::test_reading_list_tasks_imports_validator, and pins deliberate
// changes 1 (figure slots), 2 (embed-model scope), 3 (one transaction), 4 (owner fallback, including the stub
// user for a NULL list owner) and 16 (abort, in a slot and after the loop).

const sql = testSql();
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const storage = new LocalStorage(config, Buffer.from('k'.repeat(32)));
const MODEL = embedModelId(providerConfig({}, {}, config));

type Line = Record<string, unknown> & { msg?: string };
let s: Seeded;
let personaKeys: string[] = [];
let a2: string;

async function addPaper(userId: string, title: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, title, authors, year, filename, file_path, status)
    VALUES (${id}, ${userId}, ${title}, ${['Ada Alpha']}, 2024, ${`${id}.pdf`}, ${`/papers/${id}.pdf`}, 'complete')`;
  return id;
}

async function addChunks(paperId: string, userId: string, title: string, n = 8, model = MODEL) {
  const contents = Array.from({ length: n }, (_, i) => `${title} evidence ${i}: the effect held across cohorts.`);
  const vecs = contents.map((c) => `[${fakeVector(c, 1024).join(',')}]`);
  await sql`
    INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count, embedding, metadata)
    SELECT ${paperId}::uuid, ${userId}::uuid, 'results', t.c, (t.i - 1)::int, 12, t.v::vector,
           ${sql.json({ embed_model: model })}
    FROM unnest(${contents}::text[], ${vecs}::text[]) WITH ORDINALITY AS t(c, v, i)`;
}

async function addFigure(paperId: string, figureType: string | null) {
  const id = randomUUID();
  await sql`
    INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, figure_index, figure_type,
                         caption, figure_number, data_claim, description)
    VALUES (${id}, ${paperId}, 2, ${`${paperId}/fig0.png`}, 'detector', 0, ${figureType},
            'Share of turns by speaker.', '3', 'Turns cluster.', 'legacy description')`;
  return id;
}

async function setSettings(userId: string, settings: Record<string, unknown>) {
  await sql`
    INSERT INTO user_settings (user_id, settings) VALUES (${userId}, ${sql.json(settings as never)})
    ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`;
}

const only = (...keys: string[]) => Object.fromEntries(personaKeys.map((k) => [k, keys.includes(k)]));
const weights = (w: Record<string, number>) => ({ post: 0, thread: 0, quote: 0, reply: 0, figure: 0, ...w });
/** One persona, plain posts only: n slots, all reaching the LLM. */
const simple = (n: number, extra: Record<string, unknown> = {}) => ({
  personas_enabled: only('skeptic'),
  post_type_weights: weights({ post: 1 }),
  posts_per_generation: n,
  ...extra,
});

async function seedList(userId: string, paperIds: string[], corpusId: string | null = null): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO reading_lists (id, user_id, corpus_id, name, paper_sequence)
    VALUES (${id}, ${userId}, ${corpusId}, 'L', ${paperIds}::uuid[])`;
  for (const [i, pid] of paperIds.entries()) {
    await sql`
      INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
      VALUES (${id}, ${i}, ${[pid]}::uuid[], ${i === 0 ? 'unlocked' : 'locked'})`;
  }
  return id;
}

const chapters = async (listId: string) =>
  [...(await sql`SELECT chapter_index, status, feed_id FROM reading_list_chapters
                  WHERE reading_list_id = ${listId} ORDER BY chapter_index`)].map((r) => ({ ...r }));
const feedRow = async (id: string) =>
  (await sql`SELECT * FROM feeds WHERE id = ${id}`)[0] as (Record<string, any> & { posts: Post[] }) | undefined;

type HarnessOpts = {
  chat?: (info: ChatInfo, n: number) => string | Promise<string>;
  controller?: AbortController;
  /** Called synchronously with each log line as the handler writes it. */
  onLog?: (line: Line) => void;
  storage?: LocalStorage;
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
  const infos: ChatInfo[] = [];
  const f = fakeProviders({
    chat: (_body, info) => {
      infos.push(info);
      return o.chat ? o.chat(info, infos.length) : '{"post_type": "post", "content": "A grounded take."}';
    },
  });
  const jobId = randomUUID();
  const ctx = makeJobContext(
    { id: jobId, name: 'generate_chapter', retryCount: 0, signal: (o.controller ?? new AbortController()).signal },
    sql,
    logger,
    600_000,
    2,
  );
  const deps: WorkerDeps = {
    sql,
    config,
    env: {},
    logger,
    storage: o.storage ?? storage,
    queue: testQueue(),
    providers: f.deps,
    rng: () => 0.5,
  };
  return {
    lines,
    infos,
    calls: f.calls,
    jobId,
    run: (data: GenerateChapterData) => generateChapter(data, ctx, deps) as Promise<Record<string, any>>,
  };
}
const logged = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg);

beforeAll(async () => {
  personaKeys = (await sql`SELECT key FROM personas`).map((r) => String(r.key));
});

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  await sql`UPDATE papers SET title = 'Alpha One', authors = ${['Ada Alpha']}, year = 2024 WHERE id = ${s.paper_a}`;
  a2 = await addPaper(s.user_a, 'Alpha Two');
  await addChunks(s.paper_a, s.user_a, 'Alpha One');
  await addChunks(a2, s.user_a, 'Alpha Two');
  await addChunks(s.paper_b, s.user_b, 'Beta One');
});

describe('generate_chapter', () => {
  it('is registered as the generate_chapter handler', () => {
    expect(HANDLERS.generate_chapter).toBeTypeOf('function');
  });

  it('happy path: deterministic feed, chapter complete, next unlocked, feed_posts index, chapter purpose', async () => {
    await setSettings(s.user_a, simple(3));
    const listId = await seedList(s.user_a, [s.paper_a, a2], s.workspace_a);
    const h = harness();
    const result = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });

    const feedId = uuid5(`ficino:chapter:${listId}:0`);
    expect(result).toEqual({ status: 'complete', feed_id: feedId, post_count: 3 });
    const feed = (await feedRow(feedId))!;
    expect(feed).toMatchObject({
      user_id: s.user_a,
      corpus_id: s.workspace_a,
      paper_count: 1,
      post_count: 3,
      generation_duration_ms: 0,
    });
    expect(feed.posts.map((p) => [p.id, p.time, p.persona])).toEqual([
      [1, '2m', 'skeptic'],
      [2, '4m', 'skeptic'],
      [3, '6m', 'skeptic'],
    ]);
    for (const p of feed.posts) {
      expect(p).not.toHaveProperty('_task_id');
      expect((p.sources as Array<{ paper_id: string }>).every((src) => src.paper_id === s.paper_a)).toBe(true);
    }
    expect(await chapters(listId)).toEqual([
      { chapter_index: 0, status: 'complete', feed_id: feedId },
      { chapter_index: 1, status: 'unlocked', feed_id: null },
    ]);
    const index = await sql`SELECT post_index, user_id, persona FROM feed_posts WHERE feed_id = ${feedId} ORDER BY post_index`;
    expect(index.map((r) => [r.post_index, r.user_id, r.persona])).toEqual([
      [0, s.user_a, 'skeptic'],
      [1, s.user_a, 'skeptic'],
      [2, s.user_a, 'skeptic'],
    ]);
    expect(h.infos).toHaveLength(3);
    expect(h.infos.every((i) => i.purpose === 'chapter')).toBe(true);
    expect(h.infos[0]!.system.endsWith('\nThis is Chapter 1 of a reading list. ')).toBe(true);
    expect(logged(h.lines, 'generate_chapter_complete')).toHaveLength(1);

    expect(
      feedStatusFromJob(h.jobId, { queue: 'generate_chapter', state: 'completed', progress: null, output: result }),
    ).toEqual({ status: 'complete', task_id: h.jobId, feed_id: feedId, post_count: 3, duration_ms: null });
  });

  it('chapter 1 is scoped to the cumulative papers and says so in the system prompt', async () => {
    await setSettings(s.user_a, simple(2));
    const listId = await seedList(s.user_a, [s.paper_a, a2]);
    await sql`UPDATE reading_list_chapters SET status = 'unlocked' WHERE reading_list_id = ${listId}`;
    const h = harness();
    const result = await h.run({ reading_list_id: listId, chapter_index: 1, user_id: s.user_a });
    const feed = (await feedRow(result.feed_id))!;
    expect(result.feed_id).toBe(uuid5(`ficino:chapter:${listId}:1`));
    expect(feed.paper_count).toBe(2);
    expect(feed.corpus_id).toBeNull();
    expect(h.infos[0]!.system).toContain(
      '\nThis is Chapter 2 of a reading list. The reader has already covered 1 prior paper(s). Build on that foundation — reference earlier papers when relevant.',
    );
    expect(logged(h.lines, 'chapter_scope')[0]).toMatchObject({ chapter_papers: 1, cumulative_papers: 2 });
  });

  it("the LLM call carries the owner's stored model and temperature, never another user's", async () => {
    await setSettings(s.user_a, simple(1, { ollama_llm_model: 'owner-model', persona_temperature: 0.42 }));
    await setSettings(s.user_b, simple(1, { ollama_llm_model: 'other-model' }));
    const listId = await seedList(s.user_a, [s.paper_a]);
    const h = harness();
    await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
    const chats = h.calls.filter((c) => c.kind === 'ollama-chat');
    expect(chats.map((c) => c.model)).toEqual(['owner-model']);
    expect(h.infos[0]!.temperature).toBe(0.42);
  });

  it("deliberate change 4: without a user_id the list's owner is the owner", async () => {
    await setSettings(s.user_a, simple(1));
    const listId = await seedList(s.user_a, [s.paper_a]);
    const h = harness();
    const result = await h.run({ reading_list_id: listId, chapter_index: 0 });
    expect((await feedRow(result.feed_id))!.user_id).toBe(s.user_a);
  });

  it('deliberate change 4: a list with a NULL owner and no user_id runs as the stub user', async () => {
    await sql`INSERT INTO users (id, email) VALUES (${STUB_USER_ID}, 'stub@ficino.dev') ON CONFLICT (id) DO NOTHING`;
    await setSettings(STUB_USER_ID, simple(1, { ollama_llm_model: 'stub-model' }));
    await setSettings(s.user_a, simple(1, { ollama_llm_model: 'owner-model' }));
    const listId = await seedList(s.user_a, [s.paper_a]);
    await sql`UPDATE reading_lists SET user_id = NULL WHERE id = ${listId}`;
    const h = harness();
    const result = await h.run({ reading_list_id: listId, chapter_index: 0 });
    expect(result).toMatchObject({ status: 'complete', post_count: 1 });
    // Python made the owner the string "None"; a dropped fallback would store a NULL user_id.
    expect((await feedRow(result.feed_id))!.user_id).toBe(STUB_USER_ID);
    expect(h.calls.filter((c) => c.kind === 'ollama-chat').map((c) => c.model)).toEqual(['stub-model']);
    const index = await sql`SELECT user_id FROM feed_posts WHERE feed_id = ${result.feed_id}`;
    expect(index.map((r) => r.user_id)).toEqual([STUB_USER_ID]);
  });

  it('a post without content is dropped (test_reading_list_tasks_imports_validator), leaving an id gap', async () => {
    await setSettings(s.user_a, simple(3));
    const listId = await seedList(s.user_a, [s.paper_a]);
    const h = harness({
      chat: (_info, n) => (n === 2 ? '{"post_type": "post", "paper_ref": "x"}' : '{"post_type": "post", "content": "Kept."}'),
    });
    const result = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
    expect(result.post_count).toBe(2);
    const posts = (await feedRow(result.feed_id))!.posts;
    expect(posts.map((p) => [p.id, p.time])).toEqual([
      [1, '2m'],
      [3, '6m'],
    ]);
    expect(posts.every((p) => p.content === 'Kept.')).toBe(true);
    expect(logged(h.lines, 'chapter_post_failed')).toMatchObject([{ error: 'persona_post_missing_content' }]);
  });

  describe('deliberate change 1: figure slots', () => {
    it('with no figures, figure slots are dropped and the chapter completes', async () => {
      await setSettings(s.user_a, simple(4, { post_type_weights: weights({ figure: 1 }) }));
      const listId = await seedList(s.user_a, [s.paper_a, a2]);
      const h = harness();
      const result = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
      expect(result.status).toBe('complete');
      expect(result.post_count).toBe(1); // the one opener; the 3 figure slots are dropped
      expect((await chapters(listId))[0]!.status).toBe('complete');
      expect(logged(h.lines, 'figure_post_skipped_no_figures_in_paper')).toHaveLength(3);
      const posts = (await feedRow(result.feed_id))!.posts;
      expect(posts.some((p) => p.post_type === 'figure')).toBe(false);
      expect(logged(h.lines, 'generate_chapter_failed')).toHaveLength(0);
    });

    it('an untyped figure is never eligible: the slot is dropped with the no-eligible event', async () => {
      await setSettings(s.user_a, simple(2, { post_type_weights: weights({ figure: 1 }) }));
      await addFigure(s.paper_a, null);
      const listId = await seedList(s.user_a, [s.paper_a]);
      const h = harness();
      const result = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
      expect(result.post_count).toBe(1);
      expect(logged(h.lines, 'figure_post_skipped_no_eligible_figure')).toMatchObject([
        { persona: 'skeptic', available_types: [] },
      ]);
    });

    it('a figure of an allowed type lands on the post with id, url and caption', async () => {
      await setSettings(s.user_a, simple(3, { post_type_weights: weights({ figure: 1 }) }));
      const fig = await addFigure(s.paper_a, 'chart_bar');
      await addFigure(s.paper_b, 'chart_bar'); // another user's paper, out of scope
      const listId = await seedList(s.user_a, [s.paper_a, a2]);
      const h = harness({
        chat: (info) =>
          info.user.includes('Analyze this SPECIFIC extracted figure')
            ? '{"post_type": "figure", "content": "Look at that bar."}'
            : '{"post_type": "post", "content": "Opener."}',
      });
      const result = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
      const posts = (await feedRow(result.feed_id))!.posts;
      const figurePosts = posts.filter((p) => p.figure_id);
      expect(figurePosts).toHaveLength(2);
      for (const p of figurePosts) {
        expect(p.figure_id).toBe(fig);
        expect(p.post_type).toBe('figure');
        expect(p.figure_url).toMatch(new RegExp(`^/figures/${s.paper_a}/${fig}\\?token=`));
        expect(p.figure_caption).toBe('Fig. 3, p.2 — Share of turns by speaker.. Alpha One');
      }
    });
  });

  describe('idempotency', () => {
    it('a second run returns idempotent: true and makes no LLM call', async () => {
      await setSettings(s.user_a, simple(2));
      const listId = await seedList(s.user_a, [s.paper_a]);
      const first = await harness().run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
      const h = harness();
      const second = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
      expect(second).toEqual({ status: 'complete', feed_id: first.feed_id, post_count: 2, idempotent: true });
      expect(h.calls).toHaveLength(0);
      expect(logged(h.lines, 'generate_chapter_idempotent_skip')).toMatchObject([
        { feed_id: first.feed_id, post_count: 2 },
      ]);
    });

    it('a chapter whose feed has 0 posts regenerates', async () => {
      await setSettings(s.user_a, simple(1));
      const listId = await seedList(s.user_a, [s.paper_a]);
      await sql`UPDATE reading_list_chapters SET feed_id = ${s.feed_a} WHERE reading_list_id = ${listId}`;
      const h = harness();
      const result = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
      expect(result).toEqual({ status: 'complete', feed_id: uuid5(`ficino:chapter:${listId}:0`), post_count: 1 });
      expect(h.infos).toHaveLength(1);
    });

    it("another user's feed on the chapter is not a skip", async () => {
      await setSettings(s.user_a, simple(1));
      const listId = await seedList(s.user_a, [s.paper_a]);
      await sql`UPDATE feeds SET post_count = 5 WHERE id = ${s.feed_b}`;
      await sql`UPDATE reading_list_chapters SET feed_id = ${s.feed_b} WHERE reading_list_id = ${listId}`;
      const h = harness();
      const result = await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
      expect(result.idempotent).toBeUndefined();
      expect(h.infos).toHaveLength(1);
    });
  });

  it('deliberate change 2: every in-scope chunk from another embed model fails before any LLM call', async () => {
    await setSettings(s.user_a, simple(2));
    await sql`UPDATE chunks SET metadata = ${sql.json({ embed_model: 'voyage:voyage-4-large@1024' })} WHERE paper_id = ${s.paper_a}`;
    const listId = await seedList(s.user_a, [s.paper_a, a2]);
    const h = harness();
    await expect(h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a })).rejects.toThrow(
      `No chunks embedded with ${MODEL}: 8 chunks in scope use a different embedding model. Re-process your papers or switch the embedding model back.`,
    );
    expect(h.calls).toHaveLength(0);
    expect(logged(h.lines, 'embed_model_mismatch')).toMatchObject([{ expected: MODEL, excluded_chunks: 8 }]);
    expect(logged(h.lines, 'generate_chapter_failed')).toHaveLength(1);
    expect(await feedRow(uuid5(`ficino:chapter:${listId}:0`))).toBeUndefined();
  });

  it('deliberate change 3: a failed unlock rolls back the feed and the complete mark', async () => {
    await setSettings(s.user_a, simple(2));
    const listId = await seedList(s.user_a, [s.paper_a, a2]);
    await sql`
      CREATE FUNCTION test_block_unlock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'unlock blocked'; END $$`;
    await sql`
      CREATE TRIGGER test_block_unlock BEFORE UPDATE ON reading_list_chapters
      FOR EACH ROW WHEN (NEW.status = 'unlocked') EXECUTE FUNCTION test_block_unlock()`;
    try {
      const h = harness();
      await expect(h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a })).rejects.toThrow(
        'unlock blocked',
      );
      expect(h.infos).toHaveLength(2);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_block_unlock ON reading_list_chapters`;
      await sql`DROP FUNCTION IF EXISTS test_block_unlock()`;
    }
    const feedId = uuid5(`ficino:chapter:${listId}:0`);
    expect(await feedRow(feedId)).toBeUndefined();
    expect(await sql`SELECT 1 FROM feed_posts WHERE feed_id = ${feedId}`).toHaveLength(0);
    expect(await chapters(listId)).toEqual([
      { chapter_index: 0, status: 'unlocked', feed_id: null },
      { chapter_index: 1, status: 'locked', feed_id: null },
    ]);
  });

  describe('deliberate change 20: a chapter rebuilt during generation commits nothing', () => {
    const rebuilt = async (listId: string, how: 'reorder' | 'repoint') => {
      if (how === 'reorder') {
        // What propose_ordering / apply-ordering do: every chapter deleted and rebuilt (new ids).
        await sql.begin(async (tx) => {
          await tx`DELETE FROM reading_list_chapters WHERE reading_list_id = ${listId}`;
          await insertChapters(tx, listId, [a2, s.paper_a]);
        });
      } else {
        await sql`
          UPDATE reading_list_chapters SET paper_ids = ${[a2]}::uuid[]
          WHERE reading_list_id = ${listId} AND chapter_index = 0`;
      }
    };

    it.each(['reorder', 'repoint'] as const)('%s: skipped, no feed, the rebuilt lock order intact', async (how) => {
      await setSettings(s.user_a, simple(2));
      const listId = await seedList(s.user_a, [s.paper_a, a2]);
      const h = harness({
        chat: async (_info, n) => {
          if (n === 1) await rebuilt(listId, how);
          return '{"post_type": "post", "content": "A grounded take."}';
        },
      });
      expect(await h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a })).toEqual({
        status: 'skipped',
        reason: 'chapter_rebuilt',
      });
      const feedId = uuid5(`ficino:chapter:${listId}:0`);
      expect(await feedRow(feedId)).toBeUndefined();
      expect(await sql`SELECT 1 FROM feed_posts WHERE feed_id = ${feedId}`).toHaveLength(0);
      expect(await chapters(listId)).toEqual([
        { chapter_index: 0, status: 'unlocked', feed_id: null },
        { chapter_index: 1, status: 'locked', feed_id: null },
      ]);
      expect(logged(h.lines, 'generate_chapter_rebuilt')).toHaveLength(1);
      expect(logged(h.lines, 'generate_chapter_complete')).toHaveLength(0);
    });
  });

  it('deliberate change 21: a regenerated chapter feed drops its old media state and files', async () => {
    const dirs = testStorageDirs();
    const media = new LocalStorage(dirs, Buffer.from('k'.repeat(32)));
    await setSettings(s.user_a, simple(1));
    const listId = await seedList(s.user_a, [s.paper_a]);
    const feedId = uuid5(`ficino:chapter:${listId}:0`);
    // An earlier run left an empty feed whose (empty) audio and podcast are ready.
    await sql`
      INSERT INTO feeds (id, user_id, posts, post_count, audio_status, audio_claimed_at, audio_generated_at,
                         podcast_status, podcast_claimed_at, podcast_generated_at, podcast_segments)
      VALUES (${feedId}, ${s.user_a}, '[]', 0, 'ready', NOW(), NOW(), 'ready', NOW(), NOW(), '[{"index":0}]')`;
    await sql`UPDATE reading_list_chapters SET feed_id = ${feedId} WHERE reading_list_id = ${listId}`;
    const episode = join(dirs.mediaDir, 'feeds', feedId, 'podcast', 'episode.mp3');
    mkdirSync(join(dirs.mediaDir, 'feeds', feedId, 'podcast'), { recursive: true });
    writeFileSync(episode, 'old');

    const result = await harness({ storage: media }).run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a });
    expect(result).toEqual({ status: 'complete', feed_id: feedId, post_count: 1 });
    const row = (await feedRow(feedId))!;
    expect(row.posts).toHaveLength(1);
    for (const col of [
      'audio_status',
      'audio_claimed_at',
      'audio_generated_at',
      'podcast_status',
      'podcast_claimed_at',
      'podcast_generated_at',
      'podcast_segments',
    ]) {
      expect(row[col], col).toBeNull();
    }
    expect(existsSync(join(dirs.mediaDir, 'feeds', feedId))).toBe(false);
  });

  it('a missing list or chapter throws the Python message', async () => {
    const missing = randomUUID();
    await expect(harness().run({ reading_list_id: missing, chapter_index: 0 })).rejects.toThrow(
      `Reading list ${missing} not found`,
    );
    const listId = await seedList(s.user_a, [s.paper_a]);
    const h = harness();
    await expect(h.run({ reading_list_id: listId, chapter_index: 5, user_id: s.user_a })).rejects.toThrow(
      'Chapter 5 not found',
    );
    expect(logged(h.lines, 'generate_chapter_failed')).toMatchObject([{ error: 'Chapter 5 not found' }]);
  });

  describe('deliberate change 16: an abort is never a per-slot failure', () => {
    it('an abort while answering the last slot fails the job and commits nothing', async () => {
      await setSettings(s.user_a, simple(3));
      const listId = await seedList(s.user_a, [s.paper_a, a2]);
      const controller = new AbortController();
      const h = harness({
        controller,
        chat: (_info, n) => {
          if (n === 3) controller.abort(new Error('job time limit'));
          return '{"post_type": "post", "content": "A grounded take."}';
        },
      });
      await expect(h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a })).rejects.toThrow();
      expect(h.infos).toHaveLength(3);
      expect(logged(h.lines, 'chapter_post_failed')).toHaveLength(0);
      expect(logged(h.lines, 'generate_chapter_failed')).toHaveLength(1);
      expect(await feedRow(uuid5(`ficino:chapter:${listId}:0`))).toBeUndefined();
      expect(await chapters(listId)).toEqual([
        { chapter_index: 0, status: 'unlocked', feed_id: null },
        { chapter_index: 1, status: 'locked', feed_id: null },
      ]);
    });

    it('an abort during a last slot that never calls the LLM still commits nothing (the after-loop check)', async () => {
      // Opener first, then 3 figure slots with no figures in scope: the last slot is dropped by the figure skip,
      // and its log line aborts the signal. No slot throws, so only the check after the loop stops the commit.
      await setSettings(s.user_a, simple(4, { post_type_weights: weights({ figure: 1 }) }));
      const listId = await seedList(s.user_a, [s.paper_a, a2]);
      const controller = new AbortController();
      let skips = 0;
      const h = harness({
        controller,
        onLog: (line) => {
          if (line.msg === 'figure_post_skipped_no_figures_in_paper' && ++skips === 3) {
            controller.abort(new Error('job time limit'));
          }
        },
      });
      await expect(h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a })).rejects.toThrow(
        'job time limit',
      );
      expect(skips).toBe(3);
      expect(h.infos).toHaveLength(1);
      expect(logged(h.lines, 'chapter_post_failed')).toHaveLength(0);
      expect(logged(h.lines, 'generate_chapter_failed')).toHaveLength(1);
      expect(await feedRow(uuid5(`ficino:chapter:${listId}:0`))).toBeUndefined();
      expect(await chapters(listId)).toEqual([
        { chapter_index: 0, status: 'unlocked', feed_id: null },
        { chapter_index: 1, status: 'locked', feed_id: null },
      ]);
    });

    it('the signal reaches the LLM call: a hung chat rejects promptly on abort', async () => {
      await setSettings(s.user_a, simple(2));
      const listId = await seedList(s.user_a, [s.paper_a]);
      const controller = new AbortController();
      const h = harness({
        controller,
        chat: () => {
          setTimeout(() => controller.abort(new Error('job time limit')), 20);
          return new Promise<string>(() => {});
        },
      });
      const started = Date.now();
      await expect(h.run({ reading_list_id: listId, chapter_index: 0, user_id: s.user_a })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(h.infos).toHaveLength(1);
      expect(logged(h.lines, 'chapter_post_failed')).toHaveLength(0);
      expect(await feedRow(uuid5(`ficino:chapter:${listId}:0`))).toBeUndefined();
    });
  });
});
