import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorage } from '../../src/storage/local.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { testBoss } from '../helpers/queue.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});
afterEach(() => vi.restoreAllMocks());

const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const as = (id: string = USER_A_ID) => client(testApp({ user: user(id) }));

const STALE = 'https://stale.example/persisted-30-day-token';

async function setPosts(feedId: string, posts: unknown[], extra: Record<string, unknown> = {}) {
  await sql`UPDATE feeds SET posts = ${sql.json(posts as never)}, post_count = ${posts.length} WHERE id = ${feedId}`;
  if (extra.audio_status !== undefined) await sql`UPDATE feeds SET audio_status = ${extra.audio_status as string} WHERE id = ${feedId}`;
  if (extra.podcast_status !== undefined) await sql`UPDATE feeds SET podcast_status = ${extra.podcast_status as string} WHERE id = ${feedId}`;
}

async function insertFigure(paperId: string, imagePath: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, description, claim_summary, figure_index)
            VALUES (${id}, ${paperId}, 1, ${imagePath}, 'image', 'desc', 'claim', 0)`;
  return id;
}

const FEED_KEYS = [
  'id', 'user_id', 'corpus_id', 'tag_filter', 'posts', 'generated_at', 'generation_duration_ms', 'paper_count',
  'post_count', 'audio_status', 'audio_generated_at', 'podcast_status', 'podcast_generated_at', 'podcast_segments',
  'podcast_audio_url',
];

describe('GET /feed/:id hydration', () => {
  it('test_figure_url_resigned_on_feed_get', async () => {
    const fig = await insertFigure(seeded.paper_a, 'usera/fig.png');
    await setPosts(seeded.feed_a, [{ post_type: 'figure', figure_id: fig, figure_url: STALE }]);
    const spy = vi.spyOn(LocalStorage.prototype, 'figureImageUrl').mockReturnValue('https://signed.example/fresh');
    const r = await as().get(`/feed/${seeded.feed_a}`);
    expect(r.status).toBe(200);
    expect((await r.json()).posts[0].figure_url).toBe('https://signed.example/fresh');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(seeded.paper_a, fig, 600);
  });

  it('test_other_users_figure_not_resigned', async () => {
    const fig = await insertFigure(seeded.paper_b, 'userb/fig.png');
    await setPosts(seeded.feed_a, [{ post_type: 'figure', figure_id: fig, figure_url: STALE }]);
    const spy = vi.spyOn(LocalStorage.prototype, 'figureImageUrl').mockReturnValue('x');
    const r = await as().get(`/feed/${seeded.feed_a}`);
    expect(r.status).toBe(200);
    expect((await r.json()).posts[0].figure_url).toBe(STALE);
    expect(spy).not.toHaveBeenCalled();
  });

  it('test_storage_error_keeps_persisted_url', async () => {
    const fig = await insertFigure(seeded.paper_a, 'usera/fig.png');
    await setPosts(seeded.feed_a, [{ post_type: 'figure', figure_id: fig, figure_url: STALE }]);
    vi.spyOn(LocalStorage.prototype, 'figureImageUrl').mockImplementation(() => {
      throw new Error('storage backend down');
    });
    const r = await as().get(`/feed/${seeded.feed_a}`);
    expect(r.status).toBe(200);
    expect((await r.json()).posts[0].figure_url).toBe(STALE);
  });

  it('test_no_figure_posts_no_signing', async () => {
    await setPosts(seeded.feed_a, [{ post_type: 'post', content: 'plain' }]);
    const spy = vi.spyOn(LocalStorage.prototype, 'figureImageUrl').mockImplementation(() => {
      throw new Error('should not be called');
    });
    const r = await as().get(`/feed/${seeded.feed_a}`);
    expect(r.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('test_get_feed_rejects_cross_user_read', async () => {
    const r = await as(USER_B_ID).get(`/feed/${seeded.feed_a}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Feed not found' });
  });

  it('404 for a non-uuid id and an unknown id', async () => {
    expect(await (await as().get('/feed/nope')).json()).toEqual({ detail: 'Not Found' });
    const r = await as().get(`/feed/${randomUUID()}`);
    expect(await r.json()).toEqual({ detail: 'Feed not found' });
  });

  it('test_feed_audio_url_hydrated_off_loop: audio_url set per post with audio_key when audio ready', async () => {
    await setPosts(
      seeded.feed_a,
      [{ content: 'a', audio_key: 'k0' }, { content: 'b' }, { content: 'c', audio_key: 'k2' }],
      { audio_status: 'ready' },
    );
    const spy = vi.spyOn(LocalStorage.prototype, 'audioUrl').mockImplementation((_f, i) => `/media/signed-${i}`);
    const j = await (await as().get(`/feed/${seeded.feed_a}`)).json();
    expect(j.posts[0].audio_url).toBe('/media/signed-0');
    expect(j.posts[1]).not.toHaveProperty('audio_url');
    expect(j.posts[2].audio_url).toBe('/media/signed-2');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('audio is not hydrated unless audio_status is ready; a storage throw gives null, not 500', async () => {
    await setPosts(seeded.feed_a, [{ audio_key: 'k0' }], { audio_status: 'pending' });
    const spy = vi.spyOn(LocalStorage.prototype, 'audioUrl').mockImplementation(() => {
      throw new Error('down');
    });
    let j = await (await as().get(`/feed/${seeded.feed_a}`)).json();
    expect(spy).not.toHaveBeenCalled();
    expect(j.posts[0]).not.toHaveProperty('audio_url');
    await sql`UPDATE feeds SET audio_status = 'ready' WHERE id = ${seeded.feed_a}`;
    const r = await as().get(`/feed/${seeded.feed_a}`);
    expect(r.status).toBe(200);
    j = await r.json();
    expect(j.posts[0].audio_url).toBeNull();
  });

  it('test_feed_podcast_episode_url_hydrated_off_loop: set when podcast ready, null on throw, null otherwise', async () => {
    await setPosts(seeded.feed_a, [], { podcast_status: 'ready' });
    vi.spyOn(LocalStorage.prototype, 'podcastEpisodeUrl').mockReturnValue('/media/ep.mp3?token=t');
    let j = await (await as().get(`/feed/${seeded.feed_a}`)).json();
    expect(j.podcast_audio_url).toBe('/media/ep.mp3?token=t');
    vi.restoreAllMocks();
    vi.spyOn(LocalStorage.prototype, 'podcastEpisodeUrl').mockImplementation(() => {
      throw new Error('down');
    });
    const r = await as().get(`/feed/${seeded.feed_a}`);
    expect(r.status).toBe(200);
    expect((await r.json()).podcast_audio_url).toBeNull();
    await sql`UPDATE feeds SET podcast_status = 'pending' WHERE id = ${seeded.feed_a}`;
    j = await (await as().get(`/feed/${seeded.feed_a}`)).json();
    expect(j.podcast_audio_url).toBeNull();
  });

  it('every Feed key is present; podcast_segments is null unless an array', async () => {
    const r = await as().get(`/feed/${seeded.feed_a}`);
    const j = await r.json();
    expect(Object.keys(j)).toEqual(FEED_KEYS);
    expect(j.podcast_segments).toBeNull();
    await sql`UPDATE feeds SET podcast_segments = ${sql.json([{ index: 0, speaker: 'a' }] as never)} WHERE id = ${seeded.feed_a}`;
    expect((await (await as().get(`/feed/${seeded.feed_a}`)).json()).podcast_segments).toEqual([{ index: 0, speaker: 'a' }]);
    await sql`UPDATE feeds SET podcast_segments = ${sql.json({ a: 1 } as never)} WHERE id = ${seeded.feed_a}`;
    expect((await (await as().get(`/feed/${seeded.feed_a}`)).json()).podcast_segments).toBeNull();
  });

  it('generated_at with zero microseconds has no fraction and ends in Z', async () => {
    await sql`UPDATE feeds SET generated_at = '2026-01-02 03:04:05+00' WHERE id = ${seeded.feed_a}`;
    expect((await (await as().get(`/feed/${seeded.feed_a}`)).json()).generated_at).toBe('2026-01-02T03:04:05Z');
    await sql`UPDATE feeds SET generated_at = '2026-01-02 03:04:05.5+00' WHERE id = ${seeded.feed_a}`;
    expect((await (await as().get(`/feed/${seeded.feed_a}`)).json()).generated_at).toBe('2026-01-02T03:04:05.500000Z');
  });
});

