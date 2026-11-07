import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureStubUser } from '../../src/auth/bootstrap.js';
import {
  cleanupRestoredData,
  JSONB_ARRAY_COLUMNS,
  jsonbShapeViolations,
  type CleanupReport,
  type RestoreDb,
} from '../../src/restore/cleanup.js';
import { RestoreError } from '../../src/restore/errors.js';
import { DEFAULT_WORKSPACE_ID, STUB_USER_ID } from '../../src/shared/constants.js';
import { resetDb, testSql } from '../helpers/db.js';

const sql = testSql();
const SOURCE_MODEL = 'voyage:voyage-4-large@1024';
/** A user-id-shaped prefix, as the archive's storage keys carried; random, never a real id. */
const PREFIX = randomUUID();

type Post = Record<string, unknown>;

const run = (opts: { log?: pino.Logger } = {}): Promise<CleanupReport> =>
  sql.begin((tx) => cleanupRestoredData(tx, { sourceEmbedModel: SOURCE_MODEL, ...opts })) as Promise<CleanupReport>;

async function addPaper(filePath = 'x.pdf'): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
    VALUES (${id}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, 'p.pdf', ${filePath}, 'complete')`;
  return id;
}

async function addFeed(posts: Post[] | null, extra: { encoded?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const value = extra.encoded ? sql`to_jsonb(${JSON.stringify(posts)}::text)` : sql`${sql.json(posts as never)}`;
  await sql`
    INSERT INTO feeds (id, user_id, corpus_id, posts, post_count)
    VALUES (${id}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, ${value}, ${posts?.length ?? 0})`;
  return id;
}

async function feedPosts(feedId: string): Promise<Post[]> {
  const [row] = await sql`SELECT posts FROM feeds WHERE id = ${feedId}`;
  return row!.posts as Post[];
}

const audioKey = (feedId: string, i: number) => `feeds/${feedId}/audio/post_${i}.mp3`;
const signedUrl = 'https://x.supabase.co/storage/v1/object/sign/papers/f.png?token=t';

const zeroTransforms = {
  paths: { papers: 0, figures: 0 },
  jsonbDecoded: {},
  figureUrlsStripped: 0,
  audioKeysRekeyed: 0,
  legacyPodcastsCleared: 0,
  userPostsErrored: 0,
  synthesesHealed: 0,
  synthesesErrored: 0,
  summariesGenerating: 0,
  chunksTagged: 0,
};

beforeEach(async () => {
  await resetDb(sql);
  await ensureStubUser(sql);
});

describe('cleanupRestoredData', () => {
  it('rewrites file paths to the TS layout', async () => {
    const paper = randomUUID();
    await sql`
      INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
      VALUES (${paper}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, 'p.pdf', ${`${PREFIX}/${paper}.pdf`}, 'complete')`;
    await sql`
      INSERT INTO figures (paper_id, page_number, image_path, extraction_type, figure_index)
      VALUES (${paper}, 1, ${`${PREFIX}/${paper}/figures/fig_p1_1.png`}, 'vlm_detected', 0)`;

    const report = await run();

    const [p] = await sql`SELECT file_path FROM papers WHERE id = ${paper}`;
    const [f] = await sql`SELECT image_path FROM figures WHERE paper_id = ${paper}`;
    expect(p!.file_path).toBe(`/app/uploads/${paper}.pdf`);
    expect(f!.image_path).toBe(`/app/figures/${paper}/fig_p1_1.png`);
    expect(report.paths).toEqual({ papers: 1, figures: 1 });
  });

  it('strips figure_url and the user prefix from audio_key, keeping order', async () => {
    const feed = randomUUID();
    await sql`
      INSERT INTO feeds (id, user_id, corpus_id, posts, post_count)
      VALUES (${feed}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, ${sql.json([
        { content: 'a', figure_url: signedUrl, audio_key: `${PREFIX}/${audioKey(feed, 0)}` },
        { content: 'b' },
      ] as never)}, 2)`;

    const report = await run();

    expect(await feedPosts(feed)).toEqual([{ content: 'a', audio_key: audioKey(feed, 0) }, { content: 'b' }]);
    expect(report.figureUrlsStripped).toBe(1);
    expect(report.audioKeysRekeyed).toBe(1);
  });

  it('counts posts, not feeds', async () => {
    const one = randomUUID();
    const two = randomUUID();
    const media = (feed: string, i: number): Post => ({
      content: `p${i}`,
      figure_url: signedUrl,
      audio_key: `${PREFIX}/${audioKey(feed, i)}`,
    });
    for (const [id, posts] of [
      [one, [media(one, 0), media(one, 1), { content: 'p2' }]],
      [two, [media(two, 0)]],
    ] as const) {
      await sql`
        INSERT INTO feeds (id, user_id, corpus_id, posts, post_count)
        VALUES (${id}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, ${sql.json(posts as never)}, ${posts.length})`;
    }

    const report = await run();

    expect(report.figureUrlsStripped).toBe(3);
    expect(report.audioKeysRekeyed).toBe(3);
    expect((await feedPosts(one)).map((p) => p.audio_key ?? null)).toEqual([audioKey(one, 0), audioKey(one, 1), null]);
  });

  it('counts a post with only a figure_url or only a prefixed audio_key once in its own counter', async () => {
    const feed = randomUUID();
    await sql`
      INSERT INTO feeds (id, user_id, corpus_id, posts, post_count)
      VALUES (${feed}, ${STUB_USER_ID}, ${DEFAULT_WORKSPACE_ID}, ${sql.json([
        { content: 'a', figure_url: signedUrl },
        { content: 'b', audio_key: `${PREFIX}/${audioKey(feed, 1)}` },
        { content: 'c', audio_key: audioKey(feed, 2) },
      ] as never)}, 3)`;

    const report = await run();

    expect(report.figureUrlsStripped).toBe(1);
    expect(report.audioKeysRekeyed).toBe(1);
    expect(await feedPosts(feed)).toEqual([
      { content: 'a' },
      { content: 'b', audio_key: audioKey(feed, 1) },
      { content: 'c', audio_key: audioKey(feed, 2) },
    ]);
  });

  it('clears a legacy stitched podcast and keeps a single-episode one', async () => {
    const legacy = await addFeed([{ content: 'a' }]);
    const episode = await addFeed([{ content: 'a' }]);
    await sql`
      UPDATE feeds SET podcast_status = 'ready', podcast_generated_at = now(), podcast_claimed_at = now(),
        podcast_segments = ${sql.json([{ speaker: 'host_a', audio_key: `${PREFIX}/feeds/${legacy}/podcast/seg_0.mp3` }] as never)}
      WHERE id = ${legacy}`;
    await sql`
      UPDATE feeds SET podcast_status = 'ready', podcast_generated_at = now(),
        podcast_segments = ${sql.json([{ speaker: 'host_a' }] as never)}
      WHERE id = ${episode}`;

    const report = await run();

    const [l] = await sql`
      SELECT podcast_status, podcast_generated_at, podcast_segments, podcast_claimed_at FROM feeds WHERE id = ${legacy}`;
    expect(l).toEqual({ podcast_status: null, podcast_generated_at: null, podcast_segments: null, podcast_claimed_at: null });
    const [e] = await sql`SELECT podcast_status, podcast_segments FROM feeds WHERE id = ${episode}`;
    expect(e).toEqual({ podcast_status: 'ready', podcast_segments: [{ speaker: 'host_a' }] });
    expect(report.legacyPodcastsCleared).toBe(1);
    expect(report.audioKeysRekeyed).toBe(0);
  });

  it('decodes double-encoded jsonb arrays', async () => {
    const feed = await addFeed(
      [
        { content: 'a', figure_url: signedUrl },
        { content: 'b', audio_key: `${PREFIX}/feeds/f/audio/post_1.mp3` },
      ],
      { encoded: true },
    );
    await sql`
      INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
      VALUES (${feed}, 0, 'skeptic', to_jsonb(${'[{"role":"user","content":"hi"}]'}::text))`;

    const report = await run();

    const [r] = await sql`
      SELECT jsonb_typeof(messages) AS t, jsonb_array_length(messages) AS n FROM post_replies WHERE feed_id = ${feed}`;
    expect(r).toEqual({ t: 'array', n: 1 });
    expect(await feedPosts(feed)).toEqual([{ content: 'a' }, { content: 'b', audio_key: 'feeds/f/audio/post_1.mp3' }]);
    expect(report.jsonbDecoded).toEqual({ 'post_replies.messages': 1, 'feeds.posts': 1 });
    expect(report.figureUrlsStripped).toBe(1);
    expect(report.feedPosts).toBe(2);
  });

  it('a jsonb value that is neither an array nor an encoded array aborts', async () => {
    await sql`
      INSERT INTO persona_dms (user_id, persona_key, messages) VALUES (${STUB_USER_ID}, 'skeptic', ${sql.json({ a: 1 })})`;
    await sql`INSERT INTO papers (id, user_id, filename, file_path) VALUES (${randomUUID()}, ${STUB_USER_ID}, 'p', 'x')`;

    await expect(run()).rejects.toThrow(RestoreError);
    await expect(run()).rejects.toThrow(/persona_dms\.messages=1/);
    // The caller's transaction rolled back: nothing the earlier steps did survived.
    const [p] = await sql`SELECT file_path FROM papers`;
    expect(p!.file_path).toBe('x');
  });

  it('leaves an encoded string that is not an array, and names every bad column', async () => {
    await sql`
      INSERT INTO persona_dms (user_id, persona_key, messages)
      VALUES (${STUB_USER_ID}, 'skeptic', to_jsonb(${'{"a":1}'}::text))`;
    await sql`
      INSERT INTO user_posts (user_id, content, replies, status)
      VALUES (${STUB_USER_ID}, 'q', to_jsonb(${'not json ['}::text), 'complete')`;

    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect((err as Error).message).toBe('jsonb shape: persona_dms.messages=1, user_posts.replies=1');
  });

  it('sweeps stuck rows', async () => {
    const paper = await addPaper();
    await sql`INSERT INTO user_posts (user_id, content, status, task_id) VALUES (${STUB_USER_ID}, 'q', 'pending', 'celery-1')`;
    await sql`INSERT INTO user_posts (user_id, content, status) VALUES (${STUB_USER_ID}, 'q2', 'complete')`;
    const [healed] = await sql`
      INSERT INTO corpus_syntheses (user_id, name, paper_ids, messages, status, task_id)
      VALUES (${STUB_USER_ID}, 'g1', ${[paper]}::uuid[],
              ${sql.json([{ role: 'a', content: 'x' }, { role: 'b', content: 'y' }] as never)}, 'generating', 'celery-2')
      RETURNING id`;
    const [errored] = await sql`
      INSERT INTO corpus_syntheses (user_id, name, paper_ids, messages, status, task_id)
      VALUES (${STUB_USER_ID}, 'g2', ${[paper]}::uuid[], '[]'::jsonb, 'pending', 'celery-3')
      RETURNING id`;
    await sql`
      INSERT INTO paper_summaries (paper_id, messages, status, task_id) VALUES (${paper}, '[]'::jsonb, 'generating', 'celery-4')`;

    const report = await run();

    expect(await sql`SELECT content, status FROM user_posts ORDER BY content`).toEqual([
      { content: 'q', status: 'error' },
      { content: 'q2', status: 'complete' },
    ]);
    const [h] = await sql`SELECT status, task_id FROM corpus_syntheses WHERE id = ${healed!.id}`;
    expect(h).toEqual({ status: 'complete', task_id: null });
    const [e] = await sql`SELECT status, task_id FROM corpus_syntheses WHERE id = ${errored!.id}`;
    expect(e).toEqual({ status: 'error', task_id: null });
    const [s] = await sql`SELECT status, task_id FROM paper_summaries WHERE paper_id = ${paper}`;
    expect(s).toEqual({ status: 'generating', task_id: 'celery-4' });
    expect(report).toMatchObject({ userPostsErrored: 1, synthesesHealed: 1, synthesesErrored: 1, summariesGenerating: 1 });
  });

  it('tags only untagged chunks with the source model', async () => {
    const paper = await addPaper();
    const insert = (i: number, metadata: ReturnType<typeof sql.json> | null) => sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, metadata)
      VALUES (${paper}, ${STUB_USER_ID}, 's', ${`c${i}`}, ${i}, ${metadata})`;
    await insert(0, sql.json({}));
    await insert(1, null);
    await insert(2, sql.json({ embed_model: 'x', k: 1 }));

    const report = await run();

    expect((await sql`SELECT metadata FROM chunks ORDER BY chunk_index`).map((r) => r.metadata)).toEqual([
      { embed_model: SOURCE_MODEL },
      { embed_model: SOURCE_MODEL },
      { embed_model: 'x', k: 1 },
    ]);
    expect(report.chunksTagged).toBe(2);
  });

  it('tags a JSON-null chunk metadata and leaves a non-object one for verify to report', async () => {
    const paper = await addPaper();
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, metadata) VALUES
        (${paper}, ${STUB_USER_ID}, 's', 'a', 0, 'null'::jsonb),
        (${paper}, ${STUB_USER_ID}, 's', 'b', 1, '["embed_model"]'::jsonb),
        (${paper}, ${STUB_USER_ID}, 's', 'c', 2, '{"k":2}'::jsonb)`;

    const report = await run();

    expect((await sql`SELECT metadata FROM chunks ORDER BY chunk_index`).map((r) => r.metadata)).toEqual([
      { embed_model: SOURCE_MODEL },
      ['embed_model'],
      { k: 2, embed_model: SOURCE_MODEL },
    ]);
    expect(report.chunksTagged).toBe(2);
  });

  it('rebuilds feed_posts from the cleaned posts', async () => {
    const posts: Post[] = [
      { content: 'zero', persona: 'skeptic', post_type: 'take' },
      { content: 'one', persona: 'hype', figure_url: signedUrl, figure_id: 'f1' },
      { content: 'two', persona: 'skeptic', deleted: true },
    ];
    const feed = await addFeed(posts);
    await sql`
      INSERT INTO feed_posts (feed_id, user_id, post_index, content_text, data)
      VALUES (${feed}, ${STUB_USER_ID}, 7, 'stale', ${sql.json({ content: 'stale', figure_url: signedUrl })})`;

    const report = await run();

    const rows = await sql`
      SELECT post_index, content_text, persona, post_type, deleted, data FROM feed_posts
      WHERE feed_id = ${feed} ORDER BY post_index`;
    expect(rows.map((r) => r.post_index)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.content_text)).toEqual(['zero', 'one', 'two']);
    expect(rows[1]!.data).toEqual({ content: 'one', persona: 'hype', figure_id: 'f1' });
    expect(rows.map((r) => r.deleted)).toEqual([false, false, true]);
    expect(rows[0]).toMatchObject({ persona: 'skeptic', post_type: 'take' });
    expect(report.feedPosts).toBe(3);
  });

  it('skips non-object posts in the feed_posts rebuild and keeps the other posts at their array index', async () => {
    const feed = await addFeed([{ content: 'a' }, null as never, 'loose' as never, { content: 'd' }]);
    const log = captureLogger();

    const report = await run({ log: log.logger });

    expect(await sql`SELECT post_index, content_text FROM feed_posts WHERE feed_id = ${feed} ORDER BY post_index`).toEqual([
      { post_index: 0, content_text: 'a' },
      { post_index: 3, content_text: 'd' },
    ]);
    expect(report.feedPosts).toBe(2);
    expect(await feedPosts(feed)).toEqual([{ content: 'a' }, null, 'loose', { content: 'd' }]);
    expect(log.lines.find((l) => l.msg === 'restore_feed_posts_skipped')).toMatchObject({ non_object_posts: 2 });
  });

  it('is idempotent', async () => {
    const paper = await addPaper(`${PREFIX}/p.pdf`);
    await sql`
      INSERT INTO figures (paper_id, page_number, image_path, extraction_type, figure_index)
      VALUES (${paper}, 1, ${`${PREFIX}/${paper}/figures/fig_p1_1.png`}, 'vlm_detected', 0)`;
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, metadata)
      VALUES (${paper}, ${STUB_USER_ID}, 's', 'c', 0, '{}'::jsonb)`;
    const feed = await addFeed(
      [{ content: 'a', figure_url: signedUrl, audio_key: `${PREFIX}/feeds/f/audio/post_0.mp3` }, { content: 'b' }],
      { encoded: true },
    );
    await sql`
      UPDATE feeds SET podcast_status = 'ready',
        podcast_segments = ${sql.json([{ speaker: 'host_a', audio_key: 'k/seg_0.mp3' }] as never)} WHERE id = ${feed}`;
    await sql`INSERT INTO user_posts (user_id, content, status) VALUES (${STUB_USER_ID}, 'q', 'pending')`;
    await sql`
      INSERT INTO corpus_syntheses (user_id, name, paper_ids, messages, status)
      VALUES (${STUB_USER_ID}, 'g', ${[paper]}::uuid[], '[]'::jsonb, 'generating')`;

    const first = await run();
    expect(first.feedPosts).toBe(2);
    const before = await snapshot();
    const second = await run();

    expect(second).toEqual({ ...zeroTransforms, feedPosts: first.feedPosts });
    expect(await snapshot()).toEqual(before);
  });

  it('runs on a reserved connection inside an explicit transaction', async () => {
    await addFeed([{ content: 'a', figure_url: signedUrl }]);
    const conn = await sql.reserve();
    try {
      await conn`BEGIN`;
      const report = await cleanupRestoredData(conn, { sourceEmbedModel: SOURCE_MODEL });
      await conn`ROLLBACK`;
      expect(report.figureUrlsStripped).toBe(1);
    } finally {
      conn.release();
    }
    expect(await sql`SELECT count(*)::int AS n FROM feed_posts`).toEqual([{ n: 0 }]);
  });

  it('logs counts only, never row content', async () => {
    await addFeed([{ content: 'SECRET-CONTENT', figure_url: signedUrl }]);
    const log = captureLogger();

    const report = await run({ log: log.logger });

    const line = log.lines.find((l) => l.msg === 'restore_cleanup');
    expect(line).toMatchObject({ figureUrlsStripped: 1, feedPosts: 1 });
    expect(JSON.stringify(log.lines)).not.toContain('SECRET-CONTENT');
    expect(JSON.stringify(log.lines)).not.toContain('supabase');
    expect(report.feedPosts).toBe(1);
  });
});

