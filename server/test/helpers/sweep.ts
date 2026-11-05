// Labels and sweep rules for the throwaway Postgres containers that tests and the manual smoke scripts start.
// globalSetup removes containers left behind by interrupted runs, and must never remove one that belongs to a run
// still in progress. A pid is only meaningful inside the PID namespace (and on the host) that created it: a run in
// a sandbox with the docker socket mounted cannot see a host run's pid, and the initial PID namespace has the same
// inode number on every Linux host. So the pid-liveness check only applies to containers created from this
// process's own namespace and hostname; any other container is removed only once it is older than any test run.
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';

export const LABEL = 'ficino-ts-test';
export const OWNER_PID_LABEL = 'ficino-ts-test.owner-pid';
export const OWNER_PIDNS_LABEL = 'ficino-ts-test.owner-pidns';
export const OWNER_HOST_LABEL = 'ficino-ts-test.owner-host';

/** No test or smoke run lasts this long, so an older container whose owner cannot be checked is stale. */
export const FOREIGN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** This process's PID-namespace identity, e.g. `pid:[4026531836]`; null where /proc is unavailable. */
export function selfPidNs(): string | null {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

/** The `docker run` arguments that mark a container as owned by this process. */
export function ownerLabelArgs(): string[] {
  const args = ['--label', LABEL, '--label', `${OWNER_PID_LABEL}=${process.pid}`, '--label', `${OWNER_HOST_LABEL}=${hostname()}`];
  const ns = selfPidNs();
  if (ns) args.push('--label', `${OWNER_PIDNS_LABEL}=${ns}`);
  return args;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Docker's RFC 3339 timestamp (nanosecond fraction) as epoch ms; NaN when unparsable. */
export function parseDockerTime(s: string): number {
  return Date.parse(s.trim().replace(/(\.\d{3})\d+/, '$1'));
}

export interface SweepCandidate {
  /** Label values as docker prints them: '' when the label is missing. */
  ownerPid: string;
  ownerNs: string;
  ownerHost: string;
  /** Creation time in epoch ms (NaN if unknown). */
  createdAt: number;
}

export interface SweepContext {
  selfNs: string | null;
  selfHost: string;
  now: number;
  isAlive: (pid: number) => boolean;
}

/** Whether globalSetup may remove this container. */
export function shouldSweep(c: SweepCandidate, ctx: SweepContext): boolean {
  const pid = /^[1-9]\d*$/.test(c.ownerPid) ? Number(c.ownerPid) : NaN;
  const sameOwnerSpace = ctx.selfNs !== null && c.ownerNs === ctx.selfNs && c.ownerHost === ctx.selfHost;
  if (sameOwnerSpace && Number.isSafeInteger(pid)) return !ctx.isAlive(pid);
  // Another namespace or host, a container from the older pid-only scheme, or a pid that can't be checked: only age
  // can show it is stale. An unknown creation time keeps it.
  return Number.isFinite(c.createdAt) && ctx.now - c.createdAt > FOREIGN_MAX_AGE_MS;
}
