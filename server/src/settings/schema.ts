// Port of shared/ficino_shared/settings_schema.py. Pure: every function takes
// the env it should read; nothing here touches process.env.

export type Settings = Record<string, unknown>;
export type Env = Record<string, string | undefined>;

/** Default settings; provider/model knobs come from the env passed in. */
export function buildDefaults(env: Env): Settings {
  const e = (name: string, fallback: string): string => env[name] ?? fallback;
  return {
    // LLM / embedding / vision providers
    llm_provider: e('LLM_PROVIDER', 'ollama'),
    embed_provider: e('EMBED_PROVIDER', 'ollama'),
    vision_provider: e('VISION_PROVIDER', 'ollama'),
    claude_model: e('CLAUDE_MODEL', 'claude-sonnet-5-5'),
    ollama_llm_model: e('OLLAMA_LLM_MODEL', 'qwen3.8:27b'),
    ollama_embed_model: e('OLLAMA_EMBED_MODEL', 'qwen3-embedding:latest'),
    ollama_vision_model: e('OLLAMA_VISION_MODEL', 'qwen3-vl:32b'),
    voyage_embed_model: e('VOYAGE_EMBED_MODEL', 'voyage-4-large'),
    anthropic_api_key: e('ANTHROPIC_API_KEY', ''),
    openai_api_key: e('OPENAI_API_KEY', ''),
    voyage_api_key: e('VOYAGE_API_KEY', ''),
    cohere_api_key: e('COHERE_API_KEY', ''),
    // Cross-encoder rerank of retrieval candidates. "none" = off.
    rerank_provider: e('RERANK_PROVIDER', 'none'),
    rerank_local_model: e('RERANK_LOCAL_MODEL', 'BAAI/bge-reranker-v2-m3'),
    rerank_voyage_model: e('RERANK_VOYAGE_MODEL', 'rerank-2-lite'),
    rerank_cohere_model: e('RERANK_COHERE_MODEL', 'rerank-v3.5'),
    // Per-chunk contextual prefix generation at ingest time. "none" = off.
    context_provider: e('CONTEXT_PROVIDER', 'none'),
    context_anthropic_model: e('CONTEXT_ANTHROPIC_MODEL', 'claude-haiku-5-5'),
    context_ollama_model: e('CONTEXT_OLLAMA_MODEL', 'qwen3.8:27b'),
    // Figure-detection vision provider.
    figure_detect_provider: e('FIGURE_DETECT_PROVIDER', 'ollama'),
    figure_detect_ollama_model: e('FIGURE_DETECT_OLLAMA_MODEL', 'qwen3-vl:32b'),
    figure_detect_anthropic_model: e('FIGURE_DETECT_ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    // OpenAI embedding model, used when embed_provider == "openai".
    openai_embed_model: e('OPENAI_EMBED_MODEL', 'text-embedding-3-small'),

    // Personas
    personas_enabled: {
      skeptic: true,
      hype: true,
      practitioner: true,
      methodologist: true,
      gradstudent: true,
    },
    persona_temperature: 0.8,

    // Feed
    posts_per_generation: 12,
    post_type_weights: { post: 0.35, thread: 0.1, quote: 0.2, reply: 0.25, figure: 0.1 },
    auto_generate_on_upload: false,

    // Paper Processing
    extraction_mode: 'auto', // auto, pymupdf, vision
    chunk_max_tokens: 800,

    // User profile
    user_display_name: 'You',
    user_handle: '@you',
    user_avatar_url: '',

    // UI-only (api-only; the worker does not read these)
    show_extraction_badge: true,
    theme: 'dark',
    font_size: 'normal', // small, normal, large
    post_spacing: 'comfortable', // compact, comfortable
  };
}

/** Keys that exist only for the frontend's benefit. */
export const UI_ONLY_KEYS: ReadonlySet<string> = new Set([
  'show_extraction_badge',
  'theme',
  'font_size',
  'post_spacing',
]);

/** Settings keys that map directly to env vars. */
export const SETTINGS_TO_ENV: Readonly<Record<string, string>> = {
  llm_provider: 'LLM_PROVIDER',
  embed_provider: 'EMBED_PROVIDER',
  ollama_llm_model: 'OLLAMA_LLM_MODEL',
  ollama_embed_model: 'OLLAMA_EMBED_MODEL',
  ollama_vision_model: 'OLLAMA_VISION_MODEL',
  vision_provider: 'VISION_PROVIDER',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  openai_api_key: 'OPENAI_API_KEY',
  voyage_api_key: 'VOYAGE_API_KEY',
  cohere_api_key: 'COHERE_API_KEY',
  claude_model: 'CLAUDE_MODEL',
  voyage_embed_model: 'VOYAGE_EMBED_MODEL',
  rerank_provider: 'RERANK_PROVIDER',
  rerank_local_model: 'RERANK_LOCAL_MODEL',
  rerank_voyage_model: 'RERANK_VOYAGE_MODEL',
  rerank_cohere_model: 'RERANK_COHERE_MODEL',
  context_provider: 'CONTEXT_PROVIDER',
  context_anthropic_model: 'CONTEXT_ANTHROPIC_MODEL',
  context_ollama_model: 'CONTEXT_OLLAMA_MODEL',
  figure_detect_provider: 'FIGURE_DETECT_PROVIDER',
  figure_detect_ollama_model: 'FIGURE_DETECT_OLLAMA_MODEL',
  figure_detect_anthropic_model: 'FIGURE_DETECT_ANTHROPIC_MODEL',
  openai_embed_model: 'OPENAI_EMBED_MODEL',
};

/** Numeric bounds for cost-sensitive knobs: [kind, min, max]. */
export const NUMERIC_BOUNDS: Readonly<Record<string, readonly ['int' | 'float', number, number]>> = {
  posts_per_generation: ['int', 1, 50],
  persona_temperature: ['float', 0.0, 1.5],
  chunk_max_tokens: ['int', 100, 4000],
};

/** Keys whose values are secrets (redacted in GET /settings). */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'anthropic_api_key',
  'openai_api_key',
  'voyage_api_key',
  'cohere_api_key',
]);

