import { expect, it, vi } from 'vitest';
import { loadConfig, parseBool } from '../src/config.js';

it('defaults match api/config.py', () => {
  const c = loadConfig({});
  expect(c.databaseUrl).toBe('postgresql://ficino:ficino@postgres:5432/ficino');
  expect(c.environment).toBe('development');
  expect(c.authProvider).toBe('none');
  expect(c.corsOrigins).toEqual(['https://ficino.app', 'https://ficino.ai']);
  expect([c.uploadDir, c.figuresDir, c.mediaDir]).toEqual(['/app/uploads', '/app/figures', '/app/media']);
  expect(c.maxUploadSizeMb).toBe(50);
  expect(c.ollamaBaseUrl).toBe('http://host.docker.internal:11434');
  expect(c.rateLimits).toEqual({ paper_upload: 50, feed_generation: 20, user_post: 30, summary: 30, reply: 60, persona_dm: 60, audio: 20 });
  expect(c.dbPoolMax).toBe(20);
  expect(c.port).toBe(8000);
});
it('AUTH_PROVIDER=supabase is rejected', () => {
  expect(() => loadConfig({ AUTH_PROVIDER: 'supabase' })).toThrow('AUTH_PROVIDER=supabase is no longer supported');
});
it('unknown AUTH_PROVIDER is rejected', () => {
  expect(() => loadConfig({ AUTH_PROVIDER: 'ldap' })).toThrow('Unknown AUTH_PROVIDER: ldap');
});
it('parseBool accepts pydantic truthy/falsy spellings', () => {
  for (const t of ['1', 'true', 'TRUE', 'yes', 'on', 'y', 't', ' True ']) expect(parseBool('X', t, false)).toBe(true);
  for (const f of ['0', 'false', 'no', 'off', 'n', 'f', ' OFF ']) expect(parseBool('X', f, true)).toBe(false);
  expect(parseBool('X', undefined, true)).toBe(true);
});
it('parseBool names the variable it rejects', () => {
  expect(() => parseBool('X', 'maybe', false)).toThrow('X must be a boolean, got: maybe');
});
it('parseBool: an empty or blank value uses the fallback', () => {
  expect(parseBool('X', '', true)).toBe(true);
  expect(parseBool('X', '  ', false)).toBe(false);
});
it('rejects a misspelled boolean', () => {
  expect(() => loadConfig({ ALLOW_REGISTRATION: 'ture' })).toThrow('ALLOW_REGISTRATION must be a boolean, got: ture');
  expect(() => loadConfig({ PUBLIC_DEPLOYMENT: 'yep' })).toThrow('PUBLIC_DEPLOYMENT must be a boolean, got: yep');
  expect(() => loadConfig({ SEARCH_USE_NORMALIZED_POSTS: '2' })).toThrow(
    'SEARCH_USE_NORMALIZED_POSTS must be a boolean, got: 2',
  );
});
it('an empty boolean uses the default', () => {
  expect(loadConfig({ PUBLIC_DEPLOYMENT: '' }).publicDeployment).toBe(false);
  expect(loadConfig({ SEARCH_USE_NORMALIZED_POSTS: '' }).searchUseNormalizedPosts).toBe(true);
});
it('CORS_ORIGINS splits on commas and drops blanks', () => {
  expect(loadConfig({ CORS_ORIGINS: 'https://a, ,https://b' }).corsOrigins).toEqual(['https://a', 'https://b']);
});
it('ALLOWED_HOSTS: unset is no extra hosts; entries are trimmed, lowercased and stripped of ports', () => {
  expect(loadConfig({}).allowedHosts).toEqual([]);
  expect(loadConfig({ ALLOWED_HOSTS: '' }).allowedHosts).toEqual([]);
  expect(loadConfig({ ALLOWED_HOSTS: ' a.example, B.Example:8443 ,, [::1]:8000, ::1, 127.0.0.1 ' }).allowedHosts).toEqual([
    'a.example',
    'b.example',
    '::1',
    '::1',
    '127.0.0.1',
  ]);
});
it('ALLOWED_HOSTS=* (alone or in the list) turns the host check off', () => {
  expect(loadConfig({ ALLOWED_HOSTS: '*' }).allowedHosts).toBe('*');
  expect(loadConfig({ ALLOWED_HOSTS: 'a.example, *' }).allowedHosts).toBe('*');
});
it('ALLOWED_HOSTS rejects an entry that is not a host name', () => {
  expect(() => loadConfig({ ALLOWED_HOSTS: 'a.example,https://b.example' })).toThrow(
    'ALLOWED_HOSTS entry is not a host name: https://b.example',
  );
  expect(() => loadConfig({ ALLOWED_HOSTS: 'a/b' })).toThrow('ALLOWED_HOSTS entry is not a host name: a/b');
});
it('pool size prefers API_DB_POOL_MAX_SIZE over DB_POOL_MAX_SIZE', () => {
  expect(loadConfig({ DB_POOL_MAX_SIZE: '7' }).dbPoolMax).toBe(7);
  expect(loadConfig({ DB_POOL_MAX_SIZE: '7', API_DB_POOL_MAX_SIZE: '9' }).dbPoolMax).toBe(9);
});

