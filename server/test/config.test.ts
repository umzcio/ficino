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
  for (const t of ['1', 'true', 'TRUE', 'yes', 'on', 'y', 't']) expect(parseBool(t, false)).toBe(true);
  for (const f of ['0', 'false', 'no', 'off', 'n', 'f']) expect(parseBool(f, true)).toBe(false);
  expect(parseBool(undefined, true)).toBe(true);
});
it('CORS_ORIGINS splits on commas and drops blanks', () => {
  expect(loadConfig({ CORS_ORIGINS: 'https://a, ,https://b' }).corsOrigins).toEqual(['https://a', 'https://b']);
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
