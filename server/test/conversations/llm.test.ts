import { beforeEach, describe, it, expect } from 'vitest';
import pino from 'pino';
import { apiLlm, llmErrorToHttp, LlmDeadlineError } from '../../src/conversations/llm.js';
import { HttpError } from '../../src/http/errors.js';
import { HttpStatusError, NetworkError } from '../../src/providers/http.js';
import { loadConfig } from '../../src/config.js';
import type { ResolvedAppDeps } from '../../src/app.js';
import { resetDb, seedUsers, testSql, USER_A_ID } from '../helpers/db.js';
import { fakeProviders } from '../helpers/fakeProviders.js';
import { PUBLIC_ON } from '../helpers/publicDeployment.js';

function capture() {
  const logs: Array<{
    level: string;
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const rec = (level: string) => (obj: Record<string, unknown>, msg: string) => logs.push({ level, obj, msg });
  const logger = {
    warn: rec('warn'),
    error: rec('error'),
  } as unknown as pino.Logger;
  return { logs, logger };
}

function grade(e: unknown, event = 'x_failed') {
  const { logs, logger } = capture();
  const out = llmErrorToHttp(e, event, logger);
  return { out, logs };
}

describe('llmErrorToHttp (port of test_error_contracts.py)', () => {
  it('LlmDeadlineError -> 504', () => {
    const { out, logs } = grade(new LlmDeadlineError('slow'));
    expect(out).toBeInstanceOf(HttpError);
    expect([out.status, out.detail]).toEqual([504, 'LLM request timed out. Try again.']);
    expect(logs[0].level).toBe('warn');
    expect(logs[0].obj).toMatchObject({ reason: 'timeout' });
    expect(logs[0].msg).toBe('x_failed');
  });

  it('NetworkError -> 503 unreachable', () => {
    const { out, logs } = grade(new NetworkError(new Error('refused')));
    expect([out.status, out.detail]).toEqual([503, 'LLM provider unreachable. Try again in a moment.']);
    expect(logs[0].obj).toMatchObject({ reason: 'llm_unreachable' });
  });

  it('TimeoutError by name -> 503 unreachable', () => {
    const e = new DOMException('timed out', 'TimeoutError');
    const { out } = grade(e);
    expect([out.status, out.detail]).toEqual([503, 'LLM provider unreachable. Try again in a moment.']);
  });

  it('upstream 4xx -> 502', () => {
    const { out, logs } = grade(new HttpStatusError(404, 'nope'));
    expect([out.status, out.detail]).toEqual([502, 'LLM provider rejected our request.']);
    expect(logs[0].obj).toMatchObject({
      reason: 'llm_http_error',
      upstream_status: 404,
    });
  });

  it('upstream 5xx -> 503', () => {
    const { out, logs } = grade(new HttpStatusError(500, 'boom'));
    expect([out.status, out.detail]).toEqual([503, 'LLM provider error. Try again in a moment.']);
    expect(logs[0].obj).toMatchObject({
      reason: 'llm_http_error',
      upstream_status: 500,
    });
  });

  it('TypeError and SyntaxError -> 400', () => {
    for (const e of [new TypeError('bad'), new SyntaxError('worse')]) {
      const { out, logs } = grade(e);
      expect(out.status).toBe(400);
      expect(out.detail).toBe(`Invalid input: ${e.message}`);
      expect(logs[0].obj).toMatchObject({ reason: 'bad_input' });
    }
  });

  it('a long TypeError message keeps 200 code points', () => {
    const { out } = grade(new TypeError('😀'.repeat(300)));
    expect(out.detail).toBe(`Invalid input: ${'😀'.repeat(200)}`);
  });

  it('anything else -> 500, logged at error with error_type', () => {
    const { out, logs } = grade(new RangeError('x'));
    expect([out.status, out.detail]).toEqual([500, 'Internal error. See server logs.']);
    expect(logs[0].level).toBe('error');
    expect(logs[0].obj).toMatchObject({ error_type: 'RangeError' });
  });

  it('the same error grades the same under two event names', () => {
    const a = grade(new HttpStatusError(503, ''), 'dm_llm_failed');
    const b = grade(new HttpStatusError(503, ''), 'zap_llm_failed');
    expect([a.out.status, a.out.detail]).toEqual([b.out.status, b.out.detail]);
    expect([a.logs[0].msg, b.logs[0].msg]).toEqual(['dm_llm_failed', 'zap_llm_failed']);
  });
});

describe('apiLlm', () => {
  const config = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    OLLAMA_BASE_URL: 'http://fake-ollama:11434',
  });
  const deps = (providers: ReturnType<typeof fakeProviders>['deps'], env: Record<string, string> = {}) =>
    ({
      sql: testSql(),
      config,
      env,
      providers,
      logger: pino({ level: 'silent' }),
    }) as unknown as ResolvedAppDeps;
  const req = {
    system: 's',
    messages: [{ role: 'user' as const, content: 'q' }],
    temperature: 0.5,
    maxTokens: 10,
  };

  beforeEach(async () => {
    await resetDb(testSql());
    await seedUsers(testSql());
  });

  async function withSettings(settings: object, fn: () => Promise<void>) {
    const sql = testSql();
    await sql`INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json(settings as never)})`;
    await fn();
  }

  it('uses the stored model', async () => {
    await withSettings({ llm_provider: 'ollama', ollama_llm_model: 'm1' }, async () => {
      const fp = fakeProviders();
      const llm = await apiLlm(deps(fp.deps), USER_A_ID);
      await llm.chat(req);
      expect(fp.calls.map((c) => c.model)).toEqual(['m1']);
    });
  });

  it('under PUBLIC_DEPLOYMENT the operator env wins', async () => {
    await withSettings({ llm_provider: 'ollama', ollama_llm_model: 'm1' }, async () => {
      const fp = fakeProviders();
      const llm = await apiLlm(
        deps(fp.deps, {
          PUBLIC_DEPLOYMENT: 'true',
          OLLAMA_LLM_MODEL: 'envm',
        }),
        USER_A_ID,
      );
      await llm.chat(req);
      expect(fp.calls.map((c) => c.model)).toEqual(['envm']);
    });
  });

  it.each(PUBLIC_ON)('PUBLIC_DEPLOYMENT=%j: the operator env wins over a stored model', async (v) => {
    await withSettings({ llm_provider: 'ollama', ollama_llm_model: 'm1' }, async () => {
      const fp = fakeProviders();
      const llm = await apiLlm(deps(fp.deps, { PUBLIC_DEPLOYMENT: v, OLLAMA_LLM_MODEL: 'envm' }), USER_A_ID);
      await llm.chat(req);
      expect(fp.calls.map((c) => c.model)).toEqual(['envm']);
    });
  });
});
