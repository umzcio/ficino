import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createSql, type Sql } from '../../src/db/sql.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import { createScratchDb } from '../helpers/db.js';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = 'ollama:qwen3-embedding:latest@1024';
const OLD = `[${new Array<number>(1024).fill(0.25).join(',')}]`;

let scratch: Awaited<ReturnType<typeof createScratchDb>>;
let sql: Sql;
let embed: Server;
let embedStatus = 200;
let paperId: string;

beforeAll(async () => {
  scratch = await createScratchDb();
  sql = createSql(scratch.url, { max: 2 });
  await migrate(sql);
  const corpusId = randomUUID();
  paperId = randomUUID();
  await sql`INSERT INTO users (id, email) VALUES (${STUB_USER_ID}, 'owner@example.com')`;
  await sql`INSERT INTO corpora (id, user_id, name) VALUES (${corpusId}, ${STUB_USER_ID}, 'Default')`;
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
    VALUES (${paperId}, ${STUB_USER_ID}, ${corpusId}, 'a.pdf', '/tmp/a.pdf', 'complete')`;

  // A stand-in Ollama: POST /api/embed answers 1024-d vectors, or `embedStatus` when it is not 200.
  embed = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/embed') {
        res.writeHead(404).end();
        return;
      }
      if (embedStatus !== 200) {
        res.writeHead(embedStatus, { 'content-type': 'application/json' }).end('{"error":"bad request"}');
        return;
      }
      const input = (JSON.parse(body) as { input: string[] }).input;
      const embeddings = input.map((_, i) => new Array<number>(1024).fill((i + 1) / 10));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ embeddings }));
    });
  });
  await new Promise<void>((resolve) => embed.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => (embed ? embed.close(() => resolve()) : resolve()));
  await sql?.end();
  await scratch?.drop();
});

beforeEach(async () => {
  embedStatus = 200;
  await sql`DELETE FROM chunks`;
  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, embedding, metadata)
      VALUES (${paperId}, ${STUB_USER_ID}, 'body', ${`Chunk ${i}.`}, ${i}, ${OLD}::vector, '{}'::jsonb)`;
  }
});

/** Runs the CLI from source with only the env it needs (the test process's provider env must not leak in). */
function runCli(args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const port = (embed.address() as AddressInfo).port;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: scratch.url,
    OLLAMA_BASE_URL: `http://127.0.0.1:${port}`,
    LOG_LEVEL: 'info', // the suite's setup sets 'silent', which would hide a log line written to stdout
  };
  for (const k of ['HOME', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/db/reembed-cli.ts', ...args], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function tags(): Promise<Array<{ m: string | null; old: boolean }>> {
  return (await sql`
    SELECT metadata->>'embed_model' AS m, embedding = ${OLD}::vector AS old
    FROM chunks ORDER BY chunk_index`) as unknown as Array<{ m: string | null; old: boolean }>;
}

it('re-embeds the stub user and reports before and after', { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runCli();

  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ target: TARGET, before: { '(none)': 3 }, after: { [TARGET]: 3 }, updated: 3 });
  expect(stdout.endsWith('\n')).toBe(true);
  expect(stderr).toContain('reembed_batch');
  expect(await tags()).toEqual([
    { m: TARGET, old: false },
    { m: TARGET, old: false },
    { m: TARGET, old: false },
  ]);
});

it('exits 1 when the provider fails', { timeout: 30_000 }, async () => {
  embedStatus = 400; // a 4xx is not retried, so this fails fast

  const { code, stdout, stderr } = await runCli();

  expect(code).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('400');
  expect(await tags()).toEqual([
    { m: null, old: true },
    { m: null, old: true },
    { m: null, old: true },
  ]);
});

it('rejects a --user that is not a uuid without touching the database', { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runCli(['--user', 'not-a-uuid']);

  expect(code).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('--user');
  expect((await tags()).every((t) => t.m === null && t.old)).toBe(true);
});
