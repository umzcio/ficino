import { isIP } from 'node:net';
import { logger } from './logger.js';
import { parseBool } from './shared/bool.js';
import { normalizeHost } from './shared/host.js';
import { pyStrip } from './shared/pystr.js';
import { isPublicDeployment } from './settings/schema.js';

export { parseBool };

export type Env = Record<string, string | undefined>;

export interface Config {
  databaseUrl: string;
  environment: string;
  authProvider: 'none' | 'basic';
  allowRegistration: boolean;
  publicDeployment: boolean;
  corsOrigins: string[];
  /**
   * `ALLOWED_HOSTS`: Host names the API answers to beyond loopback and the CORS_ORIGINS (and, in development,
   * dev-origin) hostnames; `'*'` turns the DNS-rebinding host check off. Entries are normalized (lowercase, no port).
   */
  allowedHosts: string[] | '*';
  /**
   * `TRUSTED_PROXIES`: the peers (CIDRs, `address/prefix`) whose `X-Real-IP` names the client for the per-IP
   * rate limits and the audit log; any other peer is the client itself. Default: loopback and private ranges.
   */
  trustedProxies: string[];
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
  /** `MAX_PAGE_CHARS`: a PDF page with more characters than this fails the paper (no retry). */
  maxPageChars: number;
  /** `MAX_PAPER_CHARS`: a paper whose extracted text (PDF or vision) is longer than this fails (no retry). */
  maxPaperChars: number;
  /** `PDF_THREAD_HEAP_MB`: the V8 heap cap of the thread that reads one paper's PDF; passing it fails the paper. */
  pdfThreadHeapMb: number;
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

function pdfThreadHeapMb(n: number): number {
  if (n < 64) throw new Error('PDF_THREAD_HEAP_MB must be at least 64');
  return n;
}

/** The browser origins allowed in development (CORS, and their hosts for the host check). */
export const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8000'];

/** `ALLOWED_HOSTS`: a comma list of host names (a port is ignored, IPv6 with or without brackets), or `*`. */
function allowedHosts(raw: string): string[] | '*' {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.includes('*')) return '*';
  return entries.map((e) => {
    // A bare IPv6 literal (two or more colons, no brackets) is bracketed so its colons are not read as a port.
    const unbracketedV6 = !e.startsWith('[') && e.indexOf(':') !== e.lastIndexOf(':');
    const host = normalizeHost(unbracketedV6 ? `[${e}]` : e);
    if (host === null) throw new Error(`ALLOWED_HOSTS entry is not a host name: ${e}`);
    return host;
  });
}

/** The addresses a reverse proxy in front of the api has on its compose network or the same machine. */
const DEFAULT_TRUSTED_PROXIES = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

/**
 * `TRUSTED_PROXIES`: a comma list of IP addresses and CIDRs (a bare address is one host), `none` for no proxy;
 * unset or blank gives the default. Entries come back as `address/prefix`, IPv6 lowercased.
 */
function trustedProxies(raw: string): string[] {
  const s = raw.trim();
  if (s === '') return [...DEFAULT_TRUSTED_PROXIES];
  if (s.toLowerCase() === 'none') return [];
  return s
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(e);
      const family = m ? isIP(m[1]!) : 0;
      const max = family === 4 ? 32 : 128;
      const prefix = m?.[2] === undefined ? max : Number(m[2]);
      if (family === 0 || prefix > max) throw new Error(`TRUSTED_PROXIES entry is not an IP address or CIDR: ${e}`);
      return `${family === 6 ? m![1]!.toLowerCase() : m![1]}/${prefix}`;
    });
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
    // The same parser gates every reassert of the operator env (settings/schema.ts), so the write lock and
    // stored-override resolution can never disagree about a spelling.
    publicDeployment: isPublicDeployment(env),
    corsOrigins: str(env, 'CORS_ORIGINS', 'https://ficino.app,https://ficino.ai')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedHosts: allowedHosts(str(env, 'ALLOWED_HOSTS', '')),
    trustedProxies: trustedProxies(str(env, 'TRUSTED_PROXIES', '')),
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
    maxPageChars: atLeastOne('MAX_PAGE_CHARS', int(env, 'MAX_PAGE_CHARS', 200_000)),
    maxPaperChars: atLeastOne('MAX_PAPER_CHARS', int(env, 'MAX_PAPER_CHARS', 3_000_000)),
    pdfThreadHeapMb: pdfThreadHeapMb(int(env, 'PDF_THREAD_HEAP_MB', 1024)),
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
