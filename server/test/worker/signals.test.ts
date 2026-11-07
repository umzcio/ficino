import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { HANDLER_SETTLE_MS, startEntry, type EntryProcess } from '../helpers/entry.js';

// Pins the signal wiring of src/worker/main.ts as the container runs it: `docker stop` sends SIGTERM, which
// must stop pg-boss gracefully, end the pool with no handler still running, and exit 0 inside compose's grace.

let proc: EntryProcess | undefined;

afterEach(async () => {
  await proc?.cleanup();
  proc = undefined;
});

it('worker exits 0 on SIGTERM within its grace', { timeout: 60_000 }, async () => {
  proc = await startEntry('worker');
  await sleep(HANDLER_SETTLE_MS);
  const sentAt = Date.now();
  proc.child.kill('SIGTERM');
  const exit = await proc.exited;

  expect(exit, proc.stderr()).toEqual(expect.objectContaining({ code: 0, signal: null }));
  expect(exit.at - sentAt).toBeLessThan(45_000);
  expect(proc.stdout()).not.toContain('shutdown failed');
  expect(proc.stdout()).not.toContain('ending pool with job handlers still running');
});
