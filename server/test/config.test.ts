import { expect, it } from 'vitest';
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
