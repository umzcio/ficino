import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchDb } from './db.js';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** The startup line each entry point logs once it is ready (the line right before it installs its signal handlers). */
export const STARTUP_MSG = { api: 'ficino api listening', worker: 'ficino worker started' } as const;

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Date.now() at the child's 'exit' event. */
  at: number;
}

export interface EntryProcess {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Pino JSON lines from stdout (non-JSON lines dropped). */
  logs(): Array<Record<string, unknown>>;
  /** Settles once the child has exited and its stdio has closed. */
  exited: Promise<Exit>;
  /** How many 'exit' events the child emitted. */
  exitCount(): number;
  /** SIGKILLs a still-running child and drops its scratch database and data dir. */
  cleanup(): Promise<void>;
}

/**
 * Spawns `src/<entry>/main.ts` from source against a fresh scratch database, the way the image runs it
 * (`node dist/<entry>/main.js`), and waits for its startup log line. Only the env it needs is passed: the
 * test process's provider keys must not leak in, the data dirs are a temp dir, and Ollama points at a
 * closed loopback port, so nothing reaches a real provider or writes outside the temp dir.
 */
export async function startEntry(entry: 'api' | 'worker', startupTimeoutMs = 20_000): Promise<EntryProcess> {
  const scratch = await createScratchDb();
  const dataDir = await mkdtemp(join(tmpdir(), `ficino-${entry}-signals-`));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: scratch.url,
    PORT: '0',
    API_HOST: '127.0.0.1',
    ENVIRONMENT: 'development',
    AUTH_PROVIDER: 'none',
    LOG_LEVEL: 'info', // the suite's setup sets 'silent', which would hide the startup line
    UPLOAD_DIR: join(dataDir, 'uploads'),
    FIGURES_DIR: join(dataDir, 'figures'),
    MEDIA_DIR: join(dataDir, 'media'),
    OLLAMA_BASE_URL: 'http://127.0.0.1:9',
  };
  for (const k of ['HOME', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;

  const child = spawn(process.execPath, ['--import', 'tsx', `src/${entry}/main.ts`], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let exits = 0;
  let exitAt = 0;
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  child.on('exit', () => {
    exits += 1;
    exitAt = Date.now();
  });
  const exited = new Promise<Exit>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, at: exitAt }));
  });
  exited.catch(() => undefined); // observed by the tests; never an unhandled rejection

  const logs = () =>
    out
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });

  const proc: EntryProcess = {
    child,
    stdout: () => out,
    stderr: () => err,
    logs,
    exited,
    exitCount: () => exits,
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited.catch(() => undefined);
      }
      await scratch.drop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${entry} did not log '${STARTUP_MSG[entry]}' within ${startupTimeoutMs} ms\n${out}\n${err}`)),
        startupTimeoutMs,
      );
      const check = () => {
        if (logs().some((l) => l.msg === STARTUP_MSG[entry])) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout!.on('data', check);
      void exited.then((e) => {
        clearTimeout(timer);
        reject(new Error(`${entry} exited during startup (code ${e.code}, signal ${e.signal})\n${out}\n${err}`));
      });
    });
  } catch (e) {
    await proc.cleanup();
    throw e;
  }
  return proc;
}

/**
 * The entry logs its startup line and then, a few microtasks later, installs its SIGTERM/SIGINT handlers.
 * A signal landing in that gap takes Node's default action (death by signal), which is not what these tests
 * pin, so they give the child a moment before signalling.
 */
export const HANDLER_SETTLE_MS = 200;
