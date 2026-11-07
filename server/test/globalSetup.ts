import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate.js';
import { createSql } from '../src/db/sql.js';
import {
  LABEL,
  OWNER_HOST_LABEL,
  OWNER_PID_LABEL,
  OWNER_PIDNS_LABEL,
  ownerLabelArgs,
  parseDockerTime,
  processAlive,
  selfPidNs,
  shouldSweep,
} from './helpers/sweep.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

// A run killed before its teardown leaves its container behind (--rm only fires when the
// container stops). Each container records the vitest pid that owns it, plus that pid's PID
// namespace and hostname; test/helpers/sweep.ts decides which ones are stale. Containers of
// runs still in progress are left alone.
function sweepStaleContainers() {
  const names = docker('ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}').split('\n').filter(Boolean);
  const ctx = { selfNs: selfPidNs(), selfHost: hostname(), now: Date.now(), isAlive: processAlive };
  const label = (key: string) => `{{index .Config.Labels "${key}"}}`;
  for (const name of names) {
    let fields: string[];
    try {
      fields = docker(
        'inspect', '--format',
        `{{.Created}}\t${label(OWNER_PID_LABEL)}\t${label(OWNER_PIDNS_LABEL)}\t${label(OWNER_HOST_LABEL)}`,
        name,
      ).split('\t');
    } catch {
      continue; // Removed since the listing.
    }
    const [created = '', ownerPid = '', ownerNs = '', ownerHost = ''] = fields;
    if (!shouldSweep({ ownerPid, ownerNs, ownerHost, createdAt: parseDockerTime(created) }, ctx)) continue;
    try {
      docker('rm', '-f', '-v', name);
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
    ...ownerLabelArgs(),
    '-e', 'POSTGRES_USER=ficino', '-e', 'POSTGRES_PASSWORD=ficino', '-e', 'POSTGRES_DB=ficino',
    '-p', '127.0.0.1::5432',
    'pgvector/pgvector:pg18',
    // A throwaway server: skip durability. CREATE/DROP DATABASE checkpoints otherwise flush every dirty
    // page the suite has made so far, which pushed late scratch-DB tests past their 5 s timeout.
    'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
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
