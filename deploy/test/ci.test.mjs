// Invariants of the CI workflow (.github/workflows/ci.yml): the e2e gate boots the TS stack through
// scripts/e2e-stack.sh on a runner Playwright supports, and the deploy checks run in CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO } from './helpers.mjs';

const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
// job keys may contain digits (`e2e`): the class must include 0-9, or job('e2e') is '' and its block stays inside the previous job
const job = (name) => ci.split(/\n  (?=[a-z0-9-]+:\n)/).find((b) => b.startsWith(`${name}:`)) ?? '';

test('the job splitter finds every job', () => {
  for (const n of ['e2e', 'deploy']) assert.ok(job(n).length > 0, n);
  assert.doesNotMatch(job('frontend'), /\n  e2e:\n/);
});

test('e2e runs on a runner Playwright supports and boots the TS stack', () => {
  const e2e = job('e2e');
  assert.match(e2e, /runs-on: ubuntu-24\.04/);
  assert.match(e2e, /scripts\/e2e-stack\.sh up/);
  assert.match(e2e, /scripts\/e2e-stack\.sh ci/);
  assert.match(e2e, /scripts\/e2e-stack\.sh down/);
  assert.doesNotMatch(e2e, /ficino-e2e-fe|\.env\.secrets|chown|docker compose up/);
});

test('deploy checks run in CI', () => assert.match(job('deploy'), /npm run test:deploy/));

// The Python services were removed at tag python-final; CI must not try to lint, install or test them.
test('CI runs no Python jobs', () => {
  for (const n of ['python-lint', 'api-tests', 'worker-tests', 'shared-tests']) assert.equal(job(n), '', n);
  assert.doesNotMatch(ci, /setup-python|pytest|pip install|ruff|requirements\.lock|infra\//);
});
