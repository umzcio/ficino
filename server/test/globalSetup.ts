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

// This server forbids publishing on 0.0.0.0, so bind the random host port to loopback only.
export default async function setup(project: TestProject) {
  const name = `ficino-ts-test-${randomBytes(4).toString('hex')}`;
  docker(
    'run', '-d', '--rm', '--name', name,
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
    docker('rm', '-f', name);
    throw err;
  }

  return () => {
    docker('rm', '-f', name);
  };
}
