import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import { LocalStorage } from '../../src/storage/local.js';
import { generateCorpusSynthesis, generatePaperSummary } from '../../src/tasks/summary.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, type ChatInfo } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const storage = new LocalStorage(config, Buffer.from('k'.repeat(32)));

type Golden = { name: string; raw: string };
const goldens = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/summary-tasks.json', import.meta.url), 'utf8'),
) as Golden[];
const rawOf = (name: string) => goldens.find((g) => g.name === name)!.raw;

type Line = Record<string, unknown> & { msg?: string };

let s: Seeded;

async function seedChunks(paperId: string, userId: string | null, n = 3, section = 'results') {
  for (let i = 0; i < n; i++) {
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count)
      VALUES (${paperId}, ${userId ?? STUB_USER_ID}, ${section}, ${`Evidence ${i} for paper.`}, ${i}, 5)`;
  }
}

async function setSettings(userId: string, settings: Record<string, unknown>) {
  await sql`INSERT INTO user_settings (user_id, settings) VALUES (${userId}, ${sql.json(settings as never)})`;
}

type RunOpts = {
  chat?: (info: ChatInfo) => string | Promise<string>;
  jobId?: string;
  isFinalAttempt?: boolean;
};

function harness(opts: RunOpts) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x)) });
  const infos: ChatInfo[] = [];
  const providers = fakeProviders({
    chat: (_body, info) => {
      infos.push(info);
      return opts.chat ? opts.chat(info) : rawOf('clean_array');
    },
  });
  const jobId = opts.jobId ?? randomUUID();
  // retryLimit 2: retryCount 2 is the final attempt.
  const ctx = makeJobContext(
    { id: jobId, name: 'generate_paper_summary', retryCount: opts.isFinalAttempt ? 2 : 0, signal: new AbortController().signal },
    sql,
    logger,
    600_000,
    2,
  );
  const deps: WorkerDeps = {
    sql,
    config,
    env: {},
    logger,
    storage,
    queue: testQueue(),
    providers: providers.deps,
    rng: () => 0.5,
  };
  return { ctx, deps, lines, infos, calls: providers.calls, jobId };
}

async function summary(paperId: string, opts: RunOpts = {}) {
  const h = harness(opts);
  const result = await generatePaperSummary({ paper_id: paperId }, h.ctx, h.deps);
  return { ...h, result };
}

const summaryRow = async (paperId: string) =>
  (await sql`SELECT messages, status, task_id FROM paper_summaries WHERE paper_id = ${paperId}`)[0];

const synthRow = async (id: string) =>
  (await sql`SELECT user_id, name, paper_ids, messages, status, task_id FROM corpus_syntheses WHERE id = ${id}`)[0];

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  await seedChunks(s.paper_a, s.user_a);
});

describe('generate_paper_summary', () => {
  it('stores a complete summary and returns the message count', async () => {
    const { result, infos, ctx } = await summary(s.paper_a);
    expect(result).toEqual({ status: 'complete', paper_id: s.paper_a, message_count: 8 });
    const row = await summaryRow(s.paper_a);
    expect(row!.status).toBe('complete');
    expect(row!.task_id).toBeNull();
    expect((row!.messages as unknown[]).length).toBe(8);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ purpose: 'summary', temperature: 0.7, maxTokens: 1536 });
    expect(infos[0]!.user).toContain('the paper "<untrusted>a.pdf</untrusted>"');
    expect(infos[0]!.user).toContain('[RESULTS]\n<untrusted>Evidence 0 for paper.</untrusted>');
    const [p] = await sql`SELECT queue, meta FROM job_progress WHERE job_id = ${ctx.jobId}`;
    expect(p).toEqual({ queue: 'generate_paper_summary', meta: { step: 'generating', paper_id: s.paper_a } });
  });

  it('uses only the first 30 chunks by chunk_index', async () => {
    await sql`DELETE FROM chunks WHERE paper_id = ${s.paper_a}`;
    for (let i = 34; i >= 0; i--) {
      await sql`
        INSERT INTO chunks (paper_id, user_id, section, content, chunk_index)
        VALUES (${s.paper_a}, ${s.user_a}, 'body', ${`chunk-${i}-end`}, ${i})`;
    }
    const { infos } = await summary(s.paper_a);
    const user = infos[0]!.user;
    expect(user).toContain('chunk-29-end');
    expect(user).not.toContain('chunk-30-end');
    expect(user.indexOf('chunk-0-end')).toBeLessThan(user.indexOf('chunk-1-end'));
  });

  describe('guard', () => {
    it('a complete row returns exists without an LLM call', async () => {
      await sql`INSERT INTO paper_summaries (paper_id, messages, status) VALUES (${s.paper_a}, '[{"content":"x"}]', 'complete')`;
      const { result, calls } = await summary(s.paper_a);
      expect(result).toEqual({ status: 'exists', paper_id: s.paper_a });
      expect(calls).toHaveLength(0);
    });

    it('generating under another task id returns already_generating', async () => {
      await sql`INSERT INTO paper_summaries (paper_id, status, task_id) VALUES (${s.paper_a}, 'generating', 'other-job')`;
      const { result, calls } = await summary(s.paper_a);
      expect(result).toEqual({ status: 'already_generating', paper_id: s.paper_a });
      expect(calls).toHaveLength(0);
      expect((await summaryRow(s.paper_a))!.status).toBe('generating');
    });

    it('generating under its own job id regenerates', async () => {
      const jobId = randomUUID();
      await sql`INSERT INTO paper_summaries (paper_id, status, task_id) VALUES (${s.paper_a}, 'generating', ${jobId})`;
      const { result } = await summary(s.paper_a, { jobId });
      expect(result).toMatchObject({ status: 'complete', message_count: 8 });
      const row = await summaryRow(s.paper_a);
      expect(row!.status).toBe('complete');
      expect(row!.task_id).toBeNull();
    });

    it('generating with no task id regenerates', async () => {
      await sql`INSERT INTO paper_summaries (paper_id, status, task_id) VALUES (${s.paper_a}, 'generating', NULL)`;
      const { result } = await summary(s.paper_a);
      expect(result).toMatchObject({ status: 'complete' });
    });

    it('an error row regenerates and bumps generated_at', async () => {
      await sql`
        INSERT INTO paper_summaries (paper_id, status, generated_at)
        VALUES (${s.paper_a}, 'error', now() - interval '1 day')`;
      const { result } = await summary(s.paper_a);
      expect(result).toMatchObject({ status: 'complete' });
      const [row] = await sql`
        SELECT status, generated_at > now() - interval '1 minute' AS fresh FROM paper_summaries WHERE paper_id = ${s.paper_a}`;
      expect(row).toEqual({ status: 'complete', fresh: true });
    });
  });

  it('throws for a missing paper and for a paper without chunks', async () => {
    const h = harness({});
    const missing = randomUUID();
    await expect(generatePaperSummary({ paper_id: missing }, h.ctx, h.deps)).rejects.toThrow(`Paper ${missing} not found`);
    await expect(generatePaperSummary({ paper_id: s.paper_b }, h.ctx, h.deps)).rejects.toThrow(
      `No chunks found for paper ${s.paper_b}`,
    );
    expect(h.lines.filter((l) => l.msg === 'paper_summary_failed')).toHaveLength(2);
  });

  describe('Review Focus 4: garbage output stores one complete fallback bubble', () => {
    const cases: Array<[string, string]> = [
      ['prose_only', 'This paper is about seminars and finds that turns cluster.'],
      ['array_of_strings', '["first point", "second point"]'],
      ['think_only', '(no content returned)'],
      ['objects_without_content', rawOf('objects_without_content')],
      ['truncated_array', '[{"role":"paper","content":"a"'],
    ];
    for (const [name, content] of cases) {
      it(name, async () => {
        const { result, lines } = await summary(s.paper_a, { chat: () => rawOf(name) });
        expect(result).toEqual({ status: 'complete', paper_id: s.paper_a, message_count: 1 });
        const row = await summaryRow(s.paper_a);
        expect(row!.status).toBe('complete');
        expect(row!.messages).toEqual([{ role: 'paper', type: 'summary', content }]);
        expect(lines.some((l) => l.msg === 'summary_parse_empty')).toBe(true);
      });
    }

    it('a greedy span that fails to parse logs summary_parse_failed', async () => {
      const { lines } = await summary(s.paper_a, { chat: () => rawOf('greedy_span_two_arrays') });
      expect((await summaryRow(s.paper_a))!.messages).toEqual([
        { role: 'paper', type: 'summary', content: rawOf('greedy_span_two_arrays') },
      ]);
      expect(lines.some((l) => l.msg === 'summary_parse_failed')).toBe(true);
    });
  });

  describe('final failure', () => {
    async function failing(isFinalAttempt: boolean) {
      const jobId = randomUUID();
      await sql`INSERT INTO paper_summaries (paper_id, status, task_id) VALUES (${s.paper_a}, 'generating', ${jobId})`;
      const h = harness({ jobId, isFinalAttempt, chat: () => '' });
      await expect(generatePaperSummary({ paper_id: s.paper_a }, h.ctx, h.deps)).rejects.toThrow(
        'LLM returned empty response',
      );
      expect(h.lines.some((l) => l.msg === 'paper_summary_failed')).toBe(true);
      return { jobId, row: await summaryRow(s.paper_a) };
    }

    it('a non-final attempt leaves the row generating and rethrows', async () => {
      const { jobId, row } = await failing(false);
      expect(row).toMatchObject({ status: 'generating', task_id: jobId });
    });

    it('the final attempt marks the row error with task_id NULL', async () => {
      const { row } = await failing(true);
      expect(row).toMatchObject({ status: 'error', task_id: null });
    });

    // Deliberate change 7: the final-attempt error mark only touches this job's own (or an unowned) generating row.
    // J1 passes the guard while it owns the row; `during` runs inside J1's LLM call, before J1 fails for good.
    async function finalFailureAfter(during: () => Promise<unknown>) {
      const j1 = randomUUID();
      await sql`INSERT INTO paper_summaries (paper_id, status, task_id) VALUES (${s.paper_a}, 'generating', ${j1})`;
      const h = harness({
        jobId: j1,
        isFinalAttempt: true,
        chat: async () => {
          await during();
          return '';
        },
      });
      await expect(generatePaperSummary({ paper_id: s.paper_a }, h.ctx, h.deps)).rejects.toThrow(
        'LLM returned empty response',
      );
      return summaryRow(s.paper_a);
    }

    it('a final failure of J1 leaves a row that J2 took over generating under J2', async () => {
      const j2 = randomUUID();
      const row = await finalFailureAfter(() => sql`UPDATE paper_summaries SET task_id = ${j2} WHERE paper_id = ${s.paper_a}`);
      expect(row).toMatchObject({ status: 'generating', task_id: j2 });
    });

    it('a final failure of J1 leaves a row that J2 completed complete', async () => {
      const row = await finalFailureAfter(
        () => sql`UPDATE paper_summaries SET status = 'complete', task_id = NULL WHERE paper_id = ${s.paper_a}`,
      );
      expect(row).toMatchObject({ status: 'complete', task_id: null });
    });

    it('the final attempt marks an unowned generating row error', async () => {
      await sql`INSERT INTO paper_summaries (paper_id, status, task_id) VALUES (${s.paper_a}, 'generating', NULL)`;
      const h = harness({ isFinalAttempt: true, chat: () => '' });
      await expect(generatePaperSummary({ paper_id: s.paper_a }, h.ctx, h.deps)).rejects.toThrow();
      expect(await summaryRow(s.paper_a)).toMatchObject({ status: 'error', task_id: null });
    });
  });

  it('provider isolation: the LLM call carries the paper owner model', async () => {
    await seedChunks(s.paper_b, s.user_b);
    await setSettings(s.user_a, { ollama_llm_model: 'model-a' });
    await setSettings(s.user_b, { ollama_llm_model: 'model-b' });
    const a = await summary(s.paper_a);
    const b = await summary(s.paper_b);
    expect(a.calls.map((c) => c.model)).toEqual(['model-a']);
    expect(b.calls.map((c) => c.model)).toEqual(['model-b']);
  });

  it('a paper without an owner uses the stub user settings', async () => {
    await sql`INSERT INTO users (id, email) VALUES (${STUB_USER_ID}, 'stub@ficino.dev') ON CONFLICT (id) DO NOTHING`;
    await setSettings(STUB_USER_ID, { ollama_llm_model: 'model-stub' });
    const orphan = randomUUID();
    await sql`INSERT INTO papers (id, user_id, filename, file_path, status) VALUES (${orphan}, NULL, 'o.pdf', '/x', 'complete')`;
    await seedChunks(orphan, null);
    const { calls } = await summary(orphan);
    expect(calls.map((c) => c.model)).toEqual(['model-stub']);
  });
});

describe('generate_corpus_synthesis', () => {
  const synthesis = async (
    data: { synthesis_id: string; paper_ids: string[]; name: string; user_id: string },
    opts: RunOpts = {},
  ) => {
    const h = harness(opts);
    const result = await generateCorpusSynthesis(data, h.ctx, h.deps);
    return { ...h, result };
  };

  it('upserts a complete row when the API placeholder is missing', async () => {
    const id = randomUUID();
    const { result, infos, ctx } = await synthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'Syn', user_id: s.user_a });
    expect(result).toEqual({ status: 'complete', synthesis_id: id, message_count: 8 });
    const row = await synthRow(id);
    expect(row).toMatchObject({ user_id: s.user_a, name: 'Syn', paper_ids: [s.paper_a], status: 'complete', task_id: null });
    expect((row!.messages as unknown[]).length).toBe(8);
    expect(infos[0]).toMatchObject({ purpose: 'synthesis', temperature: 0.7, maxTokens: 1024 });
    expect(infos[0]!.user).toContain('=== <untrusted>a.pdf</untrusted> ===\n[results]\n<untrusted>Evidence 0 for paper.</untrusted>');
    const [p] = await sql`SELECT meta FROM job_progress WHERE job_id = ${ctx.jobId}`;
    expect(p!.meta).toEqual({ step: 'synthesizing', synthesis_id: id });
  });

  it('completes the generating placeholder in place', async () => {
    const id = randomUUID();
    const jobId = randomUUID();
    await sql`
      INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, status, task_id)
      VALUES (${id}, ${s.user_a}, 'Placeholder', ${[s.paper_a]}::uuid[], 'generating', ${jobId})`;
    await synthesis(
      { synthesis_id: id, paper_ids: [s.paper_a], name: 'Other name', user_id: s.user_a },
      { jobId, chat: () => rawOf('think_only') },
    );
    expect(await synthRow(id)).toMatchObject({
      name: 'Placeholder',
      status: 'complete',
      task_id: null,
      messages: [{ role: 'synthesis', type: 'summary', content: '(no content)' }],
    });
  });

  it('skips idempotently when messages already exist', async () => {
    const id = randomUUID();
    await sql`
      INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status)
      VALUES (${id}, ${s.user_a}, 'Done', ${[s.paper_a]}::uuid[], '[{"content":"a"},{"content":"b"}]', 'complete')`;
    const { result, calls } = await synthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'Done', user_id: s.user_a });
    expect(result).toEqual({ status: 'complete', synthesis_id: id, message_count: 2, idempotent: true });
    expect(calls).toHaveLength(0);
  });

  it('deliberate change 23: the skip heals a generating row whose messages are a non-array', async () => {
    const id = randomUUID();
    const jobId = randomUUID();
    // A double-encoded legacy value: a jsonb string (sql.json of a JS string), truthy for the skip but not an array
    // for the group-chat stuck check.
    await sql`
      INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
      VALUES (${id}, ${s.user_a}, 'Legacy', ${[s.paper_a]}::uuid[], ${sql.json('[{"content":"a"}]')},
              'generating', ${jobId})`;
    const { result, calls } = await synthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'Legacy', user_id: s.user_a });
    expect(result).toMatchObject({ status: 'complete', synthesis_id: id, idempotent: true });
    expect(calls).toHaveLength(0);
    expect(await synthRow(id)).toMatchObject({ status: 'complete', task_id: null, messages: '[{"content":"a"}]' });
  });

  it('the skip heals only a generating row (an error row keeps its status)', async () => {
    const id = randomUUID();
    await sql`
      INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
      VALUES (${id}, ${s.user_a}, 'Done', ${[s.paper_a]}::uuid[], '[{"content":"a"}]', 'error', NULL)`;
    await synthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'Done', user_id: s.user_a });
    expect((await synthRow(id)).status).toBe('error');
  });

  it('an empty-messages placeholder is not skipped', async () => {
    const id = randomUUID();
    await sql`
      INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, status)
      VALUES (${id}, ${s.user_a}, 'P', ${[s.paper_a]}::uuid[], 'generating')`;
    const { result } = await synthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'P', user_id: s.user_a });
    expect(result).toEqual({ status: 'complete', synthesis_id: id, message_count: 8 });
  });

  describe('final failure (test_generate_corpus_synthesis_marks_error_on_retry_exhaustion)', () => {
    async function noChunks(isFinalAttempt: boolean) {
      const id = randomUUID();
      const jobId = randomUUID();
      await sql`
        INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, status, task_id)
        VALUES (${id}, ${s.user_b}, 'P', ${[s.paper_b]}::uuid[], 'generating', ${jobId})`;
      const h = harness({ jobId, isFinalAttempt });
      await expect(
        generateCorpusSynthesis({ synthesis_id: id, paper_ids: [s.paper_b], name: 'P', user_id: s.user_b }, h.ctx, h.deps),
      ).rejects.toThrow('No chunks found for any of the papers');
      expect(h.calls).toHaveLength(0);
      expect(h.lines.some((l) => l.msg === 'corpus_synthesis_failed')).toBe(true);
      return { id, jobId };
    }

    it('the final attempt marks the row error with task_id NULL', async () => {
      const { id } = await noChunks(true);
      expect(await synthRow(id)).toMatchObject({ status: 'error', task_id: null });
    });

    it('a non-final attempt leaves the row generating', async () => {
      const { id, jobId } = await noChunks(false);
      expect(await synthRow(id)).toMatchObject({ status: 'generating', task_id: jobId });
    });

    // Deliberate change 7, as for the paper summary.
    it('a final failure of J1 leaves a row that J2 owns generating under J2', async () => {
      const id = randomUUID();
      const j2 = randomUUID();
      await sql`
        INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, status, task_id)
        VALUES (${id}, ${s.user_a}, 'P', ${[s.paper_a]}::uuid[], 'generating', ${j2})`;
      const h = harness({ isFinalAttempt: true, chat: () => '' });
      await expect(
        generateCorpusSynthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'P', user_id: s.user_a }, h.ctx, h.deps),
      ).rejects.toThrow('LLM returned empty response');
      expect(h.jobId).not.toBe(j2);
      expect(await synthRow(id)).toMatchObject({ status: 'generating', task_id: j2 });
    });

    it('a final failure leaves a row completed during its LLM call complete', async () => {
      const id = randomUUID();
      const jobId = randomUUID();
      await sql`
        INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, status, task_id)
        VALUES (${id}, ${s.user_a}, 'P', ${[s.paper_a]}::uuid[], 'generating', ${jobId})`;
      const h = harness({
        jobId,
        isFinalAttempt: true,
        chat: async () => {
          await sql`UPDATE corpus_syntheses SET status = 'complete', task_id = NULL WHERE id = ${id}`;
          return '';
        },
      });
      await expect(
        generateCorpusSynthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'P', user_id: s.user_a }, h.ctx, h.deps),
      ).rejects.toThrow('LLM returned empty response');
      expect(await synthRow(id)).toMatchObject({ status: 'complete', task_id: null });
    });

    it('an LLM failure on the final attempt marks the row error', async () => {
      const id = randomUUID();
      const jobId = randomUUID();
      await sql`
        INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, status, task_id)
        VALUES (${id}, ${s.user_a}, 'P', ${[s.paper_a]}::uuid[], 'generating', ${jobId})`;
      const h = harness({ jobId, isFinalAttempt: true, chat: () => '' });
      await expect(
        generateCorpusSynthesis({ synthesis_id: id, paper_ids: [s.paper_a], name: 'P', user_id: s.user_a }, h.ctx, h.deps),
      ).rejects.toThrow('LLM returned empty response');
      expect(await synthRow(id)).toMatchObject({ status: 'error', task_id: null });
    });
  });

  it('provider isolation: the LLM call carries the requesting user model', async () => {
    await setSettings(s.user_a, { ollama_llm_model: 'model-a' });
    await setSettings(s.user_b, { ollama_llm_model: 'model-b' });
    await seedChunks(s.paper_b, s.user_b);
    const { calls } = await synthesis({ synthesis_id: randomUUID(), paper_ids: [s.paper_b], name: 'S', user_id: s.user_b });
    expect(calls.map((c) => c.model)).toEqual(['model-b']);
  });
});

it('both jobs are registered handlers', () => {
  expect(HANDLERS.generate_paper_summary).toBeTypeOf('function');
  expect(HANDLERS.generate_corpus_synthesis).toBeTypeOf('function');
});