it('rejects a DB pool max below 2 (migrate would deadlock)', () => {
  expect(() => loadConfig({ DB_POOL_MAX_SIZE: '1' })).toThrow('DB pool max must be at least 2 (got 1)');
  expect(() => loadConfig({ API_DB_POOL_MAX_SIZE: '0' })).toThrow('DB pool max must be at least 2 (got 0)');
  expect(loadConfig({ DB_POOL_MAX_SIZE: '2' }).dbPoolMax).toBe(2);
});

it('worker defaults', () => {
  const c = loadConfig({});
  expect(c.workerDbPoolMax).toBe(10);
  expect(c.embedDim).toBe(1024);
  expect(c.jobTimeLimitSec).toBe(600);
  expect(c.ingestionConcurrency).toBe(1);
  expect(c.maxVisionPages).toBe(100);
  expect(c.contextMaxPaperChars).toBe(200000);
  expect(c.contextMaxTokens).toBe(150);
  expect(c.contextMaxChunks).toBe(200);
  expect(c.maxPdfPages).toBe(500);
  expect(c.figureDetectMaxPages).toBe(60);
});
it('MAX_PDF_PAGES and FIGURE_DETECT_MAX_PAGES are read and must be at least 1', () => {
  const c = loadConfig({ MAX_PDF_PAGES: '40', FIGURE_DETECT_MAX_PAGES: '7' });
  expect([c.maxPdfPages, c.figureDetectMaxPages]).toEqual([40, 7]);
  expect(() => loadConfig({ MAX_PDF_PAGES: '0' })).toThrow('MAX_PDF_PAGES must be at least 1');
  expect(() => loadConfig({ FIGURE_DETECT_MAX_PAGES: '0' })).toThrow('FIGURE_DETECT_MAX_PAGES must be at least 1');
});
it('MAX_PAGE_CHARS and PDF_THREAD_HEAP_MB are read with their defaults and floors', () => {
  const d = loadConfig({});
  expect([d.maxPageChars, d.pdfThreadHeapMb]).toEqual([200_000, 1024]);
  const c = loadConfig({ MAX_PAGE_CHARS: '5000', PDF_THREAD_HEAP_MB: '256' });
  expect([c.maxPageChars, c.pdfThreadHeapMb]).toEqual([5000, 256]);
  expect(() => loadConfig({ MAX_PAGE_CHARS: '0' })).toThrow('MAX_PAGE_CHARS must be at least 1');
  expect(() => loadConfig({ PDF_THREAD_HEAP_MB: '63' })).toThrow('PDF_THREAD_HEAP_MB must be at least 64');
});
it('CONTEXT_MAX_CHUNKS is read and must be at least 1', () => {
  expect(loadConfig({ CONTEXT_MAX_CHUNKS: '50' }).contextMaxChunks).toBe(50);
  expect(() => loadConfig({ CONTEXT_MAX_CHUNKS: '0' })).toThrow('CONTEXT_MAX_CHUNKS must be at least 1');
});
it('worker pool prefers WORKER_DB_POOL_MAX_SIZE, falls back to DB_POOL_MAX_SIZE, guards >= 2', () => {
  expect(loadConfig({ DB_POOL_MAX_SIZE: '7' }).workerDbPoolMax).toBe(7);
  expect(loadConfig({ DB_POOL_MAX_SIZE: '7', WORKER_DB_POOL_MAX_SIZE: '4' }).workerDbPoolMax).toBe(4);
  expect(() => loadConfig({ WORKER_DB_POOL_MAX_SIZE: '1' })).toThrow('DB pool max must be at least 2 (got 1)');
});
it('EMBED_DIM other than 1024 throws', () => {
  expect(() => loadConfig({ EMBED_DIM: '768' })).toThrow('EMBED_DIM must be 1024 (chunks.embedding is vector(1024))');
  expect(loadConfig({ EMBED_DIM: '1024' }).embedDim).toBe(1024);
});
it('JOB_TIME_LIMIT_SEC below 120 throws', () => {
  expect(() => loadConfig({ JOB_TIME_LIMIT_SEC: '60' })).toThrow('JOB_TIME_LIMIT_SEC must be at least 120');
  expect(loadConfig({ JOB_TIME_LIMIT_SEC: '120' }).jobTimeLimitSec).toBe(120);
});
it('ingestion concurrency must be >= 1', () => {
  expect(() => loadConfig({ WORKER_INGESTION_CONCURRENCY: '0' })).toThrow('WORKER_INGESTION_CONCURRENCY must be at least 1');
});

