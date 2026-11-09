// Every route that returns feed posts builds figure_url and audio_url from server-owned identifiers only: an owned
// figure_id re-signed, and an audio_key of the worker's own form under a ready feed. A stored URL string (written
// by the model before startPost kept only text fields, or restored from older data) is never echoed.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorage } from '../../src/storage/local.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});
afterEach(() => vi.restoreAllMocks());

const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const as = () => client(testApp({ user: user(USER_A_ID) }));

const EXTERNAL_IMG = 'https://example.invalid/x.png';
const EXTERNAL_MP3 = 'https://example.invalid/x.mp3';

async function setPosts(feedId: string, posts: unknown[], audioStatus: string | null = 'ready') {
  await sql`UPDATE feeds SET posts = ${sql.json(posts as never)}, post_count = ${posts.length},
                             audio_status = ${audioStatus} WHERE id = ${feedId}`;
}

async function insertFigure(paperId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, description, claim_summary, figure_index)
            VALUES (${id}, ${paperId}, 1, 'fig.png', 'image', 'desc', 'claim', 0)`;
  return id;
}

/** One interjection per post index, so /personas/skeptic/replies returns every post as a parent_post. */
async function replyTo(feedId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await sql`INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
              VALUES (${feedId}, ${i}, 'amplifier',
                      ${sql.json([{ role: 'interjection', persona: 'skeptic', content: `r${i}` }] as never)})`;
  }
}

type Post = Record<string, unknown>;

/** The posts each feed-post route returns for feed_a, in post order. */
async function postsByRoute(count: number): Promise<Record<string, Post[]>> {
  await replyTo(seeded.feed_a, count);
  const detail = await (await as().get(`/feed/${seeded.feed_a}`)).json();
  const list = await (await as().get('/feed')).json();
  const replies = await (await as().get('/personas/skeptic/replies')).json();
  const byIndex = [...replies].sort((a: Post, b: Post) => (a.post_index as number) - (b.post_index as number));
  return {
    'GET /feed/:id': detail.posts,
    'GET /feed': list.find((f: Post) => f.id === seeded.feed_a).posts,
    'GET /personas/:key/replies': byIndex.map((r: Post) => r.parent_post as Post),
  };
}

describe('stored media URLs are never echoed', () => {
  it('a stored external figure_url / audio_url, and a figure post with no figure_id, come back without them', async () => {
    await setPosts(seeded.feed_a, [
      { post_type: 'figure', content: 'a', figure_url: EXTERNAL_IMG, audio_url: EXTERNAL_MP3 },
      { post_type: 'post', content: 'b', figure_url: EXTERNAL_IMG, audio_url: EXTERNAL_MP3, audio_key: EXTERNAL_MP3 },
      { post_type: 'figure', content: 'c', figure_id: 'not-a-uuid', figure_url: EXTERNAL_IMG },
    ]);
    for (const [route, posts] of Object.entries(await postsByRoute(3))) {
      expect(posts, route).toHaveLength(3);
      for (const p of posts) {
        expect(p, route).not.toHaveProperty('figure_url');
        expect(p.audio_url ?? null, route).toBeNull();
        expect(p.post_type, route).toBe('post');
      }
      expect(posts.map((p) => p.content), route).toEqual(['a', 'b', 'c']);
    }
  });

  it("another user's figure is not signed, and its figure post is returned as a plain post", async () => {
    const fig = await insertFigure(seeded.paper_b);
    await setPosts(seeded.feed_a, [{ post_type: 'figure', figure_id: fig, figure_url: EXTERNAL_IMG }]);
    const spy = vi.spyOn(LocalStorage.prototype, 'figureImageUrl');
    for (const [route, [p]] of Object.entries(await postsByRoute(1))) {
      expect(p, route).not.toHaveProperty('figure_url');
      expect(p!.post_type, route).toBe('post');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('an owned figure is re-signed on every route', async () => {
    const fig = await insertFigure(seeded.paper_a);
    await setPosts(seeded.feed_a, [{ post_type: 'figure', figure_id: fig, figure_url: EXTERNAL_IMG }]);
    for (const [route, [p]] of Object.entries(await postsByRoute(1))) {
      expect(p!.post_type, route).toBe('figure');
      expect(String(p!.figure_url), route).toMatch(new RegExp(`^/figures/${seeded.paper_a}/${fig}\\?token=`));
    }
  });

  it("an owned figure whose signing fails keeps its type and gets no URL (the client's placeholder)", async () => {
    const fig = await insertFigure(seeded.paper_a);
    await setPosts(seeded.feed_a, [{ post_type: 'figure', figure_id: fig, figure_url: EXTERNAL_IMG }]);
    vi.spyOn(LocalStorage.prototype, 'figureImageUrl').mockImplementation(() => {
      throw new Error('storage backend down');
    });
    for (const [route, [p]] of Object.entries(await postsByRoute(1))) {
      expect(p!.post_type, route).toBe('figure');
      expect(p, route).not.toHaveProperty('figure_url');
    }
  });

  it("audio_url is built only from an audio_key of the worker's form, for that post, under a ready feed", async () => {
    const key = (i: number) => `feeds/${seeded.feed_a}/audio/post_${i}.mp3`;
    await setPosts(seeded.feed_a, [
      { content: 'own key', audio_key: key(0), audio_url: EXTERNAL_MP3 },
      { content: 'another post', audio_key: key(0) },
      { content: 'another feed', audio_key: `feeds/${seeded.feed_b}/audio/post_2.mp3` },
      { content: 'no key', audio_url: EXTERNAL_MP3 },
    ]);
    const routes = await postsByRoute(4);
    const detail = routes['GET /feed/:id']!;
    expect(String(detail[0]!.audio_url)).toMatch(new RegExp(`^/ficino/api/media/${key(0)}\\?token=`));
    for (const p of detail.slice(1)) expect(p.audio_url ?? null).toBeNull();
    // The list shape carries no media; the replies' parent posts are hydrated like the detail route.
    for (const p of routes['GET /feed']!) expect(p.audio_url ?? null).toBeNull();
    const replies = routes['GET /personas/:key/replies']!;
    expect(String(replies[0]!.audio_url)).toMatch(new RegExp(`^/ficino/api/media/${key(0)}\\?token=`));
    for (const p of replies.slice(1)) expect(p.audio_url ?? null).toBeNull();
  });

  it('no audio_url while the feed audio is not ready, even with a stored one', async () => {
    await setPosts(
      seeded.feed_a,
      [{ content: 'a', audio_key: `feeds/${seeded.feed_a}/audio/post_0.mp3`, audio_url: EXTERNAL_MP3 }],
      'generating',
    );
    for (const [route, [p]] of Object.entries(await postsByRoute(1))) expect(p!.audio_url ?? null, route).toBeNull();
  });

  it('non-object stored posts pass through; a missing parent post is still {}', async () => {
    await setPosts(seeded.feed_a, [null, 'text', { content: 'ok' }]);
    const detail = await (await as().get(`/feed/${seeded.feed_a}`)).json();
    expect(detail.posts).toEqual([null, 'text', { content: 'ok' }]);
    await sql`INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
              VALUES (${seeded.feed_a}, 9, 'amplifier',
                      ${sql.json([{ role: 'interjection', persona: 'skeptic', content: 'x' }] as never)})`;
    const replies = await (await as().get('/personas/skeptic/replies')).json();
    expect(replies[0].parent_post).toEqual({});
  });

  it('the stored row itself is not rewritten by a read', async () => {
    const stored = [{ post_type: 'figure', figure_url: EXTERNAL_IMG, audio_url: EXTERNAL_MP3 }];
    await setPosts(seeded.feed_a, stored);
    await postsByRoute(1);
    const [row] = await sql`SELECT posts FROM feeds WHERE id = ${seeded.feed_a}`;
    expect(row!.posts).toEqual(stored);
  });
});
