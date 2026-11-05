import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const as = (id = USER_A_ID) => client(testApp({ user: user(id) }));
const turn = (role: string, content: string, extra: object = {}) => ({ role, content, ...extra });

async function seedReplies(feedId: string, personaKey: string, messages: unknown[], postIndex = 0) {
  await sql`INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
            VALUES (${feedId}, ${postIndex}, ${personaKey}, ${sql.json(messages as never)})`;
}

describe('GET /replies/conversations', () => {
  it('is not swallowed by /:feed_id/:post_index', async () => {
    const r = await as().get('/replies/conversations');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('scopes to the caller', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', [turn('user', 'hi')]);
    expect(await (await as(USER_B_ID).get('/replies/conversations')).json()).toEqual([]);
    expect(await (await as(USER_A_ID).get('/replies/conversations')).json()).toHaveLength(1);
  });

  it('previews are the latest of each role, capped at 100, interjections excluded', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', [
      turn('user', 'first'),
      turn('persona', 'p1'),
      turn('user', 'u'.repeat(150)),
      turn('persona', 'latest persona'),
      turn('interjection', 'ignored', { persona: 'amplifier' }),
    ]);
    const [row] = await (await as().get('/replies/conversations')).json();
    expect(row.feed_id).toBe(seeded.feed_a);
    expect(typeof row.id).toBe('string');
    expect(row).toMatchObject({ post_index: 0, persona_key: 'skeptic', message_count: 5, last_persona_message: 'latest persona' });
    expect(row.last_user_message).toBe('u'.repeat(100));
    expect(row.updated_at).toMatch(/^\d{4}-\d\d-\d\dT.*\+00:00$/);
    expect(Object.keys(row)).toEqual(['id', 'feed_id', 'post_index', 'persona_key', 'message_count', 'last_user_message', 'last_persona_message', 'updated_at']);
  });

  it('empty previews are empty strings', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', []);
    const [row] = await (await as().get('/replies/conversations')).json();
    expect(row).toMatchObject({ message_count: 0, last_user_message: '', last_persona_message: '' });
  });
});

describe('GET /replies/replied-posts/:feed_id', () => {
  it('returns indices for own feed, [] for another user\'s or a malformed id', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', [], 2);
    await seedReplies(seeded.feed_a, 'skeptic', [], 0);
    expect((await (await as().get(`/replies/replied-posts/${seeded.feed_a}`)).json()).sort()).toEqual([0, 2]);
    expect(await (await as(USER_B_ID).get(`/replies/replied-posts/${seeded.feed_a}`)).json()).toEqual([]);
    const bad = await as().get('/replies/replied-posts/not-a-uuid');
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual([]);
  });
});

describe('GET /replies/:feed_id/:post_index', () => {
  it('returns the thread, and the empty shape for none or another user', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', [turn('user', 'hi')], 1);
    const mine = await (await as().get(`/replies/${seeded.feed_a}/1`)).json();
    expect(mine).toMatchObject({ messages: [turn('user', 'hi')], persona_key: 'skeptic' });
    expect(typeof mine.id).toBe('string');
    const empty = { messages: [], persona_key: null };
    expect(await (await as().get(`/replies/${seeded.feed_a}/0`)).json()).toEqual(empty);
    expect(await (await as(USER_B_ID).get(`/replies/${seeded.feed_a}/1`)).json()).toEqual(empty);
    expect(await (await as().get('/replies/not-a-uuid/1')).json()).toEqual(empty);
  });
});

describe('DELETE /replies/:feed_id/:post_index/message/:message_index', () => {
  const url = (f: string, p = 0, m = 0) => `/replies/${f}/${p}/message/${m}`;

  it('deletes a middle message with 204 and audits', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', [turn('user', 'a'), turn('persona', 'b'), turn('user', 'c')]);
    const r = await as().delete(url(seeded.feed_a, 0, 1));
    expect(r.status).toBe(204);
    const [row] = await sql`SELECT messages FROM post_replies WHERE feed_id = ${seeded.feed_a}`;
    expect(row!.messages).toEqual([turn('user', 'a'), turn('user', 'c')]);
    const [audit] = await sql`SELECT * FROM audit_log WHERE action = 'reply.delete_message'`;
    expect(audit).toMatchObject({ resource_type: 'reply', status_code: 204 });
    expect(audit!.metadata).toEqual({ feed_id: seeded.feed_a, post_index: 0, message_index: 1 });
  });

  it('404s in order: feed, thread, message', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', [turn('user', 'a')]);
    let r = await as(USER_B_ID).delete(url(seeded.feed_a));
    expect([r.status, await r.json()]).toEqual([404, { detail: 'Feed not found' }]);
    r = await as().delete(url('not-a-uuid'));
    expect([r.status, await r.json()]).toEqual([404, { detail: 'Feed not found' }]);
    r = await as().delete(url(seeded.feed_a, 3));
    expect([r.status, await r.json()]).toEqual([404, { detail: 'Reply thread not found' }]);
    r = await as().delete(url(seeded.feed_a, 0, 1));
    expect([r.status, await r.json()]).toEqual([404, { detail: 'Message not found' }]);
    r = await as().delete(url(seeded.feed_a, 0, -1));
    expect([r.status, await r.json()]).toEqual([404, { detail: 'Message not found' }]);
    const [row] = await sql`SELECT messages FROM post_replies WHERE feed_id = ${seeded.feed_a}`;
    expect(row!.messages).toHaveLength(1);
  });
});
