import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { fakeProviders, type FakeProviderOpts } from '../helpers/fakeProviders.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const base = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' });
const OLLAMA = { ollamaBaseUrl: 'http://fake-ollama:11434' };
const as = (id = USER_A_ID, o: { config?: Record<string, unknown>; providers?: ReturnType<typeof fakeProviders>['deps'] } = {}) =>
  client(testApp({ user: user(id), config: { ...OLLAMA, ...o.config }, providers: o.providers }));

const turn = (role: string, content: string, extra: object = {}) => ({ role, content, ...extra });

describe('GET /personas', () => {
  it('returns the seeded actives in sort order with exactly the 7 keys', async () => {
    const r = await as().get('/personas');
    expect(r.status).toBe(200);
    const rows = await r.json();
    const expected = await sql`SELECT key FROM personas WHERE is_active = true ORDER BY sort_order`;
    expect(rows.map((x: any) => x.key)).toEqual(expected.map((x) => x.key));
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0])).toEqual(['key', 'handle', 'name', 'initials', 'color', 'avatar_url', 'bio']);
  });
});

async function seedReplies(feedId: string, personaKey: string, messages: unknown[], postIndex = 0) {
  await sql`INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
            VALUES (${feedId}, ${postIndex}, ${personaKey}, ${sql.json(messages as never)})`;
}

describe('stats and replies', () => {
  it('stats counts only the caller\'s threads', async () => {
    await seedReplies(seeded.feed_a, 'skeptic', []);
    await seedReplies(seeded.feed_b, 'skeptic', []);
    expect(await (await as().get('/personas/skeptic/stats')).json()).toEqual({ persona_key: 'skeptic', reply_threads: 1 });
    expect(await (await as(USER_A_ID).get('/personas/nobody/stats')).json()).toEqual({ persona_key: 'nobody', reply_threads: 0 });
  });

  it('replies: 0-based message_index, only matching interjections, parent post or {}', async () => {
    await sql`UPDATE feeds SET posts = ${sql.json([{ content: 'p0' }] as never)}, post_count = 1 WHERE id = ${seeded.feed_a}`;
    await seedReplies(seeded.feed_a, 'amplifier', [
      turn('user', 'hi'),
      turn('interjection', 'mine', { persona: 'skeptic' }),
      turn('interjection', 'other', { persona: 'amplifier' }),
      turn('persona', 'x', { persona: 'skeptic' }),
    ]);
    await seedReplies(seeded.feed_a, 'amplifier', [turn('interjection', 'beyond', { persona: 'skeptic' })], 5);
    await seedReplies(seeded.feed_b, 'amplifier', [turn('interjection', 'bs', { persona: 'skeptic' })]);
    const rows = await (await as().get('/personas/skeptic/replies')).json();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ feed_id: seeded.feed_a, post_index: 0, message_index: 1, content: 'mine', parent_post: { content: 'p0' } });
    expect(rows[0].thread_generated_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(rows[1]).toMatchObject({ post_index: 5, message_index: 0, content: 'beyond', parent_post: {} });
    expect(Object.keys(rows[0])).toEqual(['feed_id', 'post_index', 'message_index', 'content', 'thread_generated_at', 'parent_post']);
  });

  it('content is "" when the turn has none', async () => {
    await seedReplies(seeded.feed_a, 'amplifier', [{ role: 'interjection', persona: 'skeptic' }]);
    expect((await (await as().get('/personas/skeptic/replies')).json())[0].content).toBe('');
  });
});

describe('GET /personas/:key/dm', () => {
  it('no row: no id', async () => {
    expect(await (await as().get('/personas/skeptic/dm')).json()).toEqual({ messages: [], persona_key: 'skeptic' });
  });
  it('row: id, messages', async () => {
    await sql`INSERT INTO persona_dms (user_id, persona_key, messages) VALUES (${USER_A_ID}, 'skeptic', ${sql.json([turn('user', 'q')] as never)})`;
    const j = await (await as().get('/personas/skeptic/dm')).json();
    expect(Object.keys(j)).toEqual(['id', 'messages', 'persona_key']);
    expect(j.messages).toEqual([turn('user', 'q')]);
  });
});