describe('GET /feed (list)', () => {
  it('key set equals the detail key set, media keys null; own feeds only', async () => {
    await setPosts(seeded.feed_a, [{ content: 'x', audio_key: 'k' }], { audio_status: 'ready', podcast_status: 'ready' });
    const list = await (await as().get('/feed')).json();
    expect(list.map((f: { id: string }) => f.id)).toEqual([seeded.feed_a]);
    const detail = await (await as().get(`/feed/${seeded.feed_a}`)).json();
    expect(Object.keys(list[0])).toEqual(Object.keys(detail));
    for (const k of ['audio_status', 'audio_generated_at', 'podcast_status', 'podcast_generated_at', 'podcast_segments', 'podcast_audio_url']) {
      expect(list[0][k]).toBeNull();
    }
    expect(list[0].posts[0]).not.toHaveProperty('audio_url');
  });

  it('summary=true gives posts [], summary=maybe gives 422', async () => {
    await setPosts(seeded.feed_a, [{ content: 'x' }]);
    const list = await (await as().get('/feed?summary=true')).json();
    expect(list[0].posts).toEqual([]);
    expect(list[0].post_count).toBe(1);
    const bad = await as().get('/feed?summary=maybe');
    expect(bad.status).toBe(422);
    expect((await bad.json()).detail[0].loc).toEqual(['query', 'summary']);
  });

  it('workspace_id filters on corpus_id', async () => {
    expect((await (await as().get(`/feed?workspace_id=${seeded.workspace_a}`)).json())).toHaveLength(1);
    expect((await (await as().get(`/feed?workspace_id=${seeded.workspace_b}`)).json())).toEqual([]);
  });

  it('ordered by generated_at desc and capped at 20', async () => {
    await sql`DELETE FROM feeds WHERE user_id = ${USER_A_ID}`;
    for (let i = 0; i < 22; i++) {
      await sql`INSERT INTO feeds (id, user_id, corpus_id, posts, post_count, generated_at)
                VALUES (${randomUUID()}, ${USER_A_ID}, ${seeded.workspace_a}, '[]'::jsonb, ${i},
                        '2026-01-01 00:00:00+00'::timestamptz + ${i} * interval '1 hour')`;
    }
    const list = await (await as().get('/feed')).json();
    expect(list).toHaveLength(20);
    expect(list.map((f: { post_count: number }) => f.post_count)).toEqual(Array.from({ length: 20 }, (_, i) => 21 - i));
  });
});

