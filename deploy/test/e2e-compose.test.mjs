// Invariants of the loopback e2e stack (docker-compose.e2e.yml, project ficino-e2e), its env file,
// its driver script and the Playwright harness defaults that point at it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO, composeConfig } from './helpers.mjs';

const E2E = ['docker-compose.e2e.yml'];
// Pin the knobs to "unset" (compose's `:-` treats empty as unset) so the caller's shell never leaks in.
const DEFAULTS = { FICINO_E2E_PORT: '', E2E_OLLAMA_BASE_URL: '' };
const e2e = (env = {}) => composeConfig(E2E, { ...DEFAULTS, ...env });
const portTriples = (s) =>
  (s.ports ?? []).map((p) => ({ host_ip: p.host_ip, published: String(p.published), target: p.target }));

test('the e2e project never collides with the production names', async () => {
  const c = await e2e();
  assert.equal(c.name, 'ficino-e2e');
  assert.deepEqual(Object.keys(c.services).sort(), ['api', 'postgres', 'web', 'worker']);
  for (const [n, s] of Object.entries(c.services)) assert.match(s.container_name ?? '', /^ficino-e2e-/, n);
  assert.equal(c.services.postgres.container_name, 'ficino-e2e-postgres');
  assert.equal(c.services.api.container_name, 'ficino-e2e-api');
  assert.equal(c.services.worker.container_name, 'ficino-e2e-worker');
  assert.equal(c.services.web.container_name, 'ficino-e2e-web');
  for (const [k, n] of Object.entries(c.networks ?? {})) assert.notEqual(n.name, 'ficino-network', k);
  assert.equal(c.services.api.image, 'ficino-server:e2e');
  assert.equal(c.services.worker.image, 'ficino-server:e2e');
  assert.equal(c.services.web.image, 'ficino-web:e2e');
  for (const [n, s] of Object.entries(c.services)) assert.notEqual(s.restart, 'unless-stopped', n);
});

test('only the web publishes, on loopback', async () => {
  const c = await e2e();
  assert.deepEqual(portTriples(c.services.web), [{ host_ip: '127.0.0.1', published: '3070', target: 80 }]);
  for (const [n, s] of Object.entries(c.services)) if (n !== 'web') assert.equal(s.ports, undefined, n);
});

test('the port follows FICINO_E2E_PORT', async () => {
  const c = await e2e({ FICINO_E2E_PORT: '3999' });
  assert.deepEqual(portTriples(c.services.web), [{ host_ip: '127.0.0.1', published: '3999', target: 80 }]);
  assert.equal(c.services.api.environment.CORS_ORIGINS, 'http://localhost:3999');
});

test('the stock frontend nginx finds the API by its alias', async () => {
  const { api, web } = (await e2e()).services;
  assert.ok(api.networks.default.aliases.includes('ficino-api'));
  assert.ok(Object.keys(web.networks).includes('default'));
  assert.match(web.build.context, /\/frontend$/);
  assert.equal(web.depends_on.api.condition, 'service_healthy');
});

test('providers default to a dead Ollama and can point at a real one', async () => {
  const dead = (await e2e()).services;
  for (const n of ['api', 'worker']) assert.equal(dead[n].environment.OLLAMA_BASE_URL, 'http://127.0.0.1:9', n);
  const real = (await e2e({ E2E_OLLAMA_BASE_URL: 'http://host.docker.internal:11434' })).services;
  for (const n of ['api', 'worker']) {
    assert.equal(real[n].environment.OLLAMA_BASE_URL, 'http://host.docker.internal:11434', n);
    assert.ok(real[n].extra_hosts.includes('host.docker.internal=host-gateway'), n);
  }
});

test('the worker mirrors production', async () => {
  const { api, worker } = (await e2e()).services;
  const sources = (s) => (s.volumes ?? []).map((v) => `${v.source}:${v.target}`).sort();
  assert.deepEqual(worker.command, ['node', 'dist/worker/main.js']);
  assert.equal(worker.healthcheck?.disable, true);
  assert.equal(worker.stop_grace_period, '45s');
  assert.deepEqual(sources(worker), sources(api));
  assert.deepEqual(sources(api), ['figures:/app/figures', 'media:/app/media', 'uploads:/app/uploads']);
  assert.equal(worker.build, undefined);
  assert.equal(worker.pull_policy, 'never');
  assert.match(api.build.context, /\/server$/);
  assert.ok(api.healthcheck.test.join(' ').includes('http://127.0.0.1:8000/health'));
  assert.deepEqual(worker.environment, api.environment);
});

test('postgres matches the server DATABASE_URL and the harness psql defaults', async () => {
  const { postgres, api, worker } = (await e2e()).services;
  assert.equal(postgres.image, 'pgvector/pgvector:pg18');
  for (const [k, v] of Object.entries({ POSTGRES_USER: 'ficino', POSTGRES_PASSWORD: 'ficino', POSTGRES_DB: 'ficino' })) {
    assert.equal(postgres.environment[k], v, k);
  }
  assert.deepEqual(postgres.volumes.map((v) => `${v.source}:${v.target}`), ['pgdata:/var/lib/postgresql']);
  assert.ok(postgres.healthcheck.test.join(' ').includes('pg_isready'));
  assert.equal(api.depends_on.postgres.condition, 'service_healthy');
  assert.equal(worker.depends_on.postgres.condition, 'service_healthy');
  for (const [n, s] of Object.entries({ api, worker })) {
    assert.equal(s.environment.DATABASE_URL, 'postgresql://ficino:ficino@postgres:5432/ficino', n);
  }
});

