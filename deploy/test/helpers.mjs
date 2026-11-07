// Shared helpers for the deploy checks (`npm run test:deploy`). The compose helpers render files
// with `docker compose config` and never start anything; the docker helpers run plain docker
// commands for the tests that start throwaway `ficino-deploytest-*` containers.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute repo root. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Variables that would let the caller's shell change what compose renders (another project name,
// other files, profiles). The tests pin their inputs, so these never leak in.
const SHELL_COMPOSE_VARS = ['COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES'];

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SHELL_COMPOSE_VARS) delete env[k];
  return { ...env, ...extra };
}

function run(cmd, args, env) {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { cwd: REPO, env, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, error });
    });
  });
}

let composeChecked;

/**
 * `config --no-env-resolution` keeps `env_file` as a list of paths instead of inlining the files'
 * values (which would drop the key and print a checkout's real `.env` into a failing test).
 */
function ensureComposeSupportsNoEnvResolution() {
  composeChecked ??= run('docker', ['compose', 'config', '--help'], baseEnv()).then((r) => {
    if (r.code !== 0 || !r.stdout.includes('--no-env-resolution')) {
      throw new Error('Docker Compose too old for the deploy tests: needs config --no-env-resolution');
    }
  });
  return composeChecked;
}

function configArgs(files) {
  const args = ['compose', '--project-directory', REPO];
  for (const f of files) args.push('-f', resolve(REPO, f));
  args.push('config', '--no-env-resolution', '--format', 'json');
  return args;
}

/** The rendered compose model for `files` (relative to the repo), with `env` added to the caller's env. */
export async function composeConfig(files, env = {}) {
  await ensureComposeSupportsNoEnvResolution();
  const r = await run('docker', configArgs(files), baseEnv(env));
  if (r.code !== 0) throw new Error(`docker compose config failed (exit ${r.code}):\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Resolves compose's stderr when `config` fails for `files`; rejects when it succeeds. */
export async function composeConfigFails(files, env = {}) {
  await ensureComposeSupportsNoEnvResolution();
  const r = await run('docker', configArgs(files), baseEnv(env));
  if (r.code === 0) throw new Error(`expected docker compose config to fail for ${files.join(', ')}`);
  return r.stderr;
}

/** Runs `docker …args` synchronously and returns trimmed stdout; throws with stderr on failure. */
export function docker(...args) {
  try {
    return execFileSync('docker', args, { cwd: REPO, env: baseEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`docker ${args.join(' ')} failed: ${e.stderr ?? e.message}`);
  }
}

/** Runs `docker …args` synchronously and returns `{ code, stdout, stderr }`; never throws on a non-zero exit. */
export function dockerTry(...args) {
  const r = spawnSync('docker', args, { cwd: REPO, env: baseEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
