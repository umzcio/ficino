import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { HANDLER_SETTLE_MS, startEntry, type EntryProcess } from '../helpers/entry.js';

// Pins the signal wiring of src/api/main.ts as the container runs it: `docker stop` sends SIGTERM, a terminal
// Ctrl-C sends SIGINT, and either must close the listener, pg-boss and the pool and exit 0.

let proc: EntryProcess | undefined;

afterEach(async () => {
  await proc?.cleanup();
  proc = undefined;
});

async function signalAndWait(signal: NodeJS.Signals) {
  proc = await startEntry('api');
  await sleep(HANDLER_SETTLE_MS);
  const sentAt = Date.now();
  proc.child.kill(signal);
  const exit = await proc.exited;
  return { exit, elapsed: exit.at - sentAt };
}

it('api exits 0 on SIGTERM within its grace', { timeout: 30_000 }, async () => {
  const { exit, elapsed } = await signalAndWait('SIGTERM');

  expect(exit, proc!.stderr()).toEqual(expect.objectContaining({ code: 0, signal: null }));
  expect(elapsed).toBeLessThan(20_000);
  expect(proc!.stdout()).not.toContain('shutdown failed');
});

it('api exits 0 on SIGINT', { timeout: 30_000 }, async () => {
  const { exit, elapsed } = await signalAndWait('SIGINT');

  expect(exit, proc!.stderr()).toEqual(expect.objectContaining({ code: 0, signal: null }));
  expect(elapsed).toBeLessThan(20_000);
  expect(proc!.stdout()).not.toContain('shutdown failed');
});

it('api survives a second SIGTERM during shutdown', { timeout: 30_000 }, async () => {
  proc = await startEntry('api');
  const port = proc.logs().find((l) => l.msg === 'ficino api listening')!.port as number;
  // A request that never finishes its headers stays active, so shutdown waits out the 10 s close grace before
  // dropping it: the second signal is sure to land mid-shutdown (an idle api closes in a few ms).
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => undefined);
  try {
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    sock.write('GET /health HTTP/1.1\r\nHost: x\r\n');
    await sleep(HANDLER_SETTLE_MS);
    const sentAt = Date.now();
    proc.child.kill('SIGTERM');
    await sleep(50);
    const stillRunning = proc.child.exitCode === null && proc.child.signalCode === null;
    proc.child.kill('SIGTERM');
    const exit = await proc.exited;

    expect(stillRunning).toBe(true);
    expect(exit, proc.stderr()).toEqual(expect.objectContaining({ code: 0, signal: null }));
    // One shutdown, run to its end: the second signal neither restarts it nor cuts the close grace short.
    expect(exit.at - sentAt).toBeGreaterThanOrEqual(9_500);
    expect(exit.at - sentAt).toBeLessThan(20_000);
    expect(proc.exitCount()).toBe(1);
    expect(proc.stdout()).not.toContain('shutdown failed');
  } finally {
    sock.destroy();
  }
});