/** Keys rejected on write under PUBLIC_DEPLOYMENT (operator env is authoritative). */
export const PROVIDER_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'llm_provider',
  'embed_provider',
  'vision_provider',
  'ollama_llm_model',
  'ollama_embed_model',
  'ollama_vision_model',
  'claude_model',
  'anthropic_api_key',
  'openai_api_key',
  'voyage_api_key',
  'cohere_api_key',
  'voyage_embed_model',
  'rerank_provider',
  'rerank_local_model',
  'rerank_voyage_model',
  'rerank_cohere_model',
  'context_provider',
  'context_anthropic_model',
  'context_ollama_model',
  'figure_detect_provider',
  'figure_detect_ollama_model',
  'figure_detect_anthropic_model',
  'openai_embed_model',
]);

export function isPublicDeployment(env: Env): boolean {
  return ['1', 'true', 'yes'].includes((env.PUBLIC_DEPLOYMENT ?? '').toLowerCase());
}

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge a user's settings over defaults; dict values merge one level deep. User keys not in defaults pass through. */
export function mergeSettings(defaults: Settings, user: Record<string, unknown>): Settings {
  const merged: Settings = { ...defaults };
  for (const [key, value] of Object.entries(user)) {
    const base = merged[key];
    if (key in merged && isDict(base) && isDict(value)) {
      merged[key] = { ...base, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Under PUBLIC_DEPLOYMENT the operator env wins over any stored user value (when the env var is non-empty). */
export function reassertPublicDeployment(merged: Settings, env: Env): Settings {
  const out: Settings = { ...merged };
  if (isPublicDeployment(env)) {
    for (const [key, envKey] of Object.entries(SETTINGS_TO_ENV)) {
      const v = env[envKey];
      if (v) out[key] = v;
    }
  }
  return out;
}
