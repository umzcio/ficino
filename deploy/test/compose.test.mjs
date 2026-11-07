// Invariants of the tracked, generic docker-compose.yml (no published ports, kept names, pg18).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO, composeConfig } from './helpers.mjs';

const base = () => composeConfig(['docker-compose.yml']);
const volumePairs = (s) =>
  (s.volumes ?? []).map((v) => `${v.source}:${v.target}`).sort();

test('base compose has the four services under their kept names', async () => {
  const c = await base();
  assert.deepEqual(Object.keys(c.services).sort(), ['api', 'postgres', 'web', 'worker']);
  assert.equal(c.services.postgres.container_name, 'ficino-postgres');
  assert.equal(c.services.api.container_name, 'ficino-api');
  assert.equal(c.services.worker.container_name, 'ficino-worker');
  assert.equal(c.services.web.container_name, 'ficino-web');
  assert.equal(c.networks['ficino-network'].name, 'ficino-network');
  assert.equal(c.name, 'ficino');
});

test('no service publishes a port', async () => {
  const c = await base();
  for (const [n, s] of Object.entries(c.services)) assert.equal(s.ports, undefined, n);
});

test('postgres is pgvector pg18 with the volume on /var/lib/postgresql', async () => {
  const pg = (await base()).services.postgres;
  assert.equal(pg.image, 'pgvector/pgvector:pg18');
  assert.equal(pg.volumes.length, 1);
  assert.equal(pg.volumes[0].type, 'volume');
  assert.equal(pg.volumes[0].source, 'pgdata');
  assert.equal(pg.volumes[0].target, '/var/lib/postgresql');
  assert.ok(pg.healthcheck.test.join(' ').includes('pg_isready'));
  for (const v of pg.volumes) assert.doesNotMatch(String(v.source), /\.sql$/);
  assert.equal(pg.environment.POSTGRES_PASSWORD, undefined, 'the password comes only from env_file');
});

test('api and worker share one image and the three data volumes', async () => {
  const { api, worker } = (await base()).services;
  const expected = ['figures:/app/figures', 'media:/app/media', 'uploads:/app/uploads'];
  for (const [n, s] of Object.entries({ api, worker })) {
    assert.equal(s.image, 'ficino-server:local', n);
    assert.deepEqual(volumePairs(s), expected, n);
    for (const v of s.volumes) assert.equal(v.type, 'volume', n);
  }
  assert.match(api.build.context, /\/server$/);
  assert.equal(worker.build, undefined);
  assert.equal(worker.pull_policy, 'never');
});

test('worker runs its own entry without the image healthcheck', async () => {
  const { worker } = (await base()).services;
  assert.deepEqual(worker.command, ['node', 'dist/worker/main.js']);
  assert.equal(worker.healthcheck?.disable, true);
  assert.equal(worker.stop_grace_period, '45s');
});

test('api healthcheck probes /health with a start period', async () => {
  const { api } = (await base()).services;
  assert.ok(api.healthcheck.test.join(' ').includes('http://127.0.0.1:8000/health'));
  assert.equal(api.healthcheck.start_period, '30s');
  assert.equal(api.healthcheck.interval, '10s');
  assert.equal(api.stop_grace_period, '20s');
});

test('api and worker map host.docker.internal to the host gateway', async () => {
  const { api, worker } = (await base()).services;
  for (const [n, s] of Object.entries({ api, worker })) {
    assert.ok(s.extra_hosts.includes('host.docker.internal=host-gateway'), n);
  }
});

test('web is the stock frontend build and waits for a healthy api', async () => {
  const { web } = (await base()).services;
  assert.match(web.build.context, /\/frontend$/);
  assert.equal(web.image, 'ficino-web:local');
  assert.equal(web.depends_on.api.condition, 'service_healthy');
});

test('only postgres, api and worker read the env file', async () => {
  const s = (await base()).services;
  assert.equal(s.web.env_file, undefined);
  for (const n of ['postgres', 'api', 'worker']) {
    assert.equal(s[n].env_file.length, 1, n);
    assert.match(s[n].env_file[0].path, /\/\.env$/, n);
    assert.equal(s[n].env_file[0].required, false, n);
  }
});

test('api and worker wait for a healthy postgres', async () => {
  const { api, worker } = (await base()).services;
  assert.equal(api.depends_on.postgres.condition, 'service_healthy');
  assert.equal(worker.depends_on.postgres.condition, 'service_healthy');
});

test('every service is on the ficino network', async () => {
  const c = await base();
  for (const [n, s] of Object.entries(c.services)) assert.deepEqual(Object.keys(s.networks), ['ficino-network'], n);
});

test('every built service names its image, never a legacy name', async () => {
  const c = await base();
  for (const [n, s] of Object.entries(c.services)) {
    if (s.build) assert.match(s.image ?? '', /^ficino-(server|web):/, n);
  }
});

test('the tracked compose interpolates no required variable', () => {
  const raw = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
  assert.doesNotMatch(raw, /\$\{[A-Z0-9_]+:\?/);
});

test('the server image healthcheck has interval and start period', () => {
  const df = readFileSync(join(REPO, 'server/Dockerfile'), 'utf8');
  assert.match(
    df,
    /HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 CMD wget -qO- http:\/\/127\.0\.0\.1:8000\/health/,
  );
});

test('the env example names only variables the server or the postgres image reads', () => {
  const raw = readFileSync(join(REPO, '.env.example'), 'utf8');
  const keys = [...raw.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  assert.ok(keys.includes('POSTGRES_PASSWORD'));
  assert.ok(keys.includes('SIGNED_URL_KEY'));
  const src = ['server/src/config.ts', 'server/src/settings/schema.ts']
    .map((f) => readFileSync(join(REPO, f), 'utf8'))
    .join('\n');
  for (const k of keys) {
    if (k === 'POSTGRES_PASSWORD') continue;
    assert.ok(src.includes(`'${k}'`) || src.includes(`env.${k}`), `${k} is not read by the server`);
  }
  for (const k of keys) assert.doesNotMatch(k, /REDIS|CELERY|SUPABASE|RAILWAY|POOL_MIN_SIZE/);
  assert.doesNotMatch(raw, /ficino\.(app|ai)\b/);
  assert.equal(existsSync(join(REPO, '.env.secrets.example')), false);
});
