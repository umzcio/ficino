import { describe, it, expect } from 'vitest';
import {
  buildDefaults, SETTINGS_TO_ENV, PROVIDER_OVERRIDE_KEYS, SECRET_KEYS, NUMERIC_BOUNDS, UI_ONLY_KEYS,
  mergeSettings, reassertPublicDeployment, isPublicDeployment, lockedProviderValue,
} from '../../src/settings/schema.js';
import { loadConfig } from '../../src/config.js';
import { PUBLIC_OFF, PUBLIC_ON } from '../helpers/publicDeployment.js';
import { BUILT_IN, LOCKED_NON_SECRET, pick, STALE_ROW } from '../helpers/lockedOverrides.js';

describe('settings schema (shared/tests/test_settings_schema.py)', () => {
  it('test_defaults_cover_every_env_mapped_key', () => {
    const d = buildDefaults({});
    expect(Object.keys(SETTINGS_TO_ENV).filter((k) => !(k in d))).toEqual([]);
  });
  it('test_new_provider_keys_present_and_protected', () => {
    const d = buildDefaults({});
    for (const k of ['figure_detect_provider', 'figure_detect_ollama_model', 'figure_detect_anthropic_model', 'openai_embed_model']) {
      expect(k in d).toBe(true);
      expect(k in SETTINGS_TO_ENV).toBe(true);
      expect(PROVIDER_OVERRIDE_KEYS.has(k)).toBe(true);
    }
  });
  it('test_secret_keys_subset_of_defaults', () => {
    const d = buildDefaults({});
    for (const k of SECRET_KEYS) expect(k in d).toBe(true);
  });
  it('test_merge_is_dict_aware', () => {
    const merged = mergeSettings(buildDefaults({}), { personas_enabled: { skeptic: false } });
    const p = merged.personas_enabled as Record<string, boolean>;
    expect(p.skeptic).toBe(false);
    expect(p.hype).toBe(true);
  });
  it('test_reassert_reads_baseline_not_live_env (env passed in is the baseline; no mutation)', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-poisoned';
    try {
      const env = Object.freeze({ PUBLIC_DEPLOYMENT: 'true' });
      const merged = reassertPublicDeployment(mergeSettings(buildDefaults(env), {}), env);
      expect(merged.anthropic_api_key).toBe('');
      expect(JSON.stringify(merged)).not.toContain('sk-poisoned');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('settings contract (api/tests/test_settings_contract.py, non-HTTP parts)', () => {
  it('defaults include UI keys and worker keys', () => {
    const d = buildDefaults({});
    for (const k of ['llm_provider', 'personas_enabled', 'posts_per_generation', 'theme', 'font_size', 'post_spacing', 'show_extraction_badge',
      'rerank_provider', 'context_provider', 'voyage_embed_model', 'cohere_api_key']) expect(k in d).toBe(true);
    expect([...UI_ONLY_KEYS].sort()).toEqual(['font_size', 'post_spacing', 'show_extraction_badge', 'theme']);
  });
  it('cohere key is secret', () => {
    expect(SECRET_KEYS.has('cohere_api_key')).toBe(true);
  });
  it('reasserts env under public deployment over stale user row', () => {
    const env = { PUBLIC_DEPLOYMENT: 'true', LLM_PROVIDER: 'api' };
    const merged = reassertPublicDeployment(mergeSettings(buildDefaults(env), { llm_provider: 'ollama' }), env);
    expect(merged.llm_provider).toBe('api');
  });
  it('every provider override is env-mapped, so the lock can resolve it from the env', () => {
    expect([...PROVIDER_OVERRIDE_KEYS].filter((k) => !(k in SETTINGS_TO_ENV))).toEqual([]);
  });
  it('reassert drops a stale stored provider/model even when the operator env leaves it unset', () => {
    const env = { PUBLIC_DEPLOYMENT: 'true' };
    const merged = reassertPublicDeployment(mergeSettings(buildDefaults(env), { ...STALE_ROW, voyage_api_key: 'own' }), env);
    expect(pick(merged, LOCKED_NON_SECRET)).toEqual(BUILT_IN);
    expect(merged.voyage_api_key).toBe('own');
  });
  it('lockedProviderValue: env when non-empty, else built-in default; undefined for secrets and other keys', () => {
    expect(lockedProviderValue('claude_model', { CLAUDE_MODEL: 'm' })).toBe('m');
    expect(lockedProviderValue('claude_model', { CLAUDE_MODEL: '' })).toBe(BUILT_IN.claude_model);
    expect(lockedProviderValue('context_provider', {})).toBe('none');
    expect(lockedProviderValue('anthropic_api_key', { ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
    expect(lockedProviderValue('theme', {})).toBeUndefined();
  });
  it('does not reassert when not public', () => {
    const env = { LLM_PROVIDER: 'api' };
    expect(isPublicDeployment(env)).toBe(false);
    expect(reassertPublicDeployment({ llm_provider: 'ollama' }, env).llm_provider).toBe('ollama');
  });
  it('isPublicDeployment accepts every boolean spelling the config accepts (trimmed, case-insensitive)', () => {
    for (const v of PUBLIC_ON) expect(isPublicDeployment({ PUBLIC_DEPLOYMENT: v }), JSON.stringify(v)).toBe(true);
    for (const v of PUBLIC_OFF) expect(isPublicDeployment({ PUBLIC_DEPLOYMENT: v }), JSON.stringify(v)).toBe(false);
  });
  it('isPublicDeployment rejects an unrecognised spelling instead of reading it as off', () => {
    for (const v of ['yep', 'enabled', '2', 'tru']) {
      expect(() => isPublicDeployment({ PUBLIC_DEPLOYMENT: v })).toThrow(`PUBLIC_DEPLOYMENT must be a boolean, got: ${v}`);
    }
  });
  it('the write lock (config.publicDeployment) and the reassert agree on every spelling', () => {
    for (const v of [...PUBLIC_ON, ...PUBLIC_OFF]) {
      const env = { PUBLIC_DEPLOYMENT: v };
      expect(loadConfig(env).publicDeployment, JSON.stringify(v)).toBe(isPublicDeployment(env));
    }
  });
  it('reasserts the operator env for every truthy spelling', () => {
    for (const v of PUBLIC_ON) {
      const env = { PUBLIC_DEPLOYMENT: v, LLM_PROVIDER: 'api' };
      expect(reassertPublicDeployment({ llm_provider: 'ollama' }, env).llm_provider, JSON.stringify(v)).toBe('api');
    }
  });
  it('merge: unknown user keys pass through, one level only, non-dict replaces', () => {
    const m = mergeSettings({ a: { x: { p: 1 }, y: 1 }, b: 1 }, { a: { x: { q: 2 } }, b: { z: 1 }, extra: 5 });
    expect(m.a).toEqual({ x: { q: 2 }, y: 1 });
    expect(m.b).toEqual({ z: 1 });
    expect(m.extra).toBe(5);
  });
  it('numeric bounds pinned', () => {
    expect(NUMERIC_BOUNDS).toEqual({
      posts_per_generation: ['int', 1, 50], persona_temperature: ['float', 0, 1.5], chunk_max_tokens: ['int', 100, 4000],
    });
  });
  it('buildDefaults returns fresh objects each call', () => {
    const a = buildDefaults({}); const b = buildDefaults({});
    expect(a.personas_enabled).not.toBe(b.personas_enabled);
  });
  it('unchanged python defaults pinned', () => {
    const d = buildDefaults({});
    expect(d).toMatchObject({
      llm_provider: 'ollama', embed_provider: 'ollama', vision_provider: 'ollama', voyage_embed_model: 'voyage-4-large',
      rerank_provider: 'none', rerank_local_model: 'BAAI/bge-reranker-v2-m3', rerank_voyage_model: 'rerank-2-lite',
      rerank_cohere_model: 'rerank-v3.5', context_provider: 'none', figure_detect_anthropic_model: 'claude-sonnet-5-5',
      openai_embed_model: 'text-embedding-3-small', persona_temperature: 0.8, posts_per_generation: 12,
      auto_generate_on_upload: false, extraction_mode: 'auto', chunk_max_tokens: 800,
      user_display_name: 'You', user_handle: '@you', user_avatar_url: '', theme: 'dark', font_size: 'normal',
      post_spacing: 'comfortable', show_extraction_badge: true,
      post_type_weights: { post: 0.35, thread: 0.1, quote: 0.2, reply: 0.25, figure: 0.1 },
    });
  });
});

describe('port default changes', () => {
  it('model defaults updated for the port', () => {
    const d = buildDefaults({});
    expect(d.ollama_llm_model).toBe('qwen3.8:27b');
    expect(d.ollama_embed_model).toBe('qwen3-embedding:latest');
    expect(d.claude_model).toBe('claude-sonnet-5-5');
    expect(d.context_anthropic_model).toBe('claude-haiku-5-5');
    expect(d.context_ollama_model).toBe('qwen3.8:27b');
    expect(d.figure_detect_provider).toBe('ollama');
  });
  it('vision models default to qwen3-vl:32b (installed on <host>)', () => {
    const d = buildDefaults({});
    expect(d.figure_detect_ollama_model).toBe('qwen3-vl:32b');
    expect(d.ollama_vision_model).toBe('qwen3-vl:32b');
  });
  it('env still overrides defaults', () => {
    expect(buildDefaults({ OLLAMA_LLM_MODEL: 'x' }).ollama_llm_model).toBe('x');
  });
});
