import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';
import type { Rng } from '../../src/shared/random.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { fakeProviders, type ChatInfo, type FakeCall } from '../helpers/fakeProviders.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const base = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' });
const OLLAMA = { ollamaBaseUrl: 'http://fake-ollama:11434' };
const as = (
  id = USER_A_ID,
  o: { config?: Record<string, unknown>; providers?: ProviderDeps; rng?: Rng } = {},
) => client(testApp({ user: user(id), config: { ...OLLAMA, ...o.config }, providers: o.providers, rng: o.rng }));

const turn = (role: string, content: string, extra: object = {}) => ({ role, content, ...extra });
const chats = (calls: FakeCall[]) => calls.filter((c) => c.kind === 'ollama-chat' || c.kind === 'anthropic');
const noSleep = (deps: ProviderDeps): ProviderDeps => ({ ...deps, sleep: async () => {} });
/** A fake that answers each purpose with `<purpose>-reply`. */
const byPurpose = (o: Parameters<typeof fakeProviders>[0] = {}) =>
  fakeProviders({ chat: (_b, i: ChatInfo) => `${i.purpose}-reply`, ...o });

const replyBody = (o: Record<string, unknown> = {}) => ({
  feed_id: seeded.feed_a,
  post_index: 0,
  persona_key: 'hype',
  user_message: 'hello there',
  post_content: 'some post content',
  ...o,
});
const zapBody = (o: Record<string, unknown> = {}) => ({
  feed_id: seeded.feed_a,
  post_index: 0,
  target_persona_key: 'skeptic',
  source_persona_key: 'hype',
  source_message: 'this is a breakthrough',
  post_content: 'some post content',
  ...o,
});

async function seedThread(feedId: string, personaKey: string, messages: unknown[], postIndex = 0) {
  await sql`INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
            VALUES (${feedId}, ${postIndex}, ${personaKey}, ${sql.json(messages as never)})`;
}
const storedRows = () => sql`SELECT id, feed_id, post_index, persona_key, messages FROM post_replies ORDER BY id`;

