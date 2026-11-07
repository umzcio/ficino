// Invariants of the self-host override example (deploy/loopback/): web on loopback, nothing else.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO, composeConfig } from './helpers.mjs';

const FILE = 'deploy/loopback/docker-compose.override.example.yml';

test('the self-host override publishes only web, only on loopback', async () => {
  const c = await composeConfig(['docker-compose.yml', FILE]);
  const ports = c.services.web.ports ?? [];
  assert.deepEqual(
    ports.map((p) => ({ host_ip: p.host_ip, published: String(p.published), target: p.target })),
    [{ host_ip: '127.0.0.1', published: '8080', target: 80 }],
  );
  for (const [n, s] of Object.entries(c.services)) if (n !== 'web') assert.equal(s.ports, undefined, n);
  assert.equal(c.services.web.network_mode, undefined, 'web stays on ficino-network');
  assert.deepEqual(Object.keys(c.services.web.networks), ['ficino-network']);
  assert.deepEqual(Object.keys(c.services).sort(), ['api', 'postgres', 'web', 'worker']);
});

test('the self-host override tells the reader to browse localhost, not 127.0.0.1', () => {
  // Production cookies are Secure; Chromium accepts them over plain http on `localhost` only.
  const raw = readFileSync(join(REPO, FILE), 'utf8');
  assert.match(raw, /docker-compose\.override\.yml/);
  assert.match(raw, /http:\/\/localhost:8080\/ficino\//);
});
