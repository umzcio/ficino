import { describe, it, expect, beforeEach } from 'vitest';
import { providerConfig, loadJobSettings } from '../../src/providers/config.js';
import { resolveUserSettings } from '../../src/settings/resolve.js';
import { loadConfig } from '../../src/config.js';
import { PUBLIC_OFF, PUBLIC_ON } from '../helpers/publicDeployment.js';
import { testSql, resetDb, seedUsers, USER_A_ID, USER_B_ID } from '../helpers/db.js';

const config = loadConfig({});

describe('providerConfig (port of test_settings_env_hygiene.py)', () => {
  it('no key leak between users', () => {
    const a = providerConfig({ anthropic_api_key: 'sk-user-a' }, {}, config);
    const b = providerConfig({ llm_provider: 'api' }, {}, config);
    expect(a.llm.anthropicKey).toBe('sk-user-a');
    expect(b.llm.provider).toBe('api');
    expect(JSON.stringify(b)).not.toContain('sk-user-a');
    expect(b.llm.anthropicKey).toBe('');
    expect(b.vision.anthropicKey).toBe('');
    expect(b.figureDetect.anthropicKey).toBe('');
    expect(b.context.anthropicKey).toBe('');
  });

  it('unset keys fall back to the operator env, not the defaults', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-operator', OLLAMA_LLM_MODEL: 'env-model' };
    const b = providerConfig({}, env, config);
    expect(b.llm.anthropicKey).toBe('sk-operator');
    expect(b.llm.ollamaModel).toBe('env-model');
    const a = providerConfig({ anthropic_api_key: 'sk-user-a' }, env, config);
    expect(a.llm.anthropicKey).toBe('sk-user-a');
    expect(providerConfig({}, env, config).llm.anthropicKey).toBe('sk-operator');
  });

  it('falls back to built-in defaults when neither stored nor env has a value', () => {
    const p = providerConfig({}, {}, config);
    expect(p.llm).toEqual({ provider: 'ollama', ollamaModel: 'qwen3.8:27b', claudeModel: 'claude-sonnet-5-5', anthropicKey: '' });
    expect(p.embed.ollamaModel).toBe('qwen3-embedding:latest');
    expect(p.embed.dim).toBe(config.embedDim);
    expect(p.vision.ollamaModel).toBe('qwen3-vl:32b');
    expect(p.figureDetect.provider).toBe('ollama');
    expect(p.context.provider).toBe('none');
    expect(p.context.maxPaperChars).toBe(config.contextMaxPaperChars);
    expect(p.context.maxTokens).toBe(config.contextMaxTokens);
    expect(p.context.maxChunks).toBe(config.contextMaxChunks);
    expect(p.rerank.provider).toBe('none');
  });

  it('PUBLIC_DEPLOYMENT: a non-empty env var beats the stored value', () => {
    const env = { PUBLIC_DEPLOYMENT: 'true', LLM_PROVIDER: 'api' };
    const p = providerConfig({ llm_provider: 'ollama' }, env, config);
    expect(p.llm.provider).toBe('api');
  });

  it('PUBLIC_DEPLOYMENT: every truthy spelling lets the env beat the stored value; off spellings do not', () => {
    for (const v of PUBLIC_ON) {
      const p = providerConfig({ llm_provider: 'ollama', vision_provider: 'ollama' }, { PUBLIC_DEPLOYMENT: v, LLM_PROVIDER: 'api', VISION_PROVIDER: 'api' }, config);
      expect([p.llm.provider, p.vision.provider], JSON.stringify(v)).toEqual(['api', 'api']);
    }
    for (const v of PUBLIC_OFF) {
      const p = providerConfig({ llm_provider: 'ollama' }, { PUBLIC_DEPLOYMENT: v, LLM_PROVIDER: 'api' }, config);
      expect(p.llm.provider, JSON.stringify(v)).toBe('ollama');
    }
  });

  it('PUBLIC_DEPLOYMENT does not launder a stored key when the operator has none', () => {
    const env = { PUBLIC_DEPLOYMENT: 'true' };
    const a = providerConfig({ anthropic_api_key: 'sk-a' }, env, config);
    const b = providerConfig({}, env, config);
    expect(a.llm.anthropicKey).toBe('sk-a'); // empty env var does not override
    expect(b.llm.anthropicKey).toBe('');
  });

  it('a stored empty string falls back to the env', () => {
    const p = providerConfig({ anthropic_api_key: '', claude_model: '' }, { ANTHROPIC_API_KEY: 'sk-op', CLAUDE_MODEL: 'm' }, config);
    expect(p.llm.anthropicKey).toBe('sk-op');
    expect(p.llm.claudeModel).toBe('m');
  });

  it('vision_provider falls back to the resolved llm provider', () => {
    expect(providerConfig({ llm_provider: 'api' }, {}, config).vision.provider).toBe('api');
    expect(providerConfig({ llm_provider: 'api', vision_provider: 'ollama' }, {}, config).vision.provider).toBe('ollama');
    expect(providerConfig({ llm_provider: 'api' }, { VISION_PROVIDER: 'ollama' }, config).vision.provider).toBe('ollama');
    expect(providerConfig({}, {}, config).vision.provider).toBe('ollama');
  });

  it('ignores a stored ollama_base_url', () => {
    const p = providerConfig({ ollama_base_url: 'http://evil:1' }, {}, config);
    expect(p.ollamaBaseUrl).toBe(config.ollamaBaseUrl);
  });

  it('is deep-frozen', () => {
    const p = providerConfig({}, {}, config);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.llm)).toBe(true);
    expect(() => {
      (p.llm as { anthropicKey: string }).anthropicKey = 'x';
    }).toThrow();
  });
});

describe('loadJobSettings', () => {
  const sql = testSql();
  beforeEach(async () => {
    await resetDb(sql);
    await seedUsers(sql);
  });

  it('settings equal resolveUserSettings; jobs for two users stay isolated', async () => {
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json({ anthropic_api_key: 'ka', llm_provider: 'api', theme: 'light' })})`;
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_B_ID}, ${sql.json({ llm_provider: 'api' })})`;
    const env = { PUBLIC_DEPLOYMENT: '' };
    const [a, b] = await Promise.all([
      loadJobSettings(sql, USER_A_ID, env, config),
      loadJobSettings(sql, USER_B_ID, env, config),
    ]);
    expect(a.settings).toEqual(await resolveUserSettings(sql, USER_A_ID, env));
    expect(b.settings).toEqual(await resolveUserSettings(sql, USER_B_ID, env));
    expect(a.providers.llm.anthropicKey).toBe('ka');
    expect(b.providers.llm.anthropicKey).toBe('');
    expect(Object.isFrozen(a.settings)).toBe(true);
  });

  it('works for a user with no row', async () => {
    const { settings, providers } = await loadJobSettings(sql, USER_A_ID, {}, config);
    expect(settings.llm_provider).toBe('ollama');
    expect(providers.llm.provider).toBe('ollama');
  });
});