describe('POST /replies', () => {
  it('first reply creates the row with [user, persona] and no interjection keys', async () => {
    const fp = byPurpose();
    const r = await as(USER_A_ID, { providers: fp.deps }).post('/replies', replyBody());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Object.keys(j)).toEqual(['id', 'messages', 'latest_response']);
    expect(j.messages).toEqual([turn('user', 'hello there'), turn('persona', 'reply-reply')]);
    expect(j.latest_response).toBe('reply-reply');
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ persona_key: 'hype', post_index: 0, messages: j.messages });
    expect(String(rows[0]!.id)).toBe(j.id);
    const [call] = chats(fp.calls);
    const sent = (call!.body as any).messages;
    expect(sent[0].content).toContain('ORIGINAL POST CONTEXT:');
    expect(sent.slice(1)).toEqual([{ role: 'user', content: 'hello there' }]);
  });

  it('a second reply appends and the main persona sees the whole thread', async () => {
    await seedThread(seeded.feed_a, 'hype', [
      turn('user', 'q1'),
      turn('persona', 'a1'),
      turn('interjection', 'butting in', { persona: 'skeptic' }),
    ]);
    const fp = byPurpose();
    const j = await (await as(USER_A_ID, { providers: fp.deps }).post('/replies', replyBody({ user_message: 'q2' }))).json();
    expect(j.messages.map((m: any) => m.content)).toEqual(['q1', 'a1', 'butting in', 'q2', 'reply-reply']);
    const sent = (chats(fp.calls)[0]!.body as any).messages.slice(1);
    expect(sent).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: '[skeptic interjected]: butting in' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('an unknown persona falls back to "You are <key>"', async () => {
    const fp = byPurpose();
    expect((await as(USER_A_ID, { providers: fp.deps }).post('/replies', replyBody({ persona_key: 'ghost' }))).status).toBe(200);
    const system = (chats(fp.calls)[0]!.body as any).messages[0].content as string;
    expect(system.startsWith('You are ghost\n\nYou are replying to a user')).toBe(true);
    const [row] = await storedRows();
    expect(row!.persona_key).toBe('ghost');
  });

  it("another user's feed and a non-UUID feed_id are 404 Feed not found; nothing is called", async () => {
    const fp = byPurpose();
    const app = as(USER_A_ID, { providers: fp.deps });
    for (const feed_id of [seeded.feed_b, 'not-a-uuid']) {
      const r = await app.post('/replies', replyBody({ feed_id }));
      expect([r.status, (await r.json()).detail]).toEqual([404, 'Feed not found']);
    }
    expect(chats(fp.calls)).toHaveLength(0);
    expect(await storedRows()).toHaveLength(0);
  });

  it('body limits are code points: 2001 is 422, 2000 astral is fine; missing fields are 422', async () => {
    const fp = byPurpose();
    const app = as(USER_A_ID, { providers: fp.deps });
    expect((await app.post('/replies', replyBody({ user_message: 'a'.repeat(2001) }))).status).toBe(422);
    expect((await app.post('/replies', replyBody({ post_content: 'a'.repeat(4001) }))).status).toBe(422);
    expect((await app.post('/replies', replyBody({ paper_ref: 'a'.repeat(501) }))).status).toBe(422);
    expect((await app.post('/replies', { feed_id: seeded.feed_a })).status).toBe(422);
    expect((await app.post('/replies', replyBody({ post_index: 'x' }))).status).toBe(422);
    expect((await app.post('/replies', replyBody({ user_message: '😀'.repeat(2000), paper_ref: null }))).status).toBe(200);
  });

  describe('@mentions', () => {
    it('two known handles: 3 calls, interjections in mention order, row ends with both', async () => {
      const fp = byPurpose({ chat: (_b, i) => (i.purpose === 'mention' ? `mention:${/Respond as (.+)\.$/.exec(i.user)![1]}` : `${i.purpose}-reply`) });
      const r = await as(USER_A_ID, { providers: fp.deps }).post(
        '/replies',
        replyBody({ user_message: 'what do @stats_nerd and @skeptical_methods think?' }),
      );
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(chats(fp.calls)).toHaveLength(3);
      expect(Object.keys(j)).toEqual(['id', 'messages', 'latest_response', 'interjections']);
      expect(j.interjections).toEqual([
        { persona_key: 'methodologist', name: 'Stats Nerd', handle: '@stats_nerd', content: 'mention:Stats Nerd' },
        { persona_key: 'skeptic', name: 'Methods Skeptic', handle: '@skeptical_methods', content: 'mention:Methods Skeptic' },
      ]);
      const expected = [
        turn('user', 'what do @stats_nerd and @skeptical_methods think?'),
        turn('persona', 'reply-reply'),
        turn('interjection', 'mention:Stats Nerd', { persona: 'methodologist' }),
        turn('interjection', 'mention:Methods Skeptic', { persona: 'skeptic' }),
      ];
      expect(j.messages).toEqual(expected);
      expect((await storedRows())[0]!.messages).toEqual(expected);
    });

    it('Review Focus 5: ten distinct handles cost at most 4 LLM calls', async () => {
      const fp = byPurpose();
      const handles = ['stats_nerd', 'skeptical_methods', 'real_world_ml', 'phd_suffering', 'big_if_true', 'nobody1', 'nobody2', 'nobody3', 'nobody4', 'nobody5'];
      const r = await as(USER_A_ID, { providers: fp.deps }).post(
        '/replies',
        replyBody({ user_message: handles.map((h) => `@${h}`).join(' ') }),
      );
      expect(r.status).toBe(200);
      expect(chats(fp.calls).length).toBeLessThanOrEqual(4);
      expect(chats(fp.calls)).toHaveLength(4);
      expect((await r.json()).interjections.map((x: any) => x.persona_key)).toEqual(['methodologist', 'skeptic', 'practitioner']);
    });

    it("the replying persona's own handle is not a mention (key <> persona_key); unknown handles are skipped", async () => {
      const fp = byPurpose();
      const r = await as(USER_A_ID, { providers: fp.deps }).post(
        '/replies',
        replyBody({ persona_key: 'methodologist', user_message: '@stats_nerd and @nobody, thoughts?' }),
      );
      const j = await r.json();
      expect(r.status).toBe(200);
      expect(chats(fp.calls)).toHaveLength(1);
      expect(Object.keys(j)).toEqual(['id', 'messages', 'latest_response']);
    });

    it('an inactive persona is not a mention', async () => {
      await sql`UPDATE personas SET is_active = false WHERE key = 'methodologist'`;
      try {
        const fp = byPurpose();
        const j = await (await as(USER_A_ID, { providers: fp.deps }).post('/replies', replyBody({ user_message: '@stats_nerd?' }))).json();
        expect(chats(fp.calls)).toHaveLength(1);
        expect(j.interjections).toBeUndefined();
      } finally {
        await sql`UPDATE personas SET is_active = true WHERE key = 'methodologist'`;
      }
    });
  });

  describe('organic interjection', () => {
    const prior = [turn('user', 'preregistration matters here'), turn('persona', 'agreed')];

    it('rng 0.5 with two retrieval terms hit: interjection is returned and stored', async () => {
      await seedThread(seeded.feed_a, 'hype', prior);
      const fp = byPurpose();
      let rolls = 0;
      const rng = () => {
        rolls++;
        return 0.5;
      };
      const r = await as(USER_A_ID, { providers: fp.deps, rng }).post('/replies', replyBody({ user_message: 'and the confounds?' }));
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(rolls).toBe(1);
      expect(chats(fp.calls)).toHaveLength(2);
      expect(Object.keys(j)).toEqual(['id', 'messages', 'latest_response', 'interjection']);
      expect(j.interjection).toEqual({
        persona_key: 'skeptic',
        name: 'Methods Skeptic',
        handle: '@skeptical_methods',
        content: 'interjection-reply',
      });
      expect((await storedRows())[0]!.messages).toEqual([
        ...prior,
        turn('user', 'and the confounds?'),
        turn('persona', 'reply-reply'),
        turn('interjection', 'interjection-reply', { persona: 'skeptic' }),
      ]);
    });

    it('rng 0.9: no interjection and one call', async () => {
      await seedThread(seeded.feed_a, 'hype', prior);
      const fp = byPurpose();
      const j = await (await as(USER_A_ID, { providers: fp.deps, rng: () => 0.9 }).post('/replies', replyBody({ user_message: 'and the confounds?' }))).json();
      expect(chats(fp.calls)).toHaveLength(1);
      expect(Object.keys(j)).toEqual(['id', 'messages', 'latest_response']);
    });

    it('a first reply (one user turn) never rolls', async () => {
      const fp = byPurpose();
      let rolls = 0;
      await as(USER_A_ID, { providers: fp.deps, rng: () => (rolls++, 0) }).post(
        '/replies',
        replyBody({ user_message: 'preregistration and confounds' }),
      );
      expect(rolls).toBe(0);
      expect(chats(fp.calls)).toHaveLength(1);
    });

    it('a mention suppresses the organic interjection', async () => {
      await seedThread(seeded.feed_a, 'hype', prior);
      const fp = byPurpose();
      let rolls = 0;
      const j = await (await as(USER_A_ID, { providers: fp.deps, rng: () => (rolls++, 0) }).post(
        '/replies',
        replyBody({ user_message: 'and the confounds? @nobody' }),
      )).json();
      expect(rolls).toBe(0);
      expect(j.interjection).toBeUndefined();
    });

    it('deliberate change 3: a tie goes to the lower sort_order', async () => {
      // "effect size" + "sample size" hits skeptic (sort 0); "effect size" + "confidence interval" hits methodologist.
      await seedThread(seeded.feed_a, 'hype', [turn('user', 'effect size and sample size'), turn('persona', 'ok')]);
      await sql`UPDATE personas SET sort_order = -1 WHERE key = 'methodologist'`;
      try {
        const fp = byPurpose();
        const j = await (await as(USER_A_ID, { providers: fp.deps, rng: () => 0 }).post(
          '/replies',
          replyBody({ user_message: 'what about the confidence interval?' }),
        )).json();
        expect(j.interjection.persona_key).toBe('methodologist');
      } finally {
        await sql`UPDATE personas SET sort_order = 3 WHERE key = 'methodologist'`;
      }
    });

    it('an organic failure is dropped; the main reply is stored', async () => {
      await seedThread(seeded.feed_a, 'hype', prior);
      const fp = fakeProviders({
        chat: (_b, i) => {
          if (i.purpose === 'interjection') throw new Error('boom');
          return 'main';
        },
      });
      const r = await as(USER_A_ID, { providers: noSleep(fp.deps), rng: () => 0 }).post('/replies', replyBody({ user_message: 'and the confounds?' }));
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.interjection).toBeUndefined();
      expect((await storedRows())[0]!.messages.map((m: any) => m.role)).toEqual(['user', 'persona', 'user', 'persona']);
    });
  });

  describe('Review Focus 3: failures', () => {
    /** Answers 400 for the main reply's chat and delegates everything else. */
    const rejectMain = (deps: ProviderDeps): ProviderDeps => ({
      ...deps,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const sys = JSON.parse(String(init?.body ?? '{}')).messages?.[0]?.content ?? '';
        if (String(sys).includes('You are replying to a user')) return new Response('bad', { status: 400 });
        return deps.fetch(input, init);
      }) as typeof fetch,
    });

    it('main 400 is 502 and post_replies is unchanged (new and existing thread)', async () => {
      const fp = byPurpose();
      const app = as(USER_A_ID, { providers: rejectMain(fp.deps) });
      const r = await app.post('/replies', replyBody({ user_message: 'hi @stats_nerd' }));
      expect([r.status, (await r.json()).detail]).toEqual([502, 'LLM provider rejected our request.']);
      expect(await storedRows()).toHaveLength(0);

      await seedThread(seeded.feed_a, 'hype', [turn('user', 'q'), turn('persona', 'a')]);
      const r2 = await app.post('/replies', replyBody({ user_message: 'preregistration and confounds @stats_nerd' }));
      expect(r2.status).toBe(502);
      expect((await storedRows())[0]!.messages).toEqual([turn('user', 'q'), turn('persona', 'a')]);
    });

    it('a mention that throws is dropped; the main reply and the other mention are stored', async () => {
      const fp = fakeProviders({
        chat: (_b, i) => {
          if (i.purpose === 'mention' && i.user.includes('Respond as Stats Nerd')) throw new Error('mention down');
          return `${i.purpose}-reply`;
        },
      });
      const r = await as(USER_A_ID, { providers: noSleep(fp.deps) }).post(
        '/replies',
        replyBody({ user_message: '@stats_nerd @skeptical_methods' }),
      );
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.interjections.map((x: any) => x.persona_key)).toEqual(['skeptic']);
      expect((await storedRows())[0]!.messages).toEqual([
        turn('user', '@stats_nerd @skeptical_methods'),
        turn('persona', 'reply-reply'),
        turn('interjection', 'mention-reply', { persona: 'skeptic' }),
      ]);
    });

    it('every mention failing leaves no interjection(s) key', async () => {
      const fp = fakeProviders({
        chat: (_b, i) => {
          if (i.purpose === 'mention') throw new Error('down');
          return 'main';
        },
      });
      const j = await (await as(USER_A_ID, { providers: noSleep(fp.deps) }).post('/replies', replyBody({ user_message: '@stats_nerd' }))).json();
      expect(Object.keys(j)).toEqual(['id', 'messages', 'latest_response']);
    });

    // Ports test_error_contracts test_create_reply_main_persona_timeout_maps_to_504: 503 here (deliberate change 2).
    it('a TimeoutError from the provider is 503', async () => {
      const fp = fakeProviders();
      const deps: ProviderDeps = {
        ...noSleep(fp.deps),
        fetch: (async () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        }) as typeof fetch,
      };
      const r = await as(USER_A_ID, { providers: deps }).post('/replies', replyBody());
      expect([r.status, (await r.json()).detail]).toEqual([503, 'LLM provider unreachable. Try again in a moment.']);
      expect(await storedRows()).toHaveLength(0);
    });

    // Ports test_error_contracts test_create_reply_main_persona_bad_input_maps_to_400.
    it('a 200 whose body is not JSON is 400 Invalid input', async () => {
      const deps: ProviderDeps = {
        ...noSleep(fakeProviders().deps),
        fetch: (async () => new Response('not json at all', { status: 200 })) as typeof fetch,
      };
      const r = await as(USER_A_ID, { providers: deps }).post('/replies', replyBody());
      const j = await r.json();
      expect(r.status).toBe(400);
      expect(j.detail).toMatch(/^Invalid input: /);
      expect(await storedRows()).toHaveLength(0);
    });
  });

  it('two concurrent replies to the same post both land (4 turns)', async () => {
    const fp = byPurpose({ delayMs: 50 });
    const app = as(USER_A_ID, { providers: fp.deps });
    const [r1, r2] = await Promise.all([
      app.post('/replies', replyBody({ user_message: 'first' })),
      app.post('/replies', replyBody({ user_message: 'second' })),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    const msgs = rows[0]!.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(4);
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content).sort()).toEqual(['first', 'second']);
    // Each append is its own [user, persona] pair, never interleaved.
    expect(msgs.map((m) => m.role)).toEqual(['user', 'persona', 'user', 'persona']);
  });

  it('Review Focus 1: concurrent replies from two users never cross keys', async () => {
    for (const [id, key, model] of [[USER_A_ID, 'ka', 'model-a'], [USER_B_ID, 'kb', 'model-b']] as const) {
      await sql`INSERT INTO user_settings (user_id, settings) VALUES (${id}, ${sql.json({ llm_provider: 'api', anthropic_api_key: key, claude_model: model } as never)})`;
    }
    const fp = byPurpose({ delayMs: 50 });
    const a = as(USER_A_ID, { providers: fp.deps });
    const b = as(USER_B_ID, { providers: fp.deps });
    const sends: Promise<{ status: number }>[] = [];
    for (let i = 0; i < 4; i++) {
      sends.push(a.post('/replies', replyBody({ feed_id: seeded.feed_a, post_index: i, user_message: `from-a-${i} @stats_nerd` })));
      sends.push(b.post('/replies', replyBody({ feed_id: seeded.feed_b, post_index: i, user_message: `from-b-${i} @stats_nerd` })));
    }
    expect((await Promise.all(sends)).map((r) => r.status)).toEqual(Array(8).fill(200));
    const anth = fp.calls.filter((c) => c.kind === 'anthropic');
    expect(anth).toHaveLength(16);
    const lastUser = (c: FakeCall) => {
      const ms = (c.body as any).messages as Array<{ role: string; content: string }>;
      return ms.filter((m) => m.role === 'user').at(-1)!.content;
    };
    for (const c of anth) {
      const text = lastUser(c);
      expect(text.includes('from-a-') !== text.includes('from-b-')).toBe(true);
      expect([c.apiKey, c.model]).toEqual(text.includes('from-a-') ? ['ka', 'model-a'] : ['kb', 'model-b']);
    }
    expect(new Set(anth.map((c) => c.model))).toEqual(new Set(['model-a', 'model-b']));
  });
});

