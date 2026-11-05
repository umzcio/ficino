import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
});

import { startApi, type RunningApi } from '../../src/api/main.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import { createScratchDb } from '../helpers/db.js';

let api: RunningApi | undefined;
let drop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await api?.close();
  await drop?.();
  api = undefined;
  drop = undefined;
});

describe('startApi', () => {
  it('migrates, seeds the stub user, serves over real HTTP and closes cleanly', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    api = await startApi({ DATABASE_URL: scratch.url, PORT: '0', API_HOST: '127.0.0.1', LOG_LEVEL: 'silent' });
    expect(api.port).toBeGreaterThan(0);

    const base = `http://127.0.0.1:${api.port}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const provider = await fetch(`${base}/auth/provider`);
    expect(await provider.json()).toEqual({ provider: 'none', public_deployment: false });

    // The stub user row exists in the scratch database (not the shared test one).
    const probe = (await import('../../src/db/sql.js')).createSql(scratch.url, { max: 1 });
    try {
      const rows = await probe`SELECT email FROM users WHERE id = ${STUB_USER_ID}`;
      expect(rows.map((r) => r.email)).toEqual(['stub@ficino.dev']);
    } finally {
      await probe.end();
    }

    await api.close();
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    api = undefined;
  });

  it('binds 127.0.0.1 when API_HOST is unset, and ignores the generic HOST variable', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    api = await startApi({ DATABASE_URL: scratch.url, PORT: '0', HOST: '0.0.0.0', LOG_LEVEL: 'silent' });
    expect(api.host).toBe('127.0.0.1');
  });

  it('reads the env once at boot: later mutations of the passed object do not reach requests', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    const env: Record<string, string | undefined> = {
      DATABASE_URL: scratch.url,
      PORT: '0',
      API_HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      LLM_PROVIDER: 'ollama',
    };
    api = await startApi(env);
    env.LLM_PROVIDER = 'claude';
    const res = await fetch(`http://127.0.0.1:${api.port}/settings`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { llm_provider: string }).llm_provider).toBe('ollama');
  });

  it('does not seed the stub user under AUTH_PROVIDER=basic', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    api = await startApi({
      DATABASE_URL: scratch.url,
      PORT: '0',
      API_HOST: '127.0.0.1',
      AUTH_PROVIDER: 'basic',
      LOG_LEVEL: 'silent',
    });
    const probe = (await import('../../src/db/sql.js')).createSql(scratch.url, { max: 1 });
    try {
      expect(await probe`SELECT 1 FROM users`).toHaveLength(0);
    } finally {
      await probe.end();
    }
  });

  it('close() force-closes a hung connection after closeGraceMs', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    api = await startApi(
      { DATABASE_URL: scratch.url, PORT: '0', API_HOST: '127.0.0.1', LOG_LEVEL: 'silent' },
      { closeGraceMs: 200 },
    );
    const sock = net.connect(api.port, '127.0.0.1');
    sock.on('error', () => undefined);
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write('GET /health HTTP/1.1\r\nHost: x\r\n'); // no final CRLF: the request stays active
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await api.close();
    api = undefined;
    sock.destroy();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