describe('DELETE /feed/:id/posts/:index', () => {
  const three = [{ content: 'a' }, { content: 'b' }, { content: 'c' }];

  it('204, marks deleted, syncs feed_posts, writes the audit row', async () => {
    await setPosts(seeded.feed_a, three);
    await sql`INSERT INTO feed_posts (feed_id, post_index, user_id, content_text) VALUES (${seeded.feed_a}, 1, ${USER_A_ID}, 'b')`;
    const r = await as().delete(`/feed/${seeded.feed_a}/posts/1`);
    expect(r.status).toBe(204);
    const [row] = await sql`SELECT posts FROM feeds WHERE id = ${seeded.feed_a}`;
    expect(row!.posts.map((p: { deleted?: boolean }) => p.deleted ?? false)).toEqual([false, true, false]);
    const [fp] = await sql`SELECT deleted FROM feed_posts WHERE feed_id = ${seeded.feed_a} AND post_index = 1`;
    expect(fp!.deleted).toBe(true);
    const audit = await sql`SELECT metadata, status_code, resource_id FROM audit_log WHERE action = 'feed.post.delete'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({ post_index: 1 });
    expect(audit[0]!.status_code).toBe(204);
    expect(audit[0]!.resource_id).toBe(seeded.feed_a);
  });

  it('test_delete_post_out_of_range_is_404_not_found: -1 and length give Post not found', async () => {
    await setPosts(seeded.feed_a, three);
    for (const i of [-1, 3]) {
      const r = await as().delete(`/feed/${seeded.feed_a}/posts/${i}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: 'Post not found' });
    }
  });

  it("another user's feed is 404 Feed not found", async () => {
    const r = await as(USER_B_ID).delete(`/feed/${seeded.feed_a}/posts/0`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Feed not found' });
  });

  it('two concurrent deletes on different indexes both stick', async () => {
    await setPosts(seeded.feed_a, three);
    const [a, b] = await Promise.all([
      as().delete(`/feed/${seeded.feed_a}/posts/0`),
      as().delete(`/feed/${seeded.feed_a}/posts/2`),
    ]);
    expect([a.status, b.status]).toEqual([204, 204]);
    const [row] = await sql`SELECT posts FROM feeds WHERE id = ${seeded.feed_a}`;
    expect(row!.posts.map((p: { deleted?: boolean }) => p.deleted ?? false)).toEqual([true, false, true]);
  });

  it('non-integer index is 422', async () => {
    expect((await as().delete(`/feed/${seeded.feed_a}/posts/x`)).status).toBe(422);
  });
});

describe('POST /feed/:id/regenerate/:index', () => {
  it('test_regenerate_post_out_of_range_is_404_not_found', async () => {
    await setPosts(seeded.feed_a, [{ content: 'a' }]);
    for (const i of [1, -1]) {
      const r = await as().post(`/feed/${seeded.feed_a}/regenerate/${i}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: 'Post not found' });
    }
    const other = await as(USER_B_ID).post(`/feed/${seeded.feed_a}/regenerate/0`);
    expect(await other.json()).toEqual({ detail: 'Feed not found' });
  });

  it('202 queues regenerate_post and writes the audit row', async () => {
    await setPosts(seeded.feed_a, [{ content: 'a' }, { content: 'b' }]);
    const r = await as().post(`/feed/${seeded.feed_a}/regenerate/1`);
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.status).toBe('queued');
    const b = await testBoss();
    const job = await b.getJobById('regenerate_post', j.task_id);
    expect(job?.data).toEqual({ feed_id: seeded.feed_a, post_index: 1, user_id: USER_A_ID });
    const audit = await sql`SELECT metadata, status_code FROM audit_log WHERE action = 'feed.post.regenerate'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({ post_index: 1, task_id: j.task_id });
    expect(audit[0]!.status_code).toBe(202);
  });
});
