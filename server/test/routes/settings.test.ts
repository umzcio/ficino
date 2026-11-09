import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { resolveSigningKey } from '../../src/shared/signedUrl.js';
import { LocalStorage } from '../../src/storage/local.js';
import { coercePy } from '../../src/routes/settings.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID } from '../helpers/db.js';
import { testQueue } from '../helpers/queue.js';
import { PUBLIC_ON } from '../helpers/publicDeployment.js';
import { BUILT_IN, LOCKED_NON_SECRET, pick, STALE_ROW } from '../helpers/lockedOverrides.js';
import { providerConfig } from '../../src/providers/config.js';

const sql = testSql();
let seeded: Awaited<ReturnType<typeof seedUsers>>;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

const userA = { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' };
const asA = (opts: Parameters<typeof testApp>[0] = {}) => client(testApp({ user: userA, ...opts }));

async function stored(userId = USER_A_ID) {
  const [row] = await sql`SELECT settings FROM user_settings WHERE user_id = ${userId}`;
  return row?.settings as Record<string, unknown> | undefined;
}
async function auditCount(action: string) {
  const [r] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE user_id = ${USER_A_ID} AND action = ${action}`;
  return r.n as number;
}

describe('coercePy', () => {
  it.each([
    ['int', 5, 5], ['int', 5.9, 5], ['int', '5', 5], ['int', true, 1],
    ['float', '0.5', 0.5], ['float', true, 1], ['float', 2, 2], ['int', -0.5, 0],
    ['int', ' 5 ', 5], ['float', '1e3', 1000], ['int', '1_0', 10], ['float', 'inf', Infinity],
  ])('coercePy(%s, %j) = %j', (k, v, out) => expect(coercePy(k as 'int', v)).toBe(out));
  it.each([['int', '5.9'], ['int', 'x'], ['float', 'x'], ['int', null], ['float', []], ['int', {}]])(
    'coercePy(%s, %j) throws',
    (k, v) => expect(() => coercePy(k as 'int', v)).toThrow(),
  );
});

describe('auth', () => {
  it('requires a user', async () => {
    const r = await client(testApp({ config: { authProvider: 'basic' } })).get('/settings');
    expect(r.status).toBe(401);
  });
});

describe('GET/PUT /settings', () => {
  it('GET returns defaults and ui keys (test_get_settings_returns_defaults_and_ui_keys)', async () => {
    const r = await asA().get('/settings');
    expect(r.status).toBe(200);
    const b = await r.json();
    for (const k of ['llm_provider', 'personas_enabled', 'posts_per_generation', 'theme', 'font_size', 'post_spacing', 'show_extraction_badge', 'rerank_provider', 'context_provider', 'voyage_embed_model', 'cohere_api_key']) {
      expect(b).toHaveProperty(k);
    }
  });

  it('PUT drops non-allowlisted keys (SSRF allow-list)', async () => {
    const r = await asA().put('/settings', { settings: { ollama_base_url: 'http://evil.example', theme: 'light' } });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).not.toHaveProperty('ollama_base_url');
    expect(b.theme).toBe('light');
    expect(await stored()).toEqual({ theme: 'light' });
  });

  it('secrets are redacted on PUT and GET', async () => {
    const c = asA();
    expect((await (await c.put('/settings', { settings: { anthropic_api_key: 'sk-test-123' } })).json()).anthropic_api_key).toBe('set');
    expect((await (await c.get('/settings')).json()).anthropic_api_key).toBe('set');
    expect((await stored())!.anthropic_api_key).toBe('sk-test-123');
  });

  it('cohere key is settable and redacted', async () => {
    const r = await asA().put('/settings', { settings: { cohere_api_key: 'co-test-123' } });
    expect(r.status).toBe(200);
    expect((await r.json()).cohere_api_key).toBe('set');
  });

  it('PUT with "set" stores it literally (reproduced)', async () => {
    await asA().put('/settings', { settings: { openai_api_key: 'set' } });
    expect((await stored())!.openai_api_key).toBe('set');
  });

  it('GET echoes unknown stored keys (preferences) and merges dicts one level', async () => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json({ preferences: { a: 1 }, personas_enabled: { skeptic: false } } as never)})`;
    const b = await (await asA().get('/settings')).json();
    expect(b.preferences).toEqual({ a: 1 });
    expect(b.personas_enabled).toEqual({ skeptic: false, hype: true, practitioner: true, methodologist: true, gradstudent: true });
  });

  it('PUT preserves stored unknown keys and merges dict values', async () => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json({ preferences: { a: 1 }, personas_enabled: { skeptic: false } } as never)})`;
    await asA().put('/settings', { settings: { personas_enabled: { hype: false } } });
    expect(await stored()).toEqual({ preferences: { a: 1 }, personas_enabled: { skeptic: false, hype: false } });
  });

  it('PUT out of bounds -> 422', async () => {
    const r = await asA().put('/settings', { settings: { posts_per_generation: 51 } });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ detail: 'posts_per_generation must be between 1 and 50' });
    const t = await asA().put('/settings', { settings: { persona_temperature: 2 } });
    expect(await t.json()).toEqual({ detail: 'persona_temperature must be between 0.0 and 1.5' });
  });

  it('PUT bad type -> 422', async () => {
    const r = await asA().put('/settings', { settings: { posts_per_generation: '5.5' } });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ detail: 'posts_per_generation must be a int' });
    const f = await asA().put('/settings', { settings: { persona_temperature: 'hot' } });
    expect(await f.json()).toEqual({ detail: 'persona_temperature must be a float' });
  });

  it('PUT float "nan" -> 422 must be a float', async () => {
    const r = await asA().put('/settings', { settings: { persona_temperature: 'nan' } });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ detail: 'persona_temperature must be a float' });
  });

  it('PUT coerces numerics', async () => {
    await asA().put('/settings', { settings: { posts_per_generation: 5.9, persona_temperature: '0.5' } });
    expect(await stored()).toEqual({ posts_per_generation: 5, persona_temperature: 0.5 });
  });

  it('PUT with non-dict settings -> 422', async () => {
    expect((await asA().put('/settings', { settings: [] })).status).toBe(422);
    expect((await asA().put('/settings', {})).status).toBe(422);
  });

  it('PUT __proto__ / constructor / prototype never reach storage', async () => {
    const raw = '{"settings": {"__proto__": {"x": 1}, "constructor": {"y": 1}, "prototype": 2, "theme": "light"}}';
    // Raw body: JSON.parse creates an OWN __proto__ property.
    const res = await testApp({ user: userA }).request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: 'ficino_csrf=test-csrf-token-fixture', 'x-csrf-token': 'test-csrf-token-fixture' },
      body: raw,
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Object.keys(b).sort()).toEqual(Object.keys(await (await asA().get('/settings')).json()).sort());
    expect(Object.hasOwn(b, '__proto__')).toBe(false);
    expect(({} as any).x).toBeUndefined();
    expect(await stored()).toEqual({ theme: 'light' });
    const [{ s }] = await sql`SELECT settings::text AS s FROM user_settings WHERE user_id = ${USER_A_ID}`;
    expect(s).not.toContain('__proto__');
  });

  it('GET ignores an own __proto__ key in a stored row', async () => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, '{"__proto__": {"x": 1}, "theme": "light"}'::jsonb)`;
    const b = await (await asA().get('/settings')).json();
    expect(b.theme).toBe('light');
    expect(Object.hasOwn(b, '__proto__')).toBe(false);
  });

  it('isolates users', async () => {
    await asA().put('/settings', { settings: { theme: 'light' } });
    expect(await stored(USER_B_ID)).toBeUndefined();
  });
});

