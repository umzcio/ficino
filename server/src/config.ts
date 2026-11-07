import { logger } from './logger.js';
import { pyStrip } from './shared/pystr.js';

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
  /** `MAX_JSON_BODY_KB`: the request body cap for every route except the `POST /papers` upload (which has its own). */
  maxJsonBodyKb: number;
  ollamaBaseUrl: string;
  elevenlabsApiKey: string;
  /** `ELEVENLABS_MODEL_ID`: the single-voice text-to-speech model (worker/lib/tts.py). */
  elevenlabsModelId: string;
  /** `ELEVENLABS_DIALOGUE_MODEL_ID`: the one-call text-to-dialogue model (worker/lib/tts.py). */
  elevenlabsDialogueModelId: string;
  signedUrlKey: string;
  /**
   * `PUBLIC_API_BASE`: the path the browser reaches this API under (the frontend's relative `VITE_API_BASE`),
   * prefixed to the media URLs `GET /feed/{id}` returns. Same-origin only: `''` or a path, never an origin.
   */
  publicApiBase: string;
  searchUseNormalizedPosts: boolean;
  dbPoolMax: number;
  workerDbPoolMax: number;
  embedDim: number;
  jobTimeLimitSec: number;
  ingestionConcurrency: number;
  maxVisionPages: number;
  /** `MAX_PDF_PAGES`: an upload with more pages than this is rejected when it is opened (paper error). */
  maxPdfPages: number;
  /** `FIGURE_DETECT_MAX_PAGES`: figure detection reads and sends only the first this-many pages. */
  figureDetectMaxPages: number;
  contextMaxPaperChars: number;
  contextMaxTokens: number;
  /** `CONTEXT_MAX_CHUNKS`: a paper with more chunks than this gets no contextual prefixes (no provider calls). */
  contextMaxChunks: number;
  port: number;
  retrieval: {
    vectorWeight: number;
    keywordWeight: number;
    maxVectorDistance: number;
    candidatePool: number;
    rerankMultiplier: number;
  };
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

/**
 * pydantic's bool spellings. Unset or blank uses the fallback (compose passes `VAR=` as ''); anything
 * else unrecognised throws, so a typo like `ALLOW_REGISTRATION=ture` fails at boot instead of silently
 * meaning the default.
 */
export function parseBool(name: string, v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === '') return fallback;
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  throw new Error(`${name} must be a boolean, got: ${v}`);
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

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SPECIAL_RE = /^([+-]?)(inf|infinity|nan)$/i;

/** Python `float(str)` or null where it raises ValueError. */
function pyFloatStr(raw: string): number | null {
  const s = pyStrip(raw).replace(/(?<=\d)_(?=\d)/g, '');
  const sp = SPECIAL_RE.exec(s);
  if (sp) return sp[2]!.toLowerCase() === 'nan' ? Number.NaN : sp[1] === '-' ? -Infinity : Infinity;
  return FLOAT_RE.test(s) ? Number(s) : null;
}

