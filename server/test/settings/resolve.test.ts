import { describe, it, expect, beforeEach } from 'vitest';
import { resolveUserSettings } from '../../src/settings/resolve.js';
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
