import { describe, expect, it } from 'vitest';
import {
  FOREIGN_MAX_AGE_MS,
  LABEL,
  OWNER_HOST_LABEL,
  OWNER_PID_LABEL,
  OWNER_PIDNS_LABEL,
  ownerLabelArgs,
  parseDockerTime,
  selfPidNs,
  shouldSweep,
  type SweepCandidate,
} from './sweep.js';

const NS = 'pid:[4026531836]';
const HOST = 'umzhost';
const NOW = Date.parse('2026-11-05T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const alive = new Set([100]);
const ctx = { selfNs: NS, selfHost: HOST, now: NOW, isAlive: (pid: number) => alive.has(pid) };
const recent = NOW - HOUR;
const old = NOW - 13 * HOUR;
const box = (o: Partial<SweepCandidate>): SweepCandidate => ({
  ownerPid: '100',
  ownerNs: NS,
  ownerHost: HOST,
  createdAt: recent,
  ...o,
});

describe('shouldSweep', () => {
  it('same namespace and host, owner alive: kept, however old', () => {
    expect(shouldSweep(box({}), ctx)).toBe(false);
    expect(shouldSweep(box({ createdAt: old }), ctx)).toBe(false);
  });

  it('same namespace and host, owner dead: removed, however recent', () => {
    expect(shouldSweep(box({ ownerPid: '200' }), ctx)).toBe(true);
    expect(shouldSweep(box({ ownerPid: '200', createdAt: NOW }), ctx)).toBe(true);
  });

  it('foreign namespace: the pid is never consulted; kept while recent, removed past 12 h', () => {
    const isAlive = () => {
      throw new Error('pid checked');
    };
    const foreign = { ...ctx, isAlive };
    expect(shouldSweep(box({ ownerNs: 'pid:[4026532999]', ownerPid: '200' }), foreign)).toBe(false);
    expect(shouldSweep(box({ ownerNs: 'pid:[4026532999]', ownerPid: '200', createdAt: old }), foreign)).toBe(true);
  });

  it('same namespace inode on another host counts as foreign', () => {
    expect(shouldSweep(box({ ownerHost: 'sandbox', ownerPid: '200' }), ctx)).toBe(false);
    expect(shouldSweep(box({ ownerHost: 'sandbox', ownerPid: '200', createdAt: old }), ctx)).toBe(true);
  });

  it('no namespace label (the pid-only scheme): kept while recent, removed past 12 h', () => {
    const legacy = { ownerNs: '', ownerHost: '', ownerPid: '200' };
    expect(shouldSweep(box({ ...legacy }), ctx)).toBe(false);
    expect(shouldSweep(box({ ...legacy, createdAt: old }), ctx)).toBe(true);
  });

  it('the 12 h boundary is exclusive', () => {
    const foreign = { ownerNs: '' };
    expect(shouldSweep(box({ ...foreign, createdAt: NOW - FOREIGN_MAX_AGE_MS }), ctx)).toBe(false);
    expect(shouldSweep(box({ ...foreign, createdAt: NOW - FOREIGN_MAX_AGE_MS - 1 }), ctx)).toBe(true);
  });

  it('garbage pid: falls back to the age rule, even in our namespace', () => {
    for (const ownerPid of ['', 'abc', '0', '-5', '1.5', '12x', ' 100']) {
      expect(shouldSweep(box({ ownerPid }), ctx), ownerPid).toBe(false);
      expect(shouldSweep(box({ ownerPid, createdAt: old }), ctx), ownerPid).toBe(true);
    }
  });

  it('an unknown creation time keeps a container that only age could condemn', () => {
    expect(shouldSweep(box({ ownerNs: '', createdAt: NaN }), ctx)).toBe(false);
  });

  it('no /proc (selfNs null): nothing is removed on pid grounds', () => {
    const noProc = { ...ctx, selfNs: null };
    expect(shouldSweep(box({ ownerPid: '200' }), noProc)).toBe(false);
    expect(shouldSweep(box({ ownerPid: '200', createdAt: old }), noProc)).toBe(true);
  });
});

describe('parseDockerTime', () => {
  it('reads docker inspect .Created (nanosecond fraction)', () => {
    expect(parseDockerTime('2026-11-05T16:38:02.123456789Z\n')).toBe(Date.parse('2026-11-05T16:38:02.123Z'));
    expect(parseDockerTime('2026-11-05T16:38:02Z')).toBe(Date.parse('2026-11-05T16:38:02Z'));
    expect(parseDockerTime('')).toBeNaN();
  });
});

describe('ownerLabelArgs', () => {
  it('labels the container with this process pid, hostname and PID namespace', () => {
    const args = ownerLabelArgs();
    expect(args).toContain(LABEL);
    expect(args).toContain(`${OWNER_PID_LABEL}=${process.pid}`);
    expect(args.some((a) => a.startsWith(`${OWNER_HOST_LABEL}=`))).toBe(true);
    const ns = selfPidNs();
    expect(ns).toMatch(/^pid:\[\d+\]$/);
    expect(args).toContain(`${OWNER_PIDNS_LABEL}=${ns}`);
  });
});
