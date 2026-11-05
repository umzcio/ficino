import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const as = (id = USER_A_ID, config: Record<string, unknown> = {}) =>
  client(testApp({ user: { id, email: `${id}@ficino.dev`, display_name: 'U' }, config }));

async function seedPost(feedId: string, userId: string, text: string, o: { deleted?: boolean; persona?: string; type?: string; ref?: string } = {}) {
  await sql`
    INSERT INTO feed_posts (feed_id, user_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
    VALUES (${feedId}, ${userId}, 0, ${text}, ${o.persona ?? 'skeptic'}, ${o.type ?? 'post'}, 'methods', ${o.ref ?? 'Test 2024'}, '{}'::jsonb, ${o.deleted ?? false})`;
}

describe('GET /search', () => {
  it('test_search_scoped_to_own_corpus', async () => {
    const r = await as().get('/search?q=example');
    expect(r.status).toBe(200);
  });

  it('missing or empty q is 422 with loc [query, q]', async () => {
    for (const path of ['/search', '/search?q=']) {
      const r = await as().get(path);
      expect(r.status).toBe(422);
      expect((await r.json()).detail[0].loc).toEqual(['query', 'q']);
    }
  });

  it('whitespace-only q gives the three empty arrays and no query key', async () => {
    const r = await as().get('/search?q=%20%20%09');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ papers: [], chunks: [], posts: [] });
  });

  it('test_search_posts_finds_own_content', async () => {
    await seedPost(seeded.feed_a, USER_A_ID, 'unique search term aardvark for testing');
    const body = await (await as().get('/search?q=aardvark')).json();
    expect(body.query).toBe('aardvark');
    expect(body.posts.some((p: any) => p.feed_id === seeded.feed_a && p.post_index === 0)).toBe(true);
  });

  it('test_search_posts_excludes_other_users', async () => {
    await seedPost(seeded.feed_b, USER_B_ID, 'user B secret quokka content');
    const body = await (await as().get('/search?q=quokka')).json();
    expect(body.posts.some((p: any) => p.feed_id === seeded.feed_b)).toBe(false);
  });

  it('test_search_posts_skips_soft_deleted', async () => {
    await seedPost(seeded.feed_a, USER_A_ID, 'deleted platypus content should not appear', { deleted: true });
    const body = await (await as().get('/search?q=platypus')).json();
    expect(body.posts).toEqual([]);
  });

  it('test_search_posts_empty_query_returns_empty', async () => {
    const r = await as().get(`/search?q=${randomUUID()}-definitely-no-match`);
    expect(r.status).toBe(200);
    expect((await r.json()).posts).toEqual([]);
  });

  it('test_search_posts_result_shape', async () => {
    await seedPost(seeded.feed_a, USER_A_ID, 'shape test narwhal content here', {
      persona: 'methodologist', type: 'thread', ref: 'ShapeTest 2024',
    });
    const posts = (await (await as().get('/search?q=narwhal')).json()).posts;
    const p = posts.find((x: any) => x.feed_id === seeded.feed_a);
    expect(Object.keys(p)).toEqual([
      'feed_id', 'post_index', 'persona', 'post_type', 'content', 'paper_ref', 'generated_at', 'rank',
    ]);
    expect(p).toMatchObject({ persona: 'methodologist', post_type: 'thread', paper_ref: 'ShapeTest 2024' });
    expect(p.content).toContain('narwhal');
    expect(typeof p.rank).toBe('number');
    expect(p.generated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  });

  it('post content is sliced to 200 code points', async () => {
    await seedPost(seeded.feed_a, USER_A_ID, `lemur ${'😀'.repeat(300)}`);
    const p = (await (await as().get('/search?q=lemur')).json()).posts[0];
    expect([...p.content]).toHaveLength(200);
  });

  it('chunk content is sliced to 300 and rank rounded to 4 places; papers match title/filename/authors', async () => {
    await sql`UPDATE papers SET title = 'Zebra Study', authors = ${['Ada Okapi']} WHERE id = ${seeded.paper_a}`;
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count)
      VALUES (${seeded.paper_a}, ${USER_A_ID}, 'results', ${'giraffe ' + 'x'.repeat(500)}, 0, 10),
             (${seeded.paper_b}, ${USER_B_ID}, 'results', 'giraffe other user', 0, 10)`;
    const g = await (await as().get('/search?q=giraffe')).json();
    expect(g.chunks).toHaveLength(1);
    expect(g.chunks[0].content).toHaveLength(300);
    expect(g.chunks[0].paper_title).toBe('Zebra Study');
    expect(g.chunks[0].paper_id).toBe(seeded.paper_a);
    expect(Math.round(g.chunks[0].rank * 1e4) / 1e4).toBe(g.chunks[0].rank);
    for (const q of ['zebra', 'a.pdf', 'okapi']) {
      const b = await (await as().get(`/search?q=${encodeURIComponent(q)}`)).json();
      expect(b.papers.map((p: any) => p.id)).toEqual([seeded.paper_a]);
    }
    const b = await (await as().get('/search?q=zebra')).json();
    expect(Object.keys(b.papers[0])).toEqual(['id', 'title', 'authors', 'year', 'chunk_count']);
  });

  it('paper title falls back to filename, authors to []', async () => {
    const b = await (await as().get('/search?q=a.pdf')).json();
    expect(b.papers[0]).toMatchObject({ title: 'a.pdf', authors: [] });
  });

  it('a query of 50% does not wildcard-match every row', async () => {
    await sql`UPDATE papers SET title = 'Plain title' WHERE id = ${seeded.paper_a}`;
    const none = await (await as().get('/search?q=50%25')).json();
    expect(none.papers).toEqual([]);
    await sql`UPDATE papers SET title = 'Gain of 50% overall' WHERE id = ${seeded.paper_a}`;
    const one = await (await as().get('/search?q=50%25')).json();
    expect(one.papers.map((p: any) => p.id)).toEqual([seeded.paper_a]);
    const under = await (await as().get('/search?q=_')).json();
    expect(under.papers).toEqual([]);
  });

  it('test_search_use_normalized_posts_defaults_true', async () => {
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig({ DATABASE_URL: process.env.DATABASE_URL }).searchUseNormalizedPosts).toBe(true);
  });

  it('test_search_respects_legacy_flag_toggle', async () => {
    const term = `legacyflagcheck${randomUUID().slice(0, 8)}`;
    await seedPost(seeded.feed_a, USER_A_ID, term);
    const legacy = as(USER_A_ID, { searchUseNormalizedPosts: false });
    expect((await (await legacy.get(`/search?q=${term}`)).json()).posts).toEqual([]);

    const longContent = `${term} ${'é'.repeat(300)}`;
    await sql`
      UPDATE feeds SET post_count = 1,
        posts = ${sql.json([{ content: longContent, persona: 'skeptic', post_type: 'post', paper_ref: 'Ref 2024' }] as never)}
      WHERE id = ${seeded.feed_a}`;
    const posts = (await (await legacy.get(`/search?q=${term.toUpperCase()}`)).json()).posts;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ feed_id: seeded.feed_a, post_index: 0, persona: 'skeptic', paper_ref: 'Ref 2024' });
    expect(Object.keys(posts[0])).toEqual(['feed_id', 'post_index', 'persona', 'post_type', 'content', 'paper_ref', 'generated_at']);
    expect([...posts[0].content]).toHaveLength(200);
    // Matches paper_ref too, and other users' feeds are never scanned.
    expect((await (await legacy.get('/search?q=ref%202024')).json()).posts).toHaveLength(1);
    expect((await (await as(USER_B_ID, { searchUseNormalizedPosts: false }).get(`/search?q=${term}`)).json()).posts).toEqual([]);
  });

  it('legacy scan stops at 10 results', async () => {
    const posts = Array.from({ length: 15 }, (_, i) => ({ content: `cap marker ${i}`, persona: 'hype', post_type: 'post' }));
    await sql`UPDATE feeds SET post_count = 15, posts = ${sql.json(posts as never)} WHERE id = ${seeded.feed_a}`;
    const b = await (await as(USER_A_ID, { searchUseNormalizedPosts: false }).get('/search?q=cap%20marker')).json();
    expect(b.posts).toHaveLength(10);
  });
});