it('retrieval defaults', () => {
  expect(loadConfig({}).retrieval).toEqual({
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    maxVectorDistance: 0.8,
    candidatePool: 100,
    rerankMultiplier: 5,
  });
});
it('unparsable retrieval weight warns and uses the default', () => {
  const warn = vi.fn();
  expect(loadConfig({ RETRIEVAL_VECTOR_WEIGHT: 'abc' }, { warn }).retrieval.vectorWeight).toBe(0.7);
  expect(warn).toHaveBeenCalledWith({ key: 'RETRIEVAL_VECTOR_WEIGHT', value: 'abc' }, 'invalid_weight_env');
});
it('retrieval weights clamp to [0, 1]', () => {
  const r = loadConfig({ RETRIEVAL_VECTOR_WEIGHT: '1.7', RETRIEVAL_KEYWORD_WEIGHT: '-2', RETRIEVAL_MAX_VECTOR_DISTANCE: 'inf' }).retrieval;
  expect([r.vectorWeight, r.keywordWeight, r.maxVectorDistance]).toEqual([1, 0, 1]);
});
it('retrieval int fields throw on a non-integer', () => {
  expect(() => loadConfig({ RETRIEVAL_CANDIDATE_POOL: 'ten' })).toThrow();
  expect(loadConfig({ RETRIEVAL_RERANK_MULTIPLIER: '3' }).retrieval.rerankMultiplier).toBe(3);
});

it('ElevenLabs model ids default to tts.py and take env overrides', () => {
  const d = loadConfig({});
  expect(d.elevenlabsModelId).toBe('eleven_turbo_v2_5');
  expect(d.elevenlabsDialogueModelId).toBe('eleven_v3');
  const o = loadConfig({ ELEVENLABS_MODEL_ID: 'eleven_flash_v2_5', ELEVENLABS_DIALOGUE_MODEL_ID: 'eleven_v3_alpha' });
  expect(o.elevenlabsModelId).toBe('eleven_flash_v2_5');
  expect(o.elevenlabsDialogueModelId).toBe('eleven_v3_alpha');
});

it('PUBLIC_API_BASE defaults to /ficino/api, allows empty and nested paths, rejects anything else', () => {
  expect(loadConfig({}).publicApiBase).toBe('/ficino/api');
  expect(loadConfig({ PUBLIC_API_BASE: '' }).publicApiBase).toBe('');
  expect(loadConfig({ PUBLIC_API_BASE: '/x/y' }).publicApiBase).toBe('/x/y');
  expect(loadConfig({ PUBLIC_API_BASE: '/api' }).publicApiBase).toBe('/api');
  for (const bad of ['x/', '/x/', '/x y', '/', 'https://api.example.test', '/x//y']) {
    expect(() => loadConfig({ PUBLIC_API_BASE: bad }), bad).toThrow('PUBLIC_API_BASE must be empty or a path like /ficino/api');
  }
});

const DEFAULT_TRUSTED_PROXIES = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

it('TRUSTED_PROXIES defaults to the loopback and private ranges (unset or blank)', () => {
  expect(loadConfig({}).trustedProxies).toEqual(DEFAULT_TRUSTED_PROXIES);
  expect(loadConfig({ TRUSTED_PROXIES: '' }).trustedProxies).toEqual(DEFAULT_TRUSTED_PROXIES);
  expect(loadConfig({ TRUSTED_PROXIES: '  ' }).trustedProxies).toEqual(DEFAULT_TRUSTED_PROXIES);
});
it('TRUSTED_PROXIES takes a comma list of addresses and CIDRs; a bare address is one host', () => {
  expect(loadConfig({ TRUSTED_PROXIES: ' 172.18.0.0/16 ,, 203.0.113.5, 2001:DB8::/32, ::1 ' }).trustedProxies).toEqual([
    '172.18.0.0/16',
    '203.0.113.5/32',
    '2001:db8::/32',
    '::1/128',
  ]);
});
it('TRUSTED_PROXIES=none trusts no proxy', () => {
  expect(loadConfig({ TRUSTED_PROXIES: 'none' }).trustedProxies).toEqual([]);
  expect(loadConfig({ TRUSTED_PROXIES: ' NONE ' }).trustedProxies).toEqual([]);
});
it('TRUSTED_PROXIES rejects an entry that is not an address or CIDR', () => {
  for (const bad of ['proxy.example', '10.0.0.0/33', '::/129', '10.0.0.0/', '10.0.0/8', '10.0.0.0/8/1', '*', 'none,10.0.0.1']) {
    expect(() => loadConfig({ TRUSTED_PROXIES: bad }), bad).toThrow('TRUSTED_PROXIES entry is not an IP address or CIDR');
  }
});