describe('POST /replies/zap', () => {
  it('an existing thread gets one appended interjection', async () => {
    await seedThread(seeded.feed_a, 'hype', [turn('user', 'q'), turn('persona', 'this is a breakthrough')]);
    const fp = byPurpose();
    const r = await as(USER_A_ID, { providers: fp.deps }).post('/replies/zap', zapBody());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Object.keys(j)).toEqual(['id', 'messages', 'persona_key', 'content']);
    const expected = [turn('user', 'q'), turn('persona', 'this is a breakthrough'), turn('interjection', 'zap-reply', { persona: 'skeptic' })];
    expect(j).toMatchObject({ persona_key: 'skeptic', content: 'zap-reply', messages: expected });
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messages).toEqual(expected);
    expect(rows[0]!.persona_key).toBe('hype');
    expect(String(rows[0]!.id)).toBe(j.id);
    const call = chats(fp.calls)[0]!;
    const sent = (call.body as any).messages;
    expect(sent[0].content).toContain('a specific point made by AI Breakthroughs.');
    expect(sent[1].content).toContain('Respond as Methods Skeptic (@skeptical_methods).');
  });

  it("with no thread, a row is created under the source persona's key", async () => {
    const fp = byPurpose();
    const j = await (await as(USER_A_ID, { providers: fp.deps }).post('/replies/zap', zapBody({ source_persona_key: 'practitioner' }))).json();
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.persona_key).toBe('practitioner');
    expect(j.messages).toEqual([turn('interjection', 'zap-reply', { persona: 'skeptic' })]);
    expect(String(rows[0]!.id)).toBe(j.id);
  });

  it('an unknown source persona prints its key; an inactive one still prints its name', async () => {
    const fp = byPurpose();
    const app = as(USER_A_ID, { providers: fp.deps });
    await app.post('/replies/zap', zapBody({ source_persona_key: 'ghost' }));
    expect((chats(fp.calls)[0]!.body as any).messages[0].content).toContain('a specific point made by ghost.');
    await sql`UPDATE personas SET is_active = false WHERE key = 'practitioner'`;
    try {
      await app.post('/replies/zap', zapBody({ source_persona_key: 'practitioner' }));
      expect((chats(fp.calls)[1]!.body as any).messages[0].content).toContain('a specific point made by Practitioner Pat.');
    } finally {
      await sql`UPDATE personas SET is_active = true WHERE key = 'practitioner'`;
    }
  });

  it('an unknown target is 404 Target persona not found', async () => {
    const fp = byPurpose();
    const r = await as(USER_A_ID, { providers: fp.deps }).post('/replies/zap', zapBody({ target_persona_key: 'ghost' }));
    expect([r.status, (await r.json()).detail]).toEqual([404, 'Target persona not found']);
    expect(chats(fp.calls)).toHaveLength(0);
  });

  it("user B's feed and a non-UUID feed_id are 404 Feed not found", async () => {
    const fp = byPurpose();
    const app = as(USER_A_ID, { providers: fp.deps });
    for (const feed_id of [seeded.feed_b, 'nope']) {
      const r = await app.post('/replies/zap', zapBody({ feed_id }));
      expect([r.status, (await r.json()).detail]).toEqual([404, 'Feed not found']);
    }
    expect(chats(fp.calls)).toHaveLength(0);
  });

  it('a zap failure is graded and appends nothing', async () => {
    const fp = fakeProviders();
    const deps: ProviderDeps = { ...fp.deps, fetch: (async () => new Response('bad', { status: 400 })) as typeof fetch };
    const app = as(USER_A_ID, { providers: deps });
    const r = await app.post('/replies/zap', zapBody());
    expect([r.status, (await r.json()).detail]).toEqual([502, 'LLM provider rejected our request.']);
    expect(await storedRows()).toHaveLength(0);
    await seedThread(seeded.feed_a, 'hype', [turn('user', 'q')]);
    expect((await app.post('/replies/zap', zapBody())).status).toBe(502);
    expect((await storedRows())[0]!.messages).toEqual([turn('user', 'q')]);
  });

  it('body limits are code points', async () => {
    const fp = byPurpose();
    const app = as(USER_A_ID, { providers: fp.deps });
    expect((await app.post('/replies/zap', zapBody({ source_message: 'a'.repeat(2001) }))).status).toBe(422);
    expect((await app.post('/replies/zap', zapBody({ source_message: '😀'.repeat(2000) }))).status).toBe(200);
  });
});

describe('reply rate-limit bucket', () => {
  const limited = (providers: ProviderDeps) =>
    as(USER_A_ID, { providers, config: { authProvider: 'basic', rateLimits: { ...base.rateLimits, reply: 1 } } });

  it('/replies and /replies/zap share the reply bucket', async () => {
    const app = limited(byPurpose().deps);
    expect((await app.post('/replies', replyBody())).status).toBe(200);
    const r = await app.post('/replies/zap', zapBody());
    expect(r.status).toBe(429);
    expect((await r.json()).detail).toMatch(/^Rate limit exceeded: 1 reply per 24h/);
  });

  it('a 422 body still uses up a slot', async () => {
    const app = limited(byPurpose().deps);
    expect((await app.post('/replies/zap', zapBody({ source_message: 'a'.repeat(2001) }))).status).toBe(422);
    expect((await app.post('/replies', replyBody())).status).toBe(429);
  });
});
