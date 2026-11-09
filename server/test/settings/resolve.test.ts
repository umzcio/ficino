import { describe, it, expect, beforeEach } from 'vitest';
import { resolveSettings, resolveUserSettings } from '../../src/settings/resolve.js';
import { PUBLIC_OFF, PUBLIC_ON } from '../helpers/publicDeployment.js';
import { BUILT_IN, envFor, LOCKED_NON_SECRET, pick, STALE_ROW } from '../helpers/lockedOverrides.js';
import { loadStoredSettings } from '../../src/settings/stored.js';
import { client, testApp } from '../helpers/client.js';
import { testSql, resetDb, seedUsers, USER_A_ID, USER_B_ID } from '../helpers/db.js';

const sql = testSql();

async function setRow(userId: string, settings: object) {
  await sql`INSERT INTO user_settings (user_id, settings) VALUES (${userId}, ${sql.json(settings as never)})`;
}

describe('resolveUserSettings', () => {
  beforeEach(async () => {
    await resetDb(sql);
    await seedUsers(sql);
  });

  it('returns defaults when the user has no row', async () => {
    const s = await resolveUserSettings(sql, USER_A_ID, {});
    expect(s.llm_provider).toBe('ollama');
  });
  it('never mutates the env object', async () => {
    const env = Object.freeze({ LLM_PROVIDER: 'ollama' });
    await expect(resolveUserSettings(sql, USER_A_ID, env)).resolves.toBeTruthy();
  });
  it('does not write process.env', async () => {
    await setRow(USER_A_ID, { anthropic_api_key: 'ka' });
    const before = process.env.ANTHROPIC_API_KEY;
    await resolveUserSettings(sql, USER_A_ID, {});
    expect(process.env.ANTHROPIC_API_KEY).toBe(before);
  });
  it('two users resolve independently', async () => {
    await setRow(USER_A_ID, { anthropic_api_key: 'ka' });
    await setRow(USER_B_ID, { anthropic_api_key: 'kb' });
    const [a, b] = await Promise.all([resolveUserSettings(sql, USER_A_ID, {}), resolveUserSettings(sql, USER_B_ID, {})]);
    expect([a.anthropic_api_key, b.anthropic_api_key]).toEqual(['ka', 'kb']);
  });
  it('result is deep-frozen', async () => {
    const s = await resolveUserSettings(sql, USER_A_ID, {});
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.personas_enabled)).toBe(true);
    expect(() => { (s as Record<string, unknown>).llm_provider = 'x'; }).toThrow();
  });
  it('merges dict keys and passes unknown keys through', async () => {
    await setRow(USER_A_ID, { personas_enabled: { skeptic: false }, custom_key: 1 });
    const s = await resolveUserSettings(sql, USER_A_ID, {});
    expect(s.personas_enabled).toMatchObject({ skeptic: false, hype: true });
    expect(s.custom_key).toBe(1);
  });
  it('public deployment reasserts operator env over stale row, user cannot launder keys', async () => {
    await setRow(USER_A_ID, { llm_provider: 'ollama', openai_api_key: 'user-key' });
    const s = await resolveUserSettings(sql, USER_A_ID, { PUBLIC_DEPLOYMENT: 'true', LLM_PROVIDER: 'api' });
    expect(s.llm_provider).toBe('api');
    expect(s.openai_api_key).toBe('user-key'); // operator set no OPENAI key, so the row stands (matches Python)
  });
});

describe('resolveSettings: PUBLIC_DEPLOYMENT spellings', () => {
  it('every truthy spelling reasserts the operator env over a stored override; off spellings do not', () => {
    const stored = { llm_provider: 'ollama' };
    for (const v of PUBLIC_ON) {
      expect(resolveSettings(stored, { PUBLIC_DEPLOYMENT: v, LLM_PROVIDER: 'api' }).llm_provider, JSON.stringify(v)).toBe('api');
    }
    for (const v of PUBLIC_OFF) {
      expect(resolveSettings(stored, { PUBLIC_DEPLOYMENT: v, LLM_PROVIDER: 'api' }).llm_provider, JSON.stringify(v)).toBe('ollama');
    }
  });
});

describe('resolveSettings: PUBLIC_DEPLOYMENT ignores provider and model overrides stored before the lock', () => {
  it.each(PUBLIC_ON)('PUBLIC_DEPLOYMENT=%j, operator env unset: built-in defaults', (v) => {
    const s = resolveSettings(STALE_ROW, { PUBLIC_DEPLOYMENT: v });
    expect(pick(s, LOCKED_NON_SECRET)).toEqual(BUILT_IN);
  });
  it('operator env vars blank: built-in defaults', () => {
    expect(pick(resolveSettings(STALE_ROW, { PUBLIC_DEPLOYMENT: 'true', ...envFor(() => '') }), LOCKED_NON_SECRET)).toEqual(BUILT_IN);
  });
  it('operator env set: the env values', () => {
    const s = resolveSettings(STALE_ROW, { PUBLIC_DEPLOYMENT: 'true', ...envFor((k) => `env-${k}`) });
    expect(pick(s, LOCKED_NON_SECRET)).toEqual(Object.fromEntries(LOCKED_NON_SECRET.map((k) => [k, `env-${k}`])));
  });
  it('a stored API key stays when the operator has none (secret carve-out)', () => {
    expect(resolveSettings({ ...STALE_ROW, openai_api_key: 'own' }, { PUBLIC_DEPLOYMENT: 'true' }).openai_api_key).toBe('own');
  });
  it('lock off: the stored row wins (self-host unchanged)', () => {
    for (const v of PUBLIC_OFF) expect(pick(resolveSettings(STALE_ROW, { PUBLIC_DEPLOYMENT: v }), LOCKED_NON_SECRET), JSON.stringify(v)).toEqual(STALE_ROW);
  });
});

describe('loadStoredSettings: resolve and GET /settings agree on odd rows', () => {
  const userA = { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' };
  beforeEach(async () => {
    await resetDb(sql);
    await seedUsers(sql);
  });
  const rawRows: Array<[string, string]> = [
    ['malformed string', `'"{not json"'::jsonb`],
    ['string that parses to an array', `'"[1,2]"'::jsonb`],
    ['non-object (array)', `'[1,2]'::jsonb`],
    ['non-object (number)', `'7'::jsonb`],
    ['own __proto__ key', `'{"__proto__": {"llm_provider": "evil"}, "constructor": 1, "theme": "dark"}'::jsonb`],
  ];
  it.each(rawRows)('%s', async (_name, literal) => {
    await sql.unsafe(`INSERT INTO user_settings (user_id, settings) VALUES ('${USER_A_ID}', ${literal})`);
    const stored = await loadStoredSettings(sql, USER_A_ID);
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.keys(stored).filter((k) => ['__proto__', 'constructor', 'prototype'].includes(k))).toEqual([]);
    const resolved = await resolveUserSettings(sql, USER_A_ID, {});
    const got = await (await client(testApp({ user: userA })).get('/settings')).json();
    expect(got.llm_provider).toBe(resolved.llm_provider);
    expect(got.llm_provider).not.toBe('evil');
    expect(got.theme).toBe(resolved.theme);
    expect(Object.keys(got).sort()).toEqual(Object.keys(resolved).sort());
  });
  it('own __proto__ row keeps the legitimate keys', async () => {
    await sql.unsafe(`INSERT INTO user_settings (user_id, settings) VALUES ('${USER_A_ID}', ${rawRows[4]![1]})`);
    expect(await loadStoredSettings(sql, USER_A_ID)).toEqual({ theme: 'dark' });
  });
});
