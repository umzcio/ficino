import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate.js';
import { createSql } from '../src/db/sql.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

const LABEL = 'ficino-ts-test';
const OWNER_LABEL = 'ficino-ts-test.owner-pid';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A run killed before its teardown leaves its container behind (--rm only fires when the
// container stops). Each container records the vitest pid that owns it; remove the ones
// whose owner is gone, and leave containers of runs still in progress alone.
function sweepStaleContainers() {
  const rows = docker(
    'ps', '-a', '--filter', `label=${LABEL}`,
    '--format', `{{.Names}}\t{{.Label "${OWNER_LABEL}"}}`,
  );
  for (const row of rows.split('\n').filter(Boolean)) {
    const [name, owner] = row.split('\t');
    const pid = Number(owner);
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) continue;
    try {
      docker('rm', '-f', '-v', name!);
    } catch {
      // Another run's sweep got there first.
    }
  }
}

// This server forbids publishing on 0.0.0.0, so bind the random host port to loopback only.
export default async function setup(project: TestProject) {
  sweepStaleContainers();
  const name = `ficino-ts-test-${randomBytes(4).toString('hex')}`;
  docker(
    'run', '-d', '--rm', '--name', name,
    '--label', LABEL, '--label', `${OWNER_LABEL}=${process.pid}`,
    '-e', 'POSTGRES_USER=ficino', '-e', 'POSTGRES_PASSWORD=ficino', '-e', 'POSTGRES_DB=ficino',
    '-p', '127.0.0.1::5432',
    'pgvector/pgvector:pg18',
  );
  try {
    // "0.0.0.0:49153" or "127.0.0.1:49153": take the port after the last colon.
    const mapping = docker('port', name, '5432/tcp').split('\n')[0]!;
    const port = mapping.slice(mapping.lastIndexOf(':') + 1);
    const url = `postgres://ficino:ficino@127.0.0.1:${port}/ficino`;

    // The image restarts postgres once after init, so require a real query to succeed.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const probe = createSql(url, { max: 1 });
      try {
        await probe`SELECT 1`;
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        await probe.end({ timeout: 1 }).catch(() => {});
      }
    }

    const sql = createSql(url, { max: 2 });
    try {
      await migrate(sql);
    } finally {
      await sql.end();
    }
    project.provide('databaseUrl', url);
  } catch (err) {
    docker('rm', '-f', '-v', name);
    throw err;
  }

  return () => {
    docker('rm', '-f', '-v', name);
  };
}
