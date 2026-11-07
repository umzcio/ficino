// Invariants of the tailnet override example (deploy/tailnet/) layered on the base compose, and of
// the Serve config it mounts. Renders with `docker compose config`; starts nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { REPO, composeConfig, composeConfigFails } from './helpers.mjs';

const FILES = ['docker-compose.yml', 'deploy/tailnet/docker-compose.override.example.yml'];
const ENV = { FICINO_OWNER_LOGIN: 'owner@example.com' };
const rendered = () => composeConfig(FILES, ENV);

test('the sidecar is kernel-mode, unpinned and publishes nothing', async () => {
  const { ts } = (await rendered()).services;
  assert.ok(ts, 'the override adds service ts');
  assert.equal(ts.image, 'tailscale/tailscale:stable');
  assert.equal(ts.container_name, 'ficino-ts');
  assert.equal(ts.hostname, 'ficino');
  assert.equal(ts.ports, undefined);
  assert.equal(ts.environment.TS_USERSPACE, 'false');
  assert.equal(ts.environment.TS_AUTH_ONCE, 'true');
  assert.equal(ts.environment.TS_HOSTNAME, 'ficino');
  assert.equal(ts.environment.TS_STATE_DIR, '/var/lib/tailscale');
  assert.equal(ts.environment.TS_SERVE_CONFIG, '/config/serve.json');
  assert.equal(ts.environment.TS_AUTHKEY, undefined, 'the auth key comes only from tailscale.env');
  assert.ok(ts.cap_add.includes('NET_ADMIN'));
  assert.ok(ts.cap_add.includes('NET_RAW'));
  assert.ok(
    (ts.devices ?? []).some((d) => (typeof d === 'string' ? d.split(':')[0] : d.source) === '/dev/net/tun'),
    'ts gets /dev/net/tun',
  );
  const config = ts.volumes.find((v) => v.target === '/config');
  assert.ok(config, 'serve config mounted at /config');
  assert.equal(config.read_only, true);
  assert.match(config.source, /\/deploy\/tailnet$/);
  const state = ts.volumes.find((v) => v.target === '/var/lib/tailscale');
  assert.ok(state, 'state volume mounted');
  assert.equal(state.type, 'volume');
  assert.equal(state.source, 'ts-state');
  // web shares ts's namespace, and its `resolver 127.0.0.11` must find ficino-api there.
  assert.ok(Object.keys(ts.networks).includes('ficino-network'));
  assert.equal(ts.restart, 'unless-stopped');
});

test('the override declares the sidecar state volume', async () => {
  const c = await rendered();
  assert.ok(c.volumes && 'ts-state' in c.volumes);
});

test('the override appends the host env files to the base env file', async () => {
  const s = (await rendered()).services;
  const files = (svc) => svc.env_file?.map((e) => basename(e.path));
  assert.deepEqual(files(s.postgres), ['.env', 'postgres.env']);
  assert.deepEqual(files(s.api), ['.env', 'secrets.env']);
  assert.deepEqual(files(s.worker), ['.env', 'secrets.env']);
  assert.deepEqual(files(s.ts), ['tailscale.env']);
  assert.equal(s.web.env_file, undefined);
  // A required file that is missing would make `docker compose config` fail, which a host's sidecar
  // auto-updater runs for every sidecar.
  for (const n of ['postgres', 'api', 'worker', 'ts']) {
    for (const e of s[n].env_file) assert.equal(e.required, false, `${n} ${e.path}`);
  }
});

test('web lives in the sidecar namespace with the tailnet template', async () => {
  const { web } = (await rendered()).services;
  assert.equal(web.network_mode, 'service:ts');
  assert.equal(web.networks, undefined);
  assert.equal(web.ports, undefined);
  const tpl = web.volumes?.find((v) => v.target === '/etc/nginx/templates');
  assert.ok(tpl, 'template dir mounted');
  assert.equal(tpl.read_only, true);
  assert.match(tpl.source, /\/deploy\/web\/tailnet$/);
  assert.equal(web.environment.FICINO_OWNER_LOGIN, 'owner@example.com');
  assert.equal(web.image, 'ficino-web:local');
  assert.equal(web.container_name, 'ficino-web');
});

test('no service publishes a port', async () => {
  const c = await rendered();
  for (const [n, s] of Object.entries(c.services)) assert.equal(s.ports, undefined, n);
});

test('config refuses to render without an owner login', async () => {
  const err = await composeConfigFails(FILES, { FICINO_OWNER_LOGIN: '' });
  assert.match(err, /FICINO_OWNER_LOGIN/);
});

test('the owner login is the override\'s only required variable', () => {
  const raw = readFileSync(join(REPO, FILES[1]), 'utf8');
  const required = [...raw.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]);
  assert.deepEqual(required, ['FICINO_OWNER_LOGIN']);
  assert.doesNotMatch(raw, /^\s*ports:/m, 'the override publishes nothing');
});

test('serve.json proxies / to loopback 80 and never enables Funnel', () => {
  const raw = readFileSync(join(REPO, 'deploy/tailnet/serve.json'), 'utf8');
  const serve = JSON.parse(raw);
  assert.equal(serve.TCP['443'].HTTPS, true);
  assert.deepEqual(Object.keys(serve.TCP), ['443']);
  const web = serve.Web['${TS_CERT_DOMAIN}:443'];
  assert.ok(web, 'the Web handler uses the containerboot placeholder');
  assert.deepEqual(Object.keys(serve.Web), ['${TS_CERT_DOMAIN}:443']);
  assert.deepEqual(Object.keys(web.Handlers), ['/']);
  assert.equal(web.Handlers['/'].Proxy, 'http://127.0.0.1:80');
  const funnel = Object.values(serve.AllowFunnel ?? {});
  for (const v of funnel) assert.equal(v, false);
  assert.doesNotMatch(raw, /[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/, 'no tailnet name');
});

test('pre-commit check-yaml skips the override example', () => {
  // The example needs compose's `!reset` tag, which check-yaml's safe loader rejects.
  const pc = readFileSync(join(REPO, '.pre-commit-config.yaml'), 'utf8');
  const block = pc.slice(pc.indexOf('id: check-yaml'), pc.indexOf('id: check-json'));
  assert.match(block, /exclude: .*deploy\/tailnet\/docker-compose\\\.override\\\.example\\\.yml/);
  // infra/ left with the Python services (tag python-final): the example is the only exclusion.
  assert.match(block, /exclude: \^deploy\/tailnet\/docker-compose\\\.override\\\.example\\\.yml\$\n/);
});

test('the web image keeps the stock nginx entrypoint that renders templates', () => {
  // The tailnet template reaches conf.d/ only through the nginx image's entrypoint (envsubst step),
  // which runs when the final stage is nginx:alpine, keeps its ENTRYPOINT and starts `nginx`.
  const df = readFileSync(join(REPO, 'frontend/Dockerfile'), 'utf8');
  const finalStage = df.slice(df.lastIndexOf('\nFROM '));
  assert.match(finalStage, /^\nFROM nginx:alpine\s*$/m);
  assert.doesNotMatch(finalStage, /^ENTRYPOINT/m);
  assert.match(finalStage, /^CMD \["nginx",/m);
  assert.match(finalStage, /conf\.d\/security-headers\.conf/);
});