describe('POST /personas/:key/dm', () => {
  it('first send creates the row, second appends; multi-turn history reaches the LLM', async () => {
    const fp = fakeProviders({ chat: (_b, i) => (i.purpose === 'dm' ? `reply ${i.messages.length}` : 'x') });
    const app = as(USER_A_ID, { providers: fp.deps });
    const r1 = await app.post('/personas/skeptic/dm', { message: 'one' });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.messages).toEqual([turn('user', 'one'), turn('persona', 'reply 1')]);
    expect(j1.latest_response).toBe('reply 1');
    const r2 = await app.post('/personas/skeptic/dm', { message: 'two' });
    const j2 = await r2.json();
    expect(j2.id).toBe(j1.id);
    expect(j2.messages).toHaveLength(4);
    const dmCalls = fp.calls.filter((c) => c.kind === 'ollama-chat');
    const last = (dmCalls[1]!.body as any).messages.filter((m: any) => m.role !== 'system');
    expect(last.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    const [row] = await sql`SELECT messages FROM persona_dms WHERE user_id = ${USER_A_ID}`;
    expect(row!.messages).toHaveLength(4);
  });

  it('2001 code points is 422; 2000 astral code points is fine', async () => {
    const fp = fakeProviders();
    const app = as(USER_A_ID, { providers: fp.deps });
    expect((await app.post('/personas/skeptic/dm', { message: 'a'.repeat(2001) })).status).toBe(422);
    expect((await app.post('/personas/skeptic/dm', { message: '😀'.repeat(2000) })).status).toBe(200);
  });

  it('unknown persona is 404 and under basic still uses a persona_dm slot', async () => {
    const fp = fakeProviders();
    const app = as(USER_A_ID, {
      providers: fp.deps,
      config: { authProvider: 'basic', rateLimits: { ...base.rateLimits, persona_dm: 1 } },
    });
    const r = await app.post('/personas/nobody/dm', { message: 'hi' });
    expect([r.status, (await r.json()).detail]).toEqual([404, 'Persona not found']);
    expect((await app.post('/personas/skeptic/dm', { message: 'hi' })).status).toBe(429);
  });

  it('rate limit: second send is 429', async () => {
    const fp = fakeProviders();
    const app = as(USER_A_ID, {
      providers: fp.deps,
      config: { authProvider: 'basic', rateLimits: { ...base.rateLimits, persona_dm: 1 } },
    });
    expect((await app.post('/personas/skeptic/dm', { message: 'hi' })).status).toBe(200);
    const r = await app.post('/personas/skeptic/dm', { message: 'hi again' });
    expect(r.status).toBe(429);
    expect((await r.json()).detail).toMatch(/^Rate limit exceeded: 1 persona_dm per 24h/);
  });

  describe('grounding', () => {
    async function chunk(paper: string, userId: string, content: string, idx: number, title = 'T') {
      await sql`UPDATE papers SET title = ${title} WHERE id = ${paper}`;
      await sql`INSERT INTO chunks (paper_id, user_id, section, content, chunk_type, chunk_index, token_count)
                VALUES (${paper}, ${userId}, 'Intro', ${content}, 'text', ${idx}, 5)`;
    }
    const systemOf = (fp: ReturnType<typeof fakeProviders>) =>
      (fp.calls.at(-1)!.body as any).messages.find((m: any) => m.role === 'system').content as string;

    it('matching terms pull the chunk; user B never appears', async () => {
      await chunk(seeded.paper_a, USER_A_ID, 'zebrafish regeneration is remarkable', 0, 'Fish Paper');
      await chunk(seeded.paper_a, USER_A_ID, 'unrelated opening', 1, 'Fish Paper');
      await chunk(seeded.paper_b, USER_B_ID, 'zebrafish secret of user b', 0, 'B Paper');
      const fp = fakeProviders();
      await as(USER_A_ID, { providers: fp.deps }).post('/personas/skeptic/dm', { message: 'zebrafish' });
      const s = systemOf(fp);
      expect(s).toContain('zebrafish regeneration');
      expect(s).toContain('Fish Paper');
      expect(s).not.toContain('unrelated opening');
      expect(s).not.toContain('user b');
    });

    it('"hi" falls back to the latest paper\'s first chunk', async () => {
      await chunk(seeded.paper_a, USER_A_ID, 'first chunk text', 0);
      await chunk(seeded.paper_a, USER_A_ID, 'second chunk text', 1);
      await chunk(seeded.paper_b, USER_B_ID, 'b chunk text', 0);
      const fp = fakeProviders();
      await as(USER_A_ID, { providers: fp.deps }).post('/personas/skeptic/dm', { message: 'hi' });
      const s = systemOf(fp);
      expect(s).toContain('first chunk text');
      expect(s).not.toContain('b chunk text');
    });

    it('no papers: says so', async () => {
      const fp = fakeProviders();
      await as(USER_A_ID, { providers: fp.deps }).post('/personas/skeptic/dm', { message: 'hi' });
      expect(systemOf(fp)).toContain('No papers in corpus yet.');
    });
  });

  it('Review Focus 3: a provider 503 x3 gives a graded 503 and writes nothing', async () => {
    const fp = fakeProviders();
    const failing = {
      ...fp.deps,
      sleep: async () => {},
      fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
    };
    const app = as(USER_A_ID, { providers: failing });
    const r = await app.post('/personas/skeptic/dm', { message: 'hi' });
    expect([r.status, (await r.json()).detail]).toEqual([503, 'LLM provider error. Try again in a moment.']);
    expect(await sql`SELECT 1 FROM persona_dms`).toHaveLength(0);

    await sql`INSERT INTO persona_dms (user_id, persona_key, messages) VALUES (${USER_A_ID}, 'skeptic', ${sql.json([turn('user', 'q')] as never)})`;
    expect((await app.post('/personas/skeptic/dm', { message: 'again' })).status).toBe(503);
    const [row] = await sql`SELECT messages FROM persona_dms`;
    expect(row!.messages).toEqual([turn('user', 'q')]);
  });

  it('Review Focus 1: concurrent DMs from two users never cross keys', async () => {
    for (const [id, key] of [[USER_A_ID, 'ka'], [USER_B_ID, 'kb']] as const) {
      await sql`INSERT INTO user_settings (user_id, settings) VALUES (${id}, ${sql.json({ llm_provider: 'api', anthropic_api_key: key } as never)})`;
    }
    const fp = fakeProviders({ delayMs: 50 });
    const a = as(USER_A_ID, { providers: fp.deps });
    const b = as(USER_B_ID, { providers: fp.deps });
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      sends.push(a.post('/personas/skeptic/dm', { message: `from-a-${i}` }));
      sends.push(b.post('/personas/skeptic/dm', { message: `from-b-${i}` }));
    }
    await Promise.all(sends);
    const anth = fp.calls.filter((c) => c.kind === 'anthropic');
    expect(anth).toHaveLength(8);
    const lastUser = (c: (typeof anth)[number]) => {
      const ms = (c.body as any).messages as Array<{ role: string; content: string }>;
      return ms.filter((m) => m.role === 'user').at(-1)!.content;
    };
    for (const c of anth) expect(c.apiKey).toBe(lastUser(c).startsWith('from-a') ? 'ka' : 'kb');
  });
});

