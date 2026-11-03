export type Env = Record<string, string | undefined>;

export interface Config {
  databaseUrl: string;
  environment: string;
  authProvider: 'none' | 'basic';
  allowRegistration: boolean;
  publicDeployment: boolean;
  corsOrigins: string[];
  cookieDomain: string;
  uploadDir: string;
  figuresDir: string;
  mediaDir: string;
  maxUploadSizeMb: number;
  ollamaBaseUrl: string;
  elevenlabsApiKey: string;
  signedUrlKey: string;
  searchUseNormalizedPosts: boolean;
  dbPoolMax: number;
  workerDbPoolMax: number;
  embedDim: number;
  jobTimeLimitSec: number;
  ingestionConcurrency: number;
  maxVisionPages: number;
  contextMaxPaperChars: number;
  contextMaxTokens: number;
  port: number;
  rateLimits: {
    paper_upload: number;
    feed_generation: number;
    user_post: number;
    summary: number;
    reply: number;
    persona_dm: number;
    audio: number;
  };
}

const TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/** Mirrors pydantic's bool parsing; unset or unrecognised values use the fallback. */
export function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return fallback;
}

function str(env: Env, name: string, fallback: string): string {
  return env[name] ?? fallback;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got: ${raw}`);
  return n;
}

function authProvider(v: string): 'none' | 'basic' {
  if (v === 'none' || v === 'basic') return v;
  if (v === 'supabase') throw new Error('AUTH_PROVIDER=supabase is no longer supported');
  throw new Error(`Unknown AUTH_PROVIDER: ${v}`);
}

/** migrate() holds one reserved connection and needs another per file, so a pool of 1 deadlocks. */
function poolMax(n: number): number {
  if (n < 2) throw new Error(`DB pool max must be at least 2 (got ${n})`);
  return n;
}

function embedDim(n: number): number {
  if (n !== 1024) throw new Error('EMBED_DIM must be 1024 (chunks.embedding is vector(1024))');
  return n;
}

function jobTimeLimit(n: number): number {
  if (n < 120) throw new Error('JOB_TIME_LIMIT_SEC must be at least 120');
  return n;
}

function atLeastOne(name: string, n: number): number {
  if (n < 1) throw new Error(`${name} must be at least 1`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const poolVar = env.API_DB_POOL_MAX_SIZE !== undefined ? 'API_DB_POOL_MAX_SIZE' : 'DB_POOL_MAX_SIZE';
  const workerPoolVar = env.WORKER_DB_POOL_MAX_SIZE !== undefined ? 'WORKER_DB_POOL_MAX_SIZE' : 'DB_POOL_MAX_SIZE';
  return {
    databaseUrl: str(env, 'DATABASE_URL', 'postgresql://ficino:ficino@postgres:5432/ficino'),
    environment: str(env, 'ENVIRONMENT', 'development'),
    authProvider: authProvider(str(env, 'AUTH_PROVIDER', 'none')),
    allowRegistration: parseBool(env.ALLOW_REGISTRATION, false),
    publicDeployment: parseBool(env.PUBLIC_DEPLOYMENT, false),
    corsOrigins: str(env, 'CORS_ORIGINS', 'https://ficino.app,https://ficino.ai')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cookieDomain: str(env, 'COOKIE_DOMAIN', ''),
    uploadDir: str(env, 'UPLOAD_DIR', '/app/uploads'),
    figuresDir: str(env, 'FIGURES_DIR', '/app/figures'),
    mediaDir: str(env, 'MEDIA_DIR', '/app/media'),
    maxUploadSizeMb: int(env, 'MAX_UPLOAD_SIZE_MB', 50),
    ollamaBaseUrl: str(env, 'OLLAMA_BASE_URL', 'http://host.docker.internal:11434'),
    elevenlabsApiKey: str(env, 'ELEVENLABS_API_KEY', ''),
    signedUrlKey: str(env, 'SIGNED_URL_KEY', '').trim(),
    searchUseNormalizedPosts: parseBool(env.SEARCH_USE_NORMALIZED_POSTS, true),
    dbPoolMax: poolMax(int(env, poolVar, 20)),
    workerDbPoolMax: poolMax(int(env, workerPoolVar, 10)),
    embedDim: embedDim(int(env, 'EMBED_DIM', 1024)),
    jobTimeLimitSec: jobTimeLimit(int(env, 'JOB_TIME_LIMIT_SEC', 600)),
    ingestionConcurrency: atLeastOne('WORKER_INGESTION_CONCURRENCY', int(env, 'WORKER_INGESTION_CONCURRENCY', 1)),
    maxVisionPages: int(env, 'MAX_VISION_PAGES', 100),
    contextMaxPaperChars: int(env, 'CONTEXT_MAX_PAPER_CHARS', 200000),
    contextMaxTokens: int(env, 'CONTEXT_MAX_TOKENS', 150),
    port: int(env, 'PORT', 8000),
    rateLimits: {
      paper_upload: int(env, 'RATE_LIMIT_UPLOADS_PER_DAY', 50),
      feed_generation: int(env, 'RATE_LIMIT_GENERATIONS_PER_DAY', 20),
      user_post: int(env, 'RATE_LIMIT_USER_POSTS_PER_DAY', 30),
      summary: int(env, 'RATE_LIMIT_SUMMARY_PER_DAY', 30),
      reply: int(env, 'RATE_LIMIT_REPLIES_PER_DAY', 60),
      persona_dm: int(env, 'RATE_LIMIT_PERSONA_DM_PER_DAY', 60),
      audio: int(env, 'RATE_LIMIT_AUDIO_PER_DAY', 20),
    },
  };
}
