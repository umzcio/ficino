// Behaviour of deploy/web/tailnet/default.conf.template in a real nginx:alpine container, rendered
// by the image's own envsubst step. Every container is a throwaway named `ficino-deploytest-<hex>-*`
// on an --internal network with no published port; after() removes them all.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { REPO, docker, dockerTry } from './helpers.mjs';

const PREFIX = `ficino-deploytest-${randomBytes(4).toString('hex')}`;
const NET = PREFIX;
const name = (role) => `${PREFIX}-${role}`;
const API = name('api');
const WEB = name('web');
const OWNER_LOGIN = 'owner@example.com';
const OWNER = { 'Tailscale-User-Login': OWNER_LOGIN };
const NGINX_IMAGE = 'nginx:alpine';
const CURL_IMAGE = 'curlimages/curl:8.11.1';
const STUB_IMAGE = 'node:24-alpine';

// Answers every request with the path and the two proxy headers the template sets.
const STUB = `require('http').createServer((q, s) => {
  s.setHeader('content-type', 'application/json');
  s.end(JSON.stringify({ path: q.url, xRealIp: q.headers['x-real-ip'] ?? null,
    xForwardedProto: q.headers['x-forwarded-proto'] ?? null }));
}).listen(8000, '0.0.0.0');`;

let curlSeq = 0;

/** Starts an nginx with the tailnet template; `env` is a list of `-e` values. */
function startWeb(container, env) {
  const args = ['run', '-d', '--name', container, '--network', NET];
  args.push('-v', `${join(REPO, 'deploy/web/tailnet')}:/etc/nginx/templates:ro`);
  args.push('-v', `${join(REPO, 'frontend/nginx-security-headers.conf')}:/etc/nginx/conf.d/security-headers.conf:ro`);
  for (const e of env) args.push('-e', e);
  args.push(NGINX_IMAGE);
  docker(...args);
}

/** One request from inside `container`'s network namespace (the sidecar's view: loopback). */
function curlIn(container, path, headers = {}) {
  const args = ['run', '--rm', '--name', name(`curl-${++curlSeq}`), '--network', `container:${container}`, CURL_IMAGE];
  args.push('-s', '-i', '--max-time', '5');
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(`http://127.0.0.1:80${path}`);
  return dockerTry(...args);
}

function parse(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  const head = sep === -1 ? raw : raw.slice(0, sep);
  const body = sep === -1 ? '' : raw.slice(sep + 4);
  const lines = head.split('\r\n');
  const status = Number(lines[0].split(' ')[1]);
  const loc = lines.find((l) => /^location:/i.test(l));
  return { status, location: loc ? loc.slice(loc.indexOf(':') + 1).trim() : undefined, body };
}

const reqTo = (container) => (path, headers = {}) => {
  const r = curlIn(container, path, headers);
  if (r.code !== 0) throw new Error(`curl ${path} failed (exit ${r.code}): ${r.stderr}`);
  return parse(r.stdout);
};
const req = reqTo(WEB);

function state(container) {
  const [running, code] = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', container).split(' ');
  return { running: running === 'true', exitCode: Number(code) };
}

/**
 * Waits until nginx in `container` answers HTTP on loopback. Returns `{ exited, exitCode }` when the
 * container stops first; throws after `ms`.
 */
async function waitForNginx(container, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = state(container);
    if (!s.running) return { exited: true, exitCode: s.exitCode };
    const r = curlIn(container, '/');
    if (r.code === 0 && /^HTTP\/1/.test(r.stdout)) return { exited: false };
    await sleep(300);
  }
  throw new Error(`${container} did not answer within ${ms} ms:\n${dockerTry('logs', container).stderr}`);
}

async function waitForStub(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (dockerTry('exec', API, 'wget', '-qO-', '-T', '2', 'http://127.0.0.1:8000/ready').code === 0) return;
    await sleep(300);
  }
  throw new Error(`stub api did not answer within ${ms} ms`);
}

function removeAll() {
  const ids = dockerTry('ps', '-aq', '--filter', `name=${PREFIX}`).stdout.split('\n').filter(Boolean);
  if (ids.length) dockerTry('rm', '-f', ...ids);
  dockerTry('network', 'rm', NET);
}

before(async () => {
  docker('network', 'create', '--internal', NET);
  docker('run', '-d', '--name', API, '--network', NET, '--network-alias', 'ficino-api', STUB_IMAGE, 'node', '-e', STUB);
  startWeb(WEB, [`FICINO_OWNER_LOGIN=${OWNER_LOGIN}`]);
  await waitForStub();
  const w = await waitForNginx(WEB);
  if (w.exited) throw new Error(`nginx exited (${w.exitCode}):\n${dockerTry('logs', WEB).stderr}`);
});