describe('DELETE /personas/:key/dm/:message_index', () => {
  const seedDm = (n = 3) =>
    sql`INSERT INTO persona_dms (user_id, persona_key, messages)
        VALUES (${USER_A_ID}, 'skeptic', ${sql.json(Array.from({ length: n }, (_, i) => turn(i % 2 ? 'persona' : 'user', `m${i}`)) as never)})`;

  it('removes exactly the index, returns 200 messages, audits', async () => {
    await seedDm();
    const r = await as().delete('/personas/skeptic/dm/1');
    expect(r.status).toBe(200);
    expect((await r.json()).messages.map((m: any) => m.content)).toEqual(['m0', 'm2']);
    const [a] = await sql`SELECT metadata, resource_type FROM audit_log WHERE action = 'persona_dm.delete_message'`;
    expect(a!.resource_type).toBe('persona_dm');
    expect(a!.metadata).toEqual({ persona_key: 'skeptic', message_index: 1 });
  });

  it('out of range (-1 and 3) is 404', async () => {
    await seedDm();
    for (const i of [-1, 3]) {
      const r = await as().delete(`/personas/skeptic/dm/${i}`);
      expect([r.status, (await r.json()).detail]).toEqual([404, 'Message index out of range']);
    }
  });

  it('no thread is 404; non-int is 422', async () => {
    const r = await as().delete('/personas/skeptic/dm/0');
    expect([r.status, (await r.json()).detail]).toEqual([404, 'No DM thread with this persona']);
    expect((await as().delete('/personas/skeptic/dm/abc')).status).toBe(422);
  });

  it('is scoped to the caller', async () => {
    await seedDm();
    expect((await as(USER_B_ID).delete('/personas/skeptic/dm/0')).status).toBe(404);
  });

  it('test_delete_persona_dm_message_atomic: index 0 of one turn twice; the stored row is empty, then 404', async () => {
    await seedDm(1);
    const r1 = await as().delete('/personas/skeptic/dm/0');
    expect([r1.status, (await r1.json()).messages]).toEqual([200, []]);
    const [row] = await sql`SELECT messages FROM persona_dms WHERE user_id = ${USER_A_ID} AND persona_key = 'skeptic'`;
    expect(row!.messages).toEqual([]);
    const r2 = await as().delete('/personas/skeptic/dm/0');
    expect([r2.status, (await r2.json()).detail]).toEqual([404, 'Message index out of range']);
  });
});