describe('PUBLIC_DEPLOYMENT', () => {
  it('PUT drops provider keys silently, keeps others, never persists them', async () => {
    const r = await asA({ config: { publicDeployment: true } }).put('/settings', {
      settings: { llm_provider: 'ollama', anthropic_api_key: 'sk-evil', auto_generate_on_upload: true },
    });
    expect(r.status).toBe(200);
    expect(await stored()).toEqual({ auto_generate_on_upload: true });
    const g = await (await asA().get('/settings')).json();
    expect(g.auto_generate_on_upload).toBe(true);
    expect(['ollama', 'api']).toContain(g.llm_provider);
  });

  it('self-host accepts provider overrides', async () => {
    const c = asA({ config: { publicDeployment: false } });
    expect((await c.put('/settings', { settings: { llm_provider: 'api' } })).status).toBe(200);
    expect((await (await c.get('/settings')).json()).llm_provider).toBe('api');
  });

  it('GET reasserts operator env over a stale row (env check)', async () => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, '{"llm_provider": "ollama"}'::jsonb)`;
    const key = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
    const pub = createApp({
      sql,
      queue: testQueue(),
      config: loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' }),
      logger: pino({ level: 'silent' }),
      storage: new LocalStorage({ uploadDir: '/nonexistent/u', figuresDir: '/nonexistent/f', mediaDir: '/nonexistent/m' }, key),
      signingKey: key,
      env: { PUBLIC_DEPLOYMENT: 'true', LLM_PROVIDER: 'api' },
      userOverride: userA,
    });
    const r = await client(pub).get('/settings');
    expect((await r.json()).llm_provider).toBe('api');
  });

  it.each(PUBLIC_ON)('PUBLIC_DEPLOYMENT=%j: lock, PUT response, GET and /auth/provider all agree', async (v) => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, '{"llm_provider": "ollama"}'::jsonb)`;
    const env = { DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development', PUBLIC_DEPLOYMENT: v, LLM_PROVIDER: 'api' };
    const key = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
    const c = client(
      createApp({
        sql,
        queue: testQueue(),
        config: loadConfig(env),
        logger: pino({ level: 'silent' }),
        storage: new LocalStorage({ uploadDir: '/nonexistent/u', figuresDir: '/nonexistent/f', mediaDir: '/nonexistent/m' }, key),
        signingKey: key,
        env,
        userOverride: userA,
      }),
    );
    expect((await (await c.get('/auth/provider')).json()).public_deployment).toBe(true);
    const put = await c.put('/settings', { settings: { llm_provider: 'ollama', claude_model: 'x' } });
    expect(put.status).toBe(200);
    expect((await put.json()).llm_provider).toBe('api');
    expect(await stored()).toEqual({ llm_provider: 'ollama' }); // pre-lock row untouched, new write dropped
    expect((await (await c.get('/settings')).json()).llm_provider).toBe('api');
  });

  it('a row stored before the lock: GET, PUT, providerConfig all resolve env-or-default, the row is never used', async () => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json({ ...STALE_ROW, anthropic_api_key: 'sk-own' })})`;
    // The operator env leaves every provider/model var unset except one.
    const env = { DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development', PUBLIC_DEPLOYMENT: 'true', CONTEXT_PROVIDER: 'none' };
    const key = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
    const config = loadConfig(env);
    const c = client(
      createApp({
        sql,
        queue: testQueue(),
        config,
        logger: pino({ level: 'silent' }),
        storage: new LocalStorage({ uploadDir: '/nonexistent/u', figuresDir: '/nonexistent/f', mediaDir: '/nonexistent/m' }, key),
        signingKey: key,
        env,
        userOverride: userA,
      }),
    );
    const expected = { ...BUILT_IN, context_provider: 'none' };
    const get = await (await c.get('/settings')).json();
    expect(pick(get, LOCKED_NON_SECRET)).toEqual(expected);
    expect(get.anthropic_api_key).toBe('set'); // the user's own key is redacted, not dropped
    const put = await c.put('/settings', { settings: { claude_model: 'x', theme: 'light' } });
    expect(put.status).toBe(200);
    expect(pick(await put.json(), LOCKED_NON_SECRET)).toEqual(expected);
    const p = providerConfig((await stored())!, env, config);
    expect([p.llm.claudeModel, p.context.provider, p.rerank.provider, p.embed.provider, p.vision.provider]).toEqual([
      BUILT_IN.claude_model, 'none', BUILT_IN.rerank_provider, BUILT_IN.embed_provider, BUILT_IN.vision_provider,
    ]);
  });

  it('/auth/provider exposes public_deployment', async () => {
    const t = await client(testApp({ user: userA, config: { publicDeployment: true } })).get('/auth/provider');
    expect((await t.json()).public_deployment).toBe(true);
    const f = await client(testApp({ user: userA })).get('/auth/provider');
    expect((await f.json()).public_deployment).toBe(false);
  });
});

describe('GET /settings/ollama-models', () => {
  const tags = {
    models: [
      { name: 'qwen3.8:27b', size: 16_400_000_000, details: { family: 'qwen', families: ['qwen'] } },
      { name: 'nomic-embed-text', size: 274_000_000, details: { family: 'nomic-bert' } },
      { name: 'bge-m3', size: 1_200_000_000, details: {} },
      { name: 'qwen3-vl:32b', size: 20_000_000_000, details: { family: 'qwen3vl', families: ['qwen3vl', 'Vision'] } },
      { name: 'llava-vision', size: 0 },
    ],
  };

  it('buckets names: embed/bge/nomic -> embed; vision family -> vision too; size X.YGB', async () => {
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(tags), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await asA({ fetch: f }).get('/settings/ollama-models');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(url).toMatch(/\/api\/tags$/);
    expect(b.embed.map((m: any) => m.name)).toEqual(['nomic-embed-text', 'bge-m3']);
    expect(b.llm.map((m: any) => m.name)).toEqual(['qwen3.8:27b', 'qwen3-vl:32b', 'llava-vision']);
    expect(b.vision.map((m: any) => m.name)).toEqual(['qwen3-vl:32b', 'llava-vision']);
    expect(b.llm[0]).toEqual({ name: 'qwen3.8:27b', size: '16.4GB', family: 'qwen' });
    expect(b.llm[2]).toEqual({ name: 'llava-vision', size: '0.0GB', family: '' });
  });

  it('upstream error -> all-empty lists with 200', async () => {
    const bad = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const thrown = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    for (const f of [bad, thrown]) {
      const r = await asA({ fetch: f }).get('/settings/ollama-models');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ llm: [], embed: [], vision: [] });
    }
  });
});

const CLEARED_TABLES = ['alerts', 'persona_dms', 'user_posts', 'corpus_syntheses', 'reading_lists', 'feeds', 'papers', 'tags'];

/** One real row per user in every table clear-everything deletes, plus a summary per user's paper. */
async function seedContent() {
  for (const [uid, ws, paper] of [
    [USER_A_ID, seeded.workspace_a, seeded.paper_a],
    [USER_B_ID, seeded.workspace_b, seeded.paper_b],
  ]) {
    await sql`INSERT INTO alerts (user_id, alert_type, title, body) VALUES (${uid}, 'info', 't', 'b')`;
    await sql`INSERT INTO persona_dms (user_id, persona_key) VALUES (${uid}, 'skeptic')`;
    await sql`INSERT INTO user_posts (user_id, corpus_id, content) VALUES (${uid}, ${ws}, 'hi')`;
    await sql`INSERT INTO corpus_syntheses (user_id, name, paper_ids) VALUES (${uid}, 'syn', ${[paper]}::uuid[])`;
    await sql`INSERT INTO reading_lists (user_id, corpus_id, name) VALUES (${uid}, ${ws}, 'rl')`;
    await sql`INSERT INTO tags (user_id, name) VALUES (${uid}, 'tag')`;
    await sql`INSERT INTO paper_summaries (paper_id) VALUES (${paper})`;
  }
}

async function countFor(table: string, uid: string) {
  const [x] = await sql`SELECT count(*)::int n FROM ${sql(table)} WHERE user_id = ${uid}`;
  return x.n as number;
}

/** Audio and a podcast episode on disk for user A's and user B's seeded feeds (deliberate change 9). */
async function seedFeedMedia(mediaDir: string) {
  const st = new LocalStorage({ uploadDir: mediaDir, figuresDir: mediaDir, mediaDir }, resolveSigningKey({ SIGNED_URL_KEY: 'k' }));
  for (const f of [seeded.feed_a, seeded.feed_b]) {
    await st.saveAudio(f, 0, Buffer.from('a'));
    await st.savePodcastEpisode(f, Buffer.from('p'));
  }
}

describe('clear-* routes', () => {
  it('clear-feeds deletes feeds, audits feed.clear_all (test_clear_all_feeds_writes_audit_row)', async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), 'ficino-settings-media-'));
    await seedFeedMedia(mediaDir);
    const r = await asA({ config: { mediaDir } }).post('/settings/clear-feeds');
    expect(await stat(join(mediaDir, 'feeds', seeded.feed_a)).then(() => true, () => false)).toBe(false);
    expect(await stat(join(mediaDir, 'feeds', seeded.feed_b, 'podcast', 'episode.mp3')).then(() => true, () => false)).toBe(true);
    await rm(mediaDir, { recursive: true, force: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'cleared' });
    const [a] = await sql`SELECT count(*)::int n FROM feeds WHERE user_id = ${USER_A_ID}`;
    const [b] = await sql`SELECT count(*)::int n FROM feeds WHERE user_id = ${USER_B_ID}`;
    expect([a.n, b.n]).toEqual([0, 1]);
    expect(await auditCount('feed.clear_all')).toBe(1);
  });

  it('clear-summaries deletes only the caller\'s summaries and audits', async () => {
    await seedContent();
    const r = await asA().post('/settings/clear-summaries');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'cleared' });
    const rows = await sql`SELECT p.user_id FROM paper_summaries s JOIN papers p ON p.id = s.paper_id`;
    expect(rows.map((x) => x.user_id)).toEqual([USER_B_ID]);
    expect(await auditCount('summary.clear_all')).toBe(1);
  });

  it('clear-user-posts deletes only the caller\'s posts and audits', async () => {
    await seedContent();
    const r = await asA().post('/settings/clear-user-posts');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'cleared' });
    const rows = await sql`SELECT user_id FROM user_posts`;
    expect(rows.map((x) => x.user_id)).toEqual([USER_B_ID]);
    expect(await auditCount('user_post.clear_all')).toBe(1);
  });

  describe('with artifacts on disk', () => {
    let dir: string;
    let cfg: { uploadDir: string; figuresDir: string; mediaDir: string };
    const exists = (p: string) => stat(p).then(() => true, () => false);
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ficino-settings-'));
      cfg = { uploadDir: join(dir, 'up'), figuresDir: join(dir, 'fig'), mediaDir: join(dir, 'media') };
      await seedFeedMedia(cfg.mediaDir);
      await mkdir(cfg.uploadDir, { recursive: true });
      for (const id of [seeded.paper_a, seeded.paper_b]) {
        await writeFile(join(cfg.uploadDir, `${id}.pdf`), 'pdf');
        await mkdir(join(cfg.figuresDir, id), { recursive: true });
        await writeFile(join(cfg.figuresDir, id, 'a.png'), 'a');
      }
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it('clear-papers deletes papers + feeds + artifacts, keeps user B (test_clear_all_papers_deletes_papers_and_feeds)', async () => {
      const r = await asA({ config: cfg }).post('/settings/clear-papers');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: 'cleared', paper_count: 1 });
      const [p] = await sql`SELECT count(*)::int n FROM papers WHERE user_id = ${USER_A_ID}`;
      const [f] = await sql`SELECT count(*)::int n FROM feeds WHERE user_id = ${USER_A_ID}`;
      const [pb] = await sql`SELECT count(*)::int n FROM papers WHERE id = ${seeded.paper_b}`;
      expect([p.n, f.n, pb.n]).toEqual([0, 0, 1]);
      expect(await exists(join(cfg.uploadDir, `${seeded.paper_a}.pdf`))).toBe(false);
      expect(await exists(join(cfg.figuresDir, seeded.paper_a))).toBe(false);
      expect(await exists(join(cfg.uploadDir, `${seeded.paper_b}.pdf`))).toBe(true);
      expect(await exists(join(cfg.mediaDir, 'feeds', seeded.feed_a))).toBe(false);
      expect(await exists(join(cfg.mediaDir, 'feeds', seeded.feed_b, 'audio', 'post_0.mp3'))).toBe(true);
      expect(await exists(join(cfg.mediaDir, 'feeds', seeded.feed_b, 'podcast', 'episode.mp3'))).toBe(true);
      expect(await auditCount('paper.clear_all')).toBe(1);
    });

    it('clear-everything deletes content tables, keeps corpora + user_settings, cleans artifacts, audits account.clear_all', async () => {
      await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, '{"theme":"light"}'::jsonb)`;
      await seedContent();
      for (const t of CLEARED_TABLES) {
        expect(await countFor(t, USER_A_ID), `${t} A seeded`).toBeGreaterThan(0);
        expect(await countFor(t, USER_B_ID), `${t} B seeded`).toBeGreaterThan(0);
      }
      const bBefore = Object.fromEntries(await Promise.all(CLEARED_TABLES.map(async (t) => [t, await countFor(t, USER_B_ID)])));
      const r = await asA({ config: cfg }).post('/settings/clear-everything');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: 'cleared', paper_count: 1 });
      for (const t of CLEARED_TABLES) {
        expect(await countFor(t, USER_A_ID), `${t} A`).toBe(0);
        expect(await countFor(t, USER_B_ID), `${t} B`).toBe(bBefore[t]);
      }
      expect(await countFor('corpora', USER_A_ID)).toBe(1);
      expect(await stored()).toEqual({ theme: 'light' });
      expect(await exists(join(cfg.uploadDir, `${seeded.paper_a}.pdf`))).toBe(false);
      expect(await exists(join(cfg.figuresDir, seeded.paper_a))).toBe(false);
      expect(await exists(join(cfg.uploadDir, `${seeded.paper_b}.pdf`))).toBe(true);
      expect(await exists(join(cfg.mediaDir, 'feeds', seeded.feed_a))).toBe(false);
      expect(await exists(join(cfg.mediaDir, 'feeds', seeded.feed_b, 'audio', 'post_0.mp3'))).toBe(true);
      expect(await exists(join(cfg.mediaDir, 'feeds', seeded.feed_b, 'podcast', 'episode.mp3'))).toBe(true);
      const [row] = await sql`SELECT resource_type, metadata FROM audit_log WHERE user_id = ${USER_A_ID} AND action = 'account.clear_all'`;
      expect(row.resource_type).toBe('account');
      expect(row.metadata).toEqual({ paper_count: 1 });
      const [pb] = await sql`SELECT count(*)::int n FROM papers WHERE id = ${seeded.paper_b}`;
      expect(pb.n).toBe(1);
    });
  });
});