/** retrieval.py `_clamp_weight`: unparsable -> warning + default; otherwise clamped to [0, 1] (NaN gives 1.0, as max/min do). */
function clampWeight(env: Env, name: string, fallback: number, log: ConfigLog): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const v = pyFloatStr(raw);
  if (v === null) {
    log.warn({ key: name, value: raw }, 'invalid_weight_env');
    return fallback;
  }
  if (Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
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

const PUBLIC_API_BASE_RE = /^(\/[A-Za-z0-9._~-]+)+$/;

function publicApiBase(v: string): string {
  if (v === '' || PUBLIC_API_BASE_RE.test(v)) return v;
  throw new Error('PUBLIC_API_BASE must be empty or a path like /ficino/api');
}

/** Where config-time warnings go; defaults to the process logger. */
export type ConfigLog = { warn(obj: object, msg: string): void };

export function loadConfig(env: Env = process.env, log: ConfigLog = logger): Config {
  const poolVar = env.API_DB_POOL_MAX_SIZE !== undefined ? 'API_DB_POOL_MAX_SIZE' : 'DB_POOL_MAX_SIZE';
  const workerPoolVar = env.WORKER_DB_POOL_MAX_SIZE !== undefined ? 'WORKER_DB_POOL_MAX_SIZE' : 'DB_POOL_MAX_SIZE';
  return {
    databaseUrl: str(env, 'DATABASE_URL', 'postgresql://ficino:ficino@postgres:5432/ficino'),
    environment: str(env, 'ENVIRONMENT', 'development'),
    authProvider: authProvider(str(env, 'AUTH_PROVIDER', 'none')),
    allowRegistration: parseBool('ALLOW_REGISTRATION', env.ALLOW_REGISTRATION, false),
    publicDeployment: parseBool('PUBLIC_DEPLOYMENT', env.PUBLIC_DEPLOYMENT, false),
    corsOrigins: str(env, 'CORS_ORIGINS', 'https://ficino.app,https://ficino.ai')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cookieDomain: str(env, 'COOKIE_DOMAIN', ''),
    uploadDir: str(env, 'UPLOAD_DIR', '/app/uploads'),
    figuresDir: str(env, 'FIGURES_DIR', '/app/figures'),
    mediaDir: str(env, 'MEDIA_DIR', '/app/media'),
    maxUploadSizeMb: int(env, 'MAX_UPLOAD_SIZE_MB', 50),
    maxJsonBodyKb: atLeastOne('MAX_JSON_BODY_KB', int(env, 'MAX_JSON_BODY_KB', 1024)),
    ollamaBaseUrl: str(env, 'OLLAMA_BASE_URL', 'http://host.docker.internal:11434'),
    elevenlabsApiKey: str(env, 'ELEVENLABS_API_KEY', ''),
    elevenlabsModelId: str(env, 'ELEVENLABS_MODEL_ID', 'eleven_turbo_v2_5'),
    elevenlabsDialogueModelId: str(env, 'ELEVENLABS_DIALOGUE_MODEL_ID', 'eleven_v3'),
    signedUrlKey: str(env, 'SIGNED_URL_KEY', '').trim(),
    publicApiBase: publicApiBase(str(env, 'PUBLIC_API_BASE', '/ficino/api')),
    searchUseNormalizedPosts: parseBool('SEARCH_USE_NORMALIZED_POSTS', env.SEARCH_USE_NORMALIZED_POSTS, true),
    dbPoolMax: poolMax(int(env, poolVar, 20)),
    workerDbPoolMax: poolMax(int(env, workerPoolVar, 10)),
    embedDim: embedDim(int(env, 'EMBED_DIM', 1024)),
    jobTimeLimitSec: jobTimeLimit(int(env, 'JOB_TIME_LIMIT_SEC', 600)),
    ingestionConcurrency: atLeastOne('WORKER_INGESTION_CONCURRENCY', int(env, 'WORKER_INGESTION_CONCURRENCY', 1)),
    maxVisionPages: int(env, 'MAX_VISION_PAGES', 100),
    maxPdfPages: atLeastOne('MAX_PDF_PAGES', int(env, 'MAX_PDF_PAGES', 500)),
    figureDetectMaxPages: atLeastOne('FIGURE_DETECT_MAX_PAGES', int(env, 'FIGURE_DETECT_MAX_PAGES', 60)),
    contextMaxPaperChars: int(env, 'CONTEXT_MAX_PAPER_CHARS', 200000),
    contextMaxTokens: int(env, 'CONTEXT_MAX_TOKENS', 150),
    contextMaxChunks: atLeastOne('CONTEXT_MAX_CHUNKS', int(env, 'CONTEXT_MAX_CHUNKS', 200)),
    port: int(env, 'PORT', 8000),
    retrieval: {
      vectorWeight: clampWeight(env, 'RETRIEVAL_VECTOR_WEIGHT', 0.7, log),
      keywordWeight: clampWeight(env, 'RETRIEVAL_KEYWORD_WEIGHT', 0.3, log),
      maxVectorDistance: clampWeight(env, 'RETRIEVAL_MAX_VECTOR_DISTANCE', 0.8, log),
      candidatePool: int(env, 'RETRIEVAL_CANDIDATE_POOL', 100),
      rerankMultiplier: int(env, 'RETRIEVAL_RERANK_MULTIPLIER', 5),
    },
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