it('DELETE /personas/:key/dm/:message_index: a clear between the SELECT and the UPDATE is 404, not 500', async () => {
  await sql`INSERT INTO persona_dms (user_id, persona_key, messages)
            VALUES (${USER_A_ID}, 'skeptic', ${sql.json([turn('user', 'm0')] as never)})`;
  // The route's sql, except that the thread is cleared just before the delete-message UPDATE runs.
  let raced = 0;
  const racing = new Proxy(sql, {
    apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
      if (Array.isArray(args[0]) && args[0].join('?').includes('UPDATE persona_dms SET messages = messages -')) {
        raced++;
        return sql`DELETE FROM persona_dms WHERE user_id = ${USER_A_ID} AND persona_key = 'skeptic'`.then(() =>
          Reflect.apply(target, thisArg, args),
        );
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  const r = await client(testApp({ user: user(USER_A_ID), config: OLLAMA, sql: racing })).delete('/personas/skeptic/dm/0');
  expect(raced).toBe(1);
  expect([r.status, (await r.json()).detail]).toEqual([404, 'No DM thread with this persona']);
  expect(await sql`SELECT 1 FROM audit_log WHERE action = 'persona_dm.delete_message'`).toHaveLength(0);
});

describe('DELETE /personas/:key/dm', () => {
  it('clears (200), audits, then 404', async () => {
    await sql`INSERT INTO persona_dms (user_id, persona_key, messages) VALUES (${USER_A_ID}, 'skeptic', '[]'::jsonb)`;
    const app = as();
    const r = await app.delete('/personas/skeptic/dm');
    expect([r.status, await r.json()]).toEqual([200, { messages: [] }]);
    const [a] = await sql`SELECT metadata FROM audit_log WHERE action = 'persona_dm.clear'`;
    expect(a!.metadata).toEqual({ persona_key: 'skeptic' });
    const r2 = await app.delete('/personas/skeptic/dm');
    expect([r2.status, (await r2.json()).detail]).toEqual([404, 'No DM thread with this persona']);
  });
});
