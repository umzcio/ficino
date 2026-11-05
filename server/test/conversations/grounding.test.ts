import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadConversationAndSources,
  loadGrounding,
  loadReplyContextChunks,
} from '../../src/conversations/grounding.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let s: Seeded;

async function addPaper(userId: string, corpusId: string, title: string, filename = 'x.pdf') {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, title, filename, file_path, status)
    VALUES (${id}, ${userId}, ${corpusId}, ${title}, ${filename}, '/tmp/x.pdf', 'complete')`;
  return id;
}
async function addChunk(paperId: string, userId: string, index: number, content: string, section = 'Methods') {
  const id = randomUUID();
  await sql`
    INSERT INTO chunks (id, paper_id, user_id, section, content, chunk_index)
    VALUES (${id}, ${paperId}, ${userId}, ${section}, ${content}, ${index})`;
  await sql`UPDATE chunks SET search_vector = to_tsvector('english', content) WHERE id = ${id}`;
  return id;
}
const base = { postContent: '', userMessage: '', paperRef: null as string | null };

let pa1: string;
let pa2: string;
let pb: string;
let a1: string[];

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  pa1 = await addPaper(USER_A_ID, s.workspace_a, 'Smith Sampling Study', 'smith.pdf');
  pa2 = await addPaper(USER_A_ID, s.workspace_a, 'Other Paper');
  pb = await addPaper(USER_B_ID, s.workspace_b, 'B Paper');
  a1 = [];
  for (let i = 0; i < 8; i++) a1.push(await addChunk(pa1, USER_A_ID, i, `convenience sampling detail ${i}`));
  await addChunk(pa2, USER_A_ID, 0, 'convenience sampling elsewhere');
});

describe('loadReplyContextChunks', () => {
  it('anchors resolve by chunk_id and ignore another user\'s chunk', async () => {
    const bChunk = await addChunk(pb, USER_B_ID, 0, 'secret');
    const out = await loadReplyContextChunks(sql, {
      ...base,
      userId: USER_A_ID,
      postSources: [{ chunk_id: a1[3] }, { chunk_id: bChunk }],
    });
    expect(out.map((c) => c.id)).toEqual([a1[3]]);
    expect(out[0]).toMatchObject({ paper_id: pa1, paper_title: 'Smith Sampling Study', paper_filename: 'smith.pdf' });
  });

  it('drift adds at most 5 more chunks from the anchor paper, no duplicates, none from other papers', async () => {
    const out = await loadReplyContextChunks(sql, {
      ...base,
      userId: USER_A_ID,
      userMessage: 'convenience sampling',
      postSources: [{ chunk_id: a1[0] }],
    });
    expect(out[0]!.id).toBe(a1[0]);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
    expect(out.every((c) => c.paper_id === pa1)).toBe(true);
  });

  it('resolves paper_ref via ILIKE when there are no sources', async () => {
    const out = await loadReplyContextChunks(sql, {
      ...base,
      userId: USER_A_ID,
      postSources: [],
      userMessage: 'convenience',
      paperRef: 'Smith et al. 2024',
    });
    expect(out.length).toBe(5);
    expect(out.every((c) => c.paper_id === pa1)).toBe(true);
  });

  it('escapes LIKE metacharacters in paper_ref', async () => {
    const lit = await addPaper(USER_A_ID, s.workspace_a, 'Big 50%_off Sale');
    await addChunk(lit, USER_A_ID, 0, 'zzz');
    const out = await loadReplyContextChunks(sql, {
      ...base,
      userId: USER_A_ID,
      postSources: [],
      userMessage: 'nomatchword',
      paperRef: '50%_off',
    });
    expect(out.map((c) => c.paper_id)).toEqual([lit]);
    const none = await loadReplyContextChunks(sql, {
      ...base,
      userId: USER_A_ID,
      postSources: [],
      userMessage: 'nomatchword',
      paperRef: '50xxoff',
    });
    expect(none).toEqual([]);
  });

  it('falls back to the first 5 chunks by chunk_index when drift finds nothing', async () => {
    const out = await loadReplyContextChunks(sql, {
      ...base,
      userId: USER_A_ID,
      postSources: [{ paper_id: pa1 }],
      userMessage: 'qqqqzzzz',
    });
    expect(out.map((c) => c.id)).toEqual(a1.slice(0, 5));
  });

  it('returns [] and empty text with no sources and no paperRef', async () => {
    const o = { ...base, userId: USER_A_ID, postSources: [], userMessage: 'convenience' };
    expect(await loadReplyContextChunks(sql, o)).toEqual([]);
    expect(await loadGrounding(sql, o)).toEqual({ chunks: [], chunksText: '' });
  });

  it('loadGrounding builds chunksText', async () => {
    const g = await loadGrounding(sql, { ...base, userId: USER_A_ID, postSources: [{ chunk_id: a1[1] }] });
    expect(g.chunks.length).toBe(1);
    expect(g.chunksText.startsWith('[Methods]\n')).toBe(true);
    expect(g.chunksText).toContain('convenience sampling detail 1');
  });
});

describe('loadConversationAndSources', () => {
  async function setPosts(feedId: string, posts: unknown[]) {
    await sql`UPDATE feeds SET posts = ${sql.json(posts as never)} WHERE id = ${feedId}`;
  }

  it('reads the thread and sources, dropping non-dict sources', async () => {
    await setPosts(s.feed_a, [{ sources: [{ chunk_id: 'c1' }, 'junk', 3, null, [1], { paper_id: 'p' }] }]);
    const rid = randomUUID();
    await sql`INSERT INTO post_replies (id, feed_id, post_index, persona_key, messages)
              VALUES (${rid}, ${s.feed_a}, 0, 'skeptic', ${sql.json([{ role: 'user', content: 'hi' }])})`;
    const out = await loadConversationAndSources(sql, USER_A_ID, s.feed_a, 0);
    expect(out.replyId).toBe(rid);
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(out.postSources).toEqual([{ chunk_id: 'c1' }, { paper_id: 'p' }]);
  });

  it('gives no thread and no sources when absent', async () => {
    const out = await loadConversationAndSources(sql, USER_A_ID, s.feed_a, 0);
    expect(out).toEqual({ replyId: null, messages: [], postSources: [] });
  });

  it("another user's feed gives empty sources but the thread is still read", async () => {
    await setPosts(s.feed_b, [{ sources: [{ chunk_id: 'c1' }] }]);
    const rid = randomUUID();
    await sql`INSERT INTO post_replies (id, feed_id, post_index, persona_key, messages)
              VALUES (${rid}, ${s.feed_b}, 0, 'skeptic', ${sql.json([{ role: 'user', content: 'x' }])})`;
    const out = await loadConversationAndSources(sql, USER_A_ID, s.feed_b, 0);
    expect(out.postSources).toEqual([]);
    expect(out.replyId).toBe(rid);
    expect(out.messages.length).toBe(1);
  });

  it('out-of-range index gives []', async () => {
    await setPosts(s.feed_a, [{ sources: [{ chunk_id: 'c1' }] }]);
    expect((await loadConversationAndSources(sql, USER_A_ID, s.feed_a, 99)).postSources).toEqual([]);
  });
});