test('the harness defaults point at the e2e stack, never production', () => {
  const ef = readFileSync(join(REPO, 'tests/e2e/helpers/ensureFeed.ts'), 'utf8');
  assert.match(ef, /E2E_PSQL_CONTAINER \|\| 'ficino-e2e-postgres'/);
  assert.match(ef, /E2E_API_CONTAINER \|\| 'ficino-e2e-api'/);
  assert.doesNotMatch(ef, /\|\| 'ficino-(postgres|api)'/);
  assert.match(readFileSync(join(REPO, 'playwright.config.ts'), 'utf8'), /E2E_BASE_URL \|\| 'http:\/\/localhost:3070\/ficino\/'/);
  const files = execFileSync('git', ['ls-files', 'tests/e2e', 'playwright.config.ts'], { cwd: REPO, encoding: 'utf8' })
    .trim()
    .split('\n');
  for (const f of files.filter((f) => /\.(ts|mjs|js)$/.test(f))) {
    assert.doesNotMatch(readFileSync(join(REPO, f), 'utf8'), /localhost:3000/, f);
  }
});

test('the stack script is executable on disk and in the index', () => {
  assert.ok(statSync(join(REPO, 'scripts/e2e-stack.sh')).mode & 0o111);
  assert.match(
    execFileSync('git', ['ls-files', '-s', 'scripts/e2e-stack.sh'], { cwd: REPO, encoding: 'utf8' }),
    /^100755 /,
  );
});

// The e2e configuration lives inline in the compose file: dummy values, no env file, no secrets.
// (The plan had it in a rewritten .env.ci; the repo's block-env-files guard rejects commits to .env.*.)
test('the e2e stack carries no secret, no env file and no legacy variable', async () => {
  const c = await e2e();
  for (const [n, s] of Object.entries(c.services)) assert.equal(s.env_file, undefined, n);
  const { api } = c.services;
  for (const k of Object.keys(api.environment)) assert.doesNotMatch(k, /REDIS|CELERY|SUPABASE|_API_KEY$|SECRET|TOKEN/, k);
  assert.equal(api.environment.AUTH_PROVIDER, 'none');
  assert.equal(api.environment.ENVIRONMENT, 'test');
  assert.equal(api.environment.EMBED_DIM, '1024');
  assert.equal(api.environment.PUBLIC_DEPLOYMENT, 'false');
  for (const k of ['LLM_PROVIDER', 'EMBED_PROVIDER', 'VISION_PROVIDER', 'FIGURE_DETECT_PROVIDER']) {
    assert.equal(api.environment[k], 'ollama', k);
  }
  for (const k of Object.keys(api.environment)) assert.doesNotMatch(k, /_MODEL$/, `${k}: the server defaults pick the models`);
  assert.doesNotMatch(readFileSync(join(REPO, 'docker-compose.e2e.yml'), 'utf8'), /\.env|:\?/);
});

test('the stack script always targets the e2e project', () => {
  const sh = readFileSync(join(REPO, 'scripts/e2e-stack.sh'), 'utf8');
  const lines = sh.split('\n').filter((l) => /docker compose/.test(l));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /-p ficino-e2e -f docker-compose\.e2e\.yml/);
  execFileSync('bash', ['-n', join(REPO, 'scripts/e2e-stack.sh')]);
});

test('the stack script rejects an unknown command with usage and exit 2', () => {
  let err;
  try {
    execFileSync(join(REPO, 'scripts/e2e-stack.sh'), ['bogus'], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected a non-zero exit');
  assert.equal(err.status, 2);
  assert.match(err.stderr, /usage/i);
});

test('ci and full run Playwright only against the port the e2e web publishes', () => {
  const sh = readFileSync(join(REPO, 'scripts/e2e-stack.sh'), 'utf8');
  assert.match(sh, /docker port ficino-e2e-web 80\/tcp/);
  assert.match(sh, /grep -qxF "127\.0\.0\.1:\$\{PORT\}"/);
  const body = sh.slice(sh.indexOf('run_suite() {'));
  assert.ok(body.indexOf('assert_e2e_port') < body.indexOf('npx playwright'), 'the check runs before Playwright');

  // A port no e2e web publishes (8080 is the loopback override's): exit non-zero, Playwright never starts.
  const bin = mkdtempSync(join(tmpdir(), 'ficino-e2e-port-'));
  try {
    const marker = join(bin, 'npx-ran');
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    for (const cmd of ['ci', 'full']) {
      let err;
      try {
        execFileSync(join(REPO, 'scripts/e2e-stack.sh'), [cmd], {
          cwd: REPO,
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FICINO_E2E_PORT: '8080' },
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, `${cmd}: expected a non-zero exit`);
      assert.equal(err.status, 1, cmd);
      assert.match(err.stderr, /ficino-e2e-web is not running|is not the e2e web/, cmd);
      assert.equal(existsSync(marker), false, `${cmd}: Playwright must not run`);
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