after(() => removeAll());

test('/ redirects to /ficino/ with a relative Location', () => {
  const r = req('/', OWNER);
  assert.equal(r.status, 302);
  assert.equal(r.location, '/ficino/');
});

test('/ficino redirects to /ficino/', () => {
  const r = req('/ficino', OWNER);
  assert.equal(r.status, 301);
  assert.equal(r.location, '/ficino/');
});

test('the SPA is served under /ficino/ for the owner', () => {
  const r = req('/ficino/', OWNER);
  assert.equal(r.status, 200);
  assert.match(r.body, /<html/i);
});

test('the API prefix is stripped and the tailnet peer becomes X-Real-IP', () => {
  const r = req('/ficino/api/health', { ...OWNER, 'X-Forwarded-For': '100.64.1.2' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { path: '/health', xRealIp: '100.64.1.2', xForwardedProto: 'https' });
});

test('rejects requests without the owner login', () => {
  for (const path of ['/', '/ficino', '/ficino/', '/ficino/api/health']) {
    assert.equal(req(path).status, 403, `${path} without the header`);
    assert.equal(req(path, { 'Tailscale-User-Login': 'someone@example.com' }).status, 403, `${path} wrong login`);
    assert.equal(req(path, { 'Tailscale-User-Login': '' }).status, 403, `${path} empty login`);
  }
});

test('listens on loopback only', () => {
  const lines = docker('exec', WEB, 'netstat', '-tln').split('\n').filter((l) => /:80\s/.test(l));
  assert.ok(lines.length > 0, 'nginx listens on port 80');
  for (const l of lines) assert.equal(l.trim().split(/\s+/)[3], '127.0.0.1:80', l);

  // From another container, even with the owner header, the connection itself must fail. The owner
  // gate's 403 also exits non-zero, so a bare non-zero exit would let a 0.0.0.0 listener pass.
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', WEB);
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  const r = dockerTry('exec', API, 'wget', '-S', '-O-', '-T', '3', '--header', `Tailscale-User-Login: ${OWNER_LOGIN}`, `http://${ip}:80/`);
  const out = r.stdout + r.stderr;
  assert.notEqual(r.code, 0, out);
  assert.match(out, /Connection refused|can't connect/);
  assert.doesNotMatch(out, /HTTP\/1/);
});

test('long LLM calls are not cut at 60 s', () => {
  const r = dockerTry('exec', WEB, 'nginx', '-T');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('proxy_read_timeout 300s'));
  assert.ok(r.stdout.includes('proxy_send_timeout 300s'));
  assert.ok(r.stdout.includes('absolute_redirect off'));
  // The image's envsubst rendered the owner login; nginx's own variables were left alone.
  assert.ok(r.stdout.includes(`"${OWNER_LOGIN}" 1;`));
  assert.ok(r.stdout.includes('set $ficino_api ficino-api:8000;'));
});

test('an empty owner login never admits anonymous requests', async () => {
  const c = name('web-empty');
  startWeb(c, ['FICINO_OWNER_LOGIN=']);
  const w = await waitForNginx(c, 10000);
  if (w.exited) {
    assert.notEqual(w.exitCode, 0, 'nginx refused the config');
    return;
  }
  const r = reqTo(c);
  for (const path of ['/', '/ficino/', '/ficino/api/health']) {
    assert.equal(r(path).status, 403, `${path} without the header`);
    assert.equal(r(path, { 'Tailscale-User-Login': '' }).status, 403, `${path} empty header`);
  }
});

test('an unset owner login admits nobody', async () => {
  const c = name('web-unset');
  startWeb(c, []);
  const w = await waitForNginx(c, 10000);
  if (w.exited) {
    assert.notEqual(w.exitCode, 0, 'nginx refused the config');
    return;
  }
  const r = reqTo(c);
  assert.equal(r('/', OWNER).status, 403);
  assert.equal(r('/').status, 403);
  assert.equal(r('/ficino/api/health', OWNER).status, 403);
  // envsubst leaves an undefined variable as written, so the map would hold the placeholder itself.
  const placeholder = { 'Tailscale-User-Login': '${FICINO_OWNER_LOGIN}' };
  assert.equal(r('/', placeholder).status, 403);
  assert.equal(r('/ficino/', placeholder).status, 403);
});