describe('jsonbShapeViolations', () => {
  it('reports every listed column, zero or not, and ignores NULL', async () => {
    const feed = await addFeed([]);
    await sql`UPDATE feeds SET podcast_segments = NULL WHERE id = ${feed}`;
    await sql`
      INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
      VALUES (${feed}, 0, 'skeptic', to_jsonb('x'::text)), (${feed}, 1, 'skeptic', '{}'::jsonb)`;

    const counts = await sql.begin((tx: RestoreDb) => jsonbShapeViolations(tx));

    expect(Object.keys(counts).sort()).toEqual(JSONB_ARRAY_COLUMNS.map(([t, c]) => `${t}.${c}`).sort());
    expect(counts['post_replies.messages']).toBe(2);
    expect(Object.entries(counts).filter(([k]) => k !== 'post_replies.messages').every(([, n]) => n === 0)).toBe(true);
  });

  it('lists the columns the plan names', () =>
    expect(JSONB_ARRAY_COLUMNS.map(([t, c]) => `${t}.${c}`)).toEqual([
      'feeds.posts',
      'feeds.podcast_segments',
      'post_replies.messages',
      'persona_dms.messages',
      'paper_summaries.messages',
      'corpus_syntheses.messages',
      'user_posts.replies',
      'user_posts.sources',
      'reading_lists.rationale',
    ]));
});

type Line = Record<string, unknown> & { msg?: string };
function captureLogger() {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (s: string) => void lines.push(JSON.parse(s) as Line) });
  return { logger, lines };
}

/** Every row the cleanup can touch; feed_posts without its regenerated id and created_at. */
async function snapshot() {
  return {
    papers: await sql`SELECT id, file_path FROM papers ORDER BY id`,
    figures: await sql`SELECT id, image_path FROM figures ORDER BY id`,
    chunks: await sql`SELECT id, metadata FROM chunks ORDER BY id`,
    feeds: await sql`
      SELECT id, posts, podcast_status, podcast_generated_at, podcast_segments, podcast_claimed_at FROM feeds ORDER BY id`,
    feedPosts: await sql`
      SELECT feed_id, user_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted
      FROM feed_posts ORDER BY feed_id, post_index`,
    userPosts: await sql`SELECT id, status, task_id, replies, sources FROM user_posts ORDER BY id`,
    syntheses: await sql`SELECT id, status, task_id, messages FROM corpus_syntheses ORDER BY id`,
    replies: await sql`SELECT id, messages FROM post_replies ORDER BY id`,
  };
}
