import type { Config } from '../config.js';
import type { Sql } from '../db/sql.js';
import {
  buildDefaults,
  isPublicDeployment,
  lockedProviderValue,
  SETTINGS_TO_ENV,
  type Env,
  type Settings,
} from '../settings/schema.js';
import { deepFreeze, resolveSettings } from '../settings/resolve.js';
import { loadStoredSettings } from '../settings/stored.js';

export type ProviderConfig = {
  ollamaBaseUrl: string;
  llm: { provider: string; ollamaModel: string; claudeModel: string; anthropicKey: string };
  embed: {
    provider: string;
    ollamaModel: string;
    voyageModel: string;
    voyageKey: string;
    openaiModel: string;
    openaiKey: string;
    dim: number;
  };
  vision: { provider: string; ollamaModel: string; claudeModel: string; anthropicKey: string };
  figureDetect: { provider: string; ollamaModel: string; anthropicModel: string; anthropicKey: string };
  context: {
    provider: string;
    ollamaModel: string;
    anthropicModel: string;
    anthropicKey: string;
    maxPaperChars: number;
    maxTokens: number;
    maxChunks: number;
  };
  rerank: { provider: string; voyageModel: string; voyageKey: string; cohereModel: string; cohereKey: string };
};

/**
 * Port of get_active() over a per-job stored row: the stored value when truthy, otherwise the
 * operator env, otherwise the built-in default. Under PUBLIC_DEPLOYMENT a provider or model resolves
 * from the operator env or the built-in default only (the stored row is ignored), and an API key from a
 * non-empty env var beats a stored one. Nothing here reads process.env or keeps state, so one job's key
 * cannot reach another job.
 */
export function providerConfig(stored: Record<string, unknown>, env: Env, config: Config): ProviderConfig {
  const defaults = buildDefaults({});
  const pub = isPublicDeployment(env);
  const get = (key: string): string => {
    const envName = SETTINGS_TO_ENV[key];
    if (envName === undefined) throw new Error(`providerConfig: ${key} is not an env-mapped setting`);
    const envValue = env[envName];
    if (pub) {
      const locked = lockedProviderValue(key, env);
      if (locked !== undefined) return locked;
      if (envValue) return envValue;
    }
    const s = stored[key];
    if (s) return String(s);
    return envValue ?? String(defaults[key] ?? '');
  };

  const llmProvider = get('llm_provider');
  // vision_provider: stored, else env VISION_PROVIDER, else the resolved llm provider. Under
  // PUBLIC_DEPLOYMENT the stored value is ignored: a non-empty VISION_PROVIDER, else the (operator) llm provider.
  const visionProvider = pub
    ? env.VISION_PROVIDER || llmProvider
    : stored.vision_provider
      ? String(stored.vision_provider)
      : (env.VISION_PROVIDER ?? llmProvider);

  return deepFreeze({
    ollamaBaseUrl: config.ollamaBaseUrl, // env-only (SSRF guard); a stored ollama_base_url is ignored
    llm: {
      provider: llmProvider,
      ollamaModel: get('ollama_llm_model'),
      claudeModel: get('claude_model'),
      anthropicKey: get('anthropic_api_key'),
    },
    embed: {
      provider: get('embed_provider'),
      ollamaModel: get('ollama_embed_model'),
      voyageModel: get('voyage_embed_model'),
      voyageKey: get('voyage_api_key'),
      openaiModel: get('openai_embed_model'),
      openaiKey: get('openai_api_key'),
      dim: config.embedDim,
    },
    vision: {
      provider: visionProvider,
      ollamaModel: get('ollama_vision_model'),
      claudeModel: get('claude_model'),
      anthropicKey: get('anthropic_api_key'),
    },
    figureDetect: {
      provider: get('figure_detect_provider'),
      ollamaModel: get('figure_detect_ollama_model'),
      anthropicModel: get('figure_detect_anthropic_model'),
      anthropicKey: get('anthropic_api_key'),
    },
    context: {
      provider: get('context_provider'),
      ollamaModel: get('context_ollama_model'),
      anthropicModel: get('context_anthropic_model'),
      anthropicKey: get('anthropic_api_key'),
      maxPaperChars: config.contextMaxPaperChars,
      maxTokens: config.contextMaxTokens,
      maxChunks: config.contextMaxChunks,
    },
    rerank: {
      provider: get('rerank_provider'),
      voyageModel: get('rerank_voyage_model'),
      voyageKey: get('voyage_api_key'),
      cohereModel: get('rerank_cohere_model'),
      cohereKey: get('cohere_api_key'),
    },
  });
}

/** One read of the user's stored row, resolved into both the merged settings and the provider config. */
export async function loadJobSettings(
  sql: Sql,
  userId: string,
  env: Env,
  config: Config,
): Promise<{ settings: Readonly<Settings>; providers: ProviderConfig }> {
  const stored = await loadStoredSettings(sql, userId);
  return { settings: resolveSettings(stored, env), providers: providerConfig(stored, env, config) };
}
