import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ARCHIVIST_SYSTEM_FALLBACK, followupUserPrompt } from '../../src/conversations/archivist.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { providerConfig } from '../../src/providers/config.js';
import { embedModelId } from '../../src/providers/embed.js';
import { LocalStorage } from '../../src/storage/local.js';
import {
  getArchivistPaperIds,
  respondToUserPost,
  respondToUserPostFollowup,
} from '../../src/tasks/archivist.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, fakeVector, type ChatInfo } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const storage = new LocalStorage(config, Buffer.from('k'.repeat(32)));
const MODEL = embedModelId(providerConfig({}, {}, config));
const OTHER_MODEL = 'voyage:voyage-4-large@1024';

type Line = Record<string, unknown> & { msg?: string };

let s: Seeded;

async function addPaper(userId: string, corpusId: string | null, status = 'complete') {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, title, authors, year, filename, file_path, status)
    VALUES (${id}, ${userId}, ${corpusId}, ${`Paper ${id.slice(0, 4)}`}, ${['Ada Alpha']}, 2021, ${`${id}.pdf`},
            ${`/papers/${id}.pdf`}, ${status})`;
  return id;
}

async function addChunks(paperId: string, userId: string, n = 4, model = MODEL) {
  const contents = Array.from({ length: n }, (_, i) => `Turn-taking evidence ${i} for ${paperId.slice(0, 8)}.`);
  const vecs = contents.map((c) => `[${fakeVector(c, 1024).join(',')}]`);
  await sql`
    INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count, embedding, metadata)
    SELECT ${paperId}::uuid, ${userId}::uuid, 'results', t.c, (t.i - 1)::int, 12, t.v::vector,
           ${sql.json({ embed_model: model })}
    FROM unnest(${contents}::text[], ${vecs}::text[]) WITH ORDINALITY AS t(c, v, i)`;
}

async function addPost(
  userId: string,
  corpusId: string | null,
  o: { content?: string; replies?: unknown[]; sources?: unknown[]; status?: string; taskId?: string } = {},
) {
  const id = randomUUID();
  await sql`
    INSERT INTO user_posts (id, user_id, corpus_id, content, replies, sources, status, task_id)
    VALUES (${id}, ${userId}, ${corpusId}, ${o.content ?? 'What do the papers say about turn-taking?'},
            ${sql.json((o.replies ?? []) as never)}, ${sql.json((o.sources ?? []) as never)}, ${o.status ?? 'pending'},
            ${o.taskId ?? null})`;
  return id;
}

const postRow = async (id: string) => (await sql`SELECT replies, sources, status FROM user_posts WHERE id = ${id}`)[0]!;
const markRow = async (id: string) => (await sql`SELECT status, task_id FROM user_posts WHERE id = ${id}`)[0]!;

async function setSettings(userId: string, settings: Record<string, unknown>) {
  await sql`
    INSERT INTO user_settings (user_id, settings) VALUES (${userId}, ${sql.json(settings as never)})
    ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`;
}

/** Run `fn` with the archivist persona's prompt replaced, restoring it afterwards (personas survive resetDb). */
async function withArchivistPrompt<T>(prompt: string, fn: () => Promise<T>): Promise<T> {
  const [row] = await sql`SELECT system_prompt FROM personas WHERE key = 'archivist'`;
  await sql`UPDATE personas SET system_prompt = ${prompt} WHERE key = 'archivist'`;
  try {
    return await fn();
  } finally {
    await sql`UPDATE personas SET system_prompt = ${row!.system_prompt as string} WHERE key = 'archivist'`;
  }
}

function harness(chat?: (info: ChatInfo) => string, o: { final?: boolean } = {}) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x)) });
  const infos: ChatInfo[] = [];
  const providers = fakeProviders({
    chat: (_body, info) => {
      infos.push(info);
      return chat ? chat(info) : 'Alpha (2021) found turns cluster. Doe (2019) disagrees.';
    },
  });
  // retryCount 0 of retryLimit 2: never the final attempt, unless `final` (retryCount 2 of 2).
  const ctx = makeJobContext(
    {
      id: randomUUID(),
      name: 'respond_to_user_post',
      retryCount: o.final ? 2 : 0,
      signal: new AbortController().signal,
    },
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
  const chats = () => providers.calls.filter((c) => !c.kind.endsWith('-embed'));
  const embeds = () => providers.calls.filter((c) => c.kind.endsWith('-embed'));
  return { ctx, deps, lines, infos, chats, embeds };
}

const logged = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg);

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  await sql`UPDATE papers SET title = 'Seminar Turns', authors = ${['Ada Alpha']}, year = 2021 WHERE id = ${s.paper_a}`;
  await addChunks(s.paper_a, s.user_a);
});

describe('getArchivistPaperIds (test_archivist_get_paper_ids_*)', () => {
  it('scopes by corpus and owner, complete papers only', async () => {
    await addPaper(s.user_a, s.workspace_a, 'processing');
    await addPaper(s.user_b, s.workspace_a);
    await addPaper(s.user_a, null);
    expect(await getArchivistPaperIds(sql, s.user_a, s.workspace_a)).toEqual([s.paper_a]);
  });

  it('without a corpus scopes by owner only: user B papers are never included', async () => {
    const a2 = await addPaper(s.user_a, null);
    const ids = await getArchivistPaperIds(sql, s.user_a, null);
    expect([...ids].sort()).toEqual([s.paper_a, a2].sort());
    expect(ids).not.toContain(s.paper_b);
  });

  it('returns [] when there are none', async () => {
    const [c] = await sql`INSERT INTO corpora (user_id, name) VALUES (${s.user_a}, 'Empty') RETURNING id`;
    expect(await getArchivistPaperIds(sql, s.user_a, c!.id as string)).toEqual([]);
    await sql`DELETE FROM papers`;
    expect(await getArchivistPaperIds(sql, s.user_a, null)).toEqual([]);
  });
});

describe('respond_to_user_post', () => {
  it('stores the scrubbed reply, sources with chunk_id, and complete', async () => {
    await setSettings(s.user_a, { persona_temperature: 0.3 });
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness();
    const result = await respondToUserPost({ user_post_id: id }, h.ctx, h.deps);
    expect(result).toEqual({ status: 'complete', user_post_id: id, duration_ms: expect.any(Number) });

    expect(h.infos).toHaveLength(1);
    const info = h.infos[0]!;
    expect(info).toMatchObject({ purpose: 'archivist', temperature: 0.3, maxTokens: 1024 });
    expect(info.user).toBe('What do the papers say about turn-taking?');
    expect(info.system).toContain('CORPUS CONTEXT:\n[Seminar Turns — results]\n<untrusted>Turn-taking evidence');

    const row = await postRow(id);
    expect(row.status).toBe('complete');
    expect(row.replies).toEqual([
      { role: 'archivist', persona: 'archivist', content: 'Alpha (2021) found turns cluster. disagrees.' },
    ]);
    const sources = row.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(4);
    for (const src of sources) {
      expect(src.chunk_id).toEqual(expect.any(String));
      expect(src.paper_id).toBe(s.paper_a);
    }
    const warn = logged(h.lines, 'archivist_hallucinated_citation');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ count: 1, citations: ['Doe (2019)'], user_post_id: id });
    expect(logged(h.lines, 'archivist_chunks_retrieved')[0]).toMatchObject({ chunks: 4 });
  });

  it('uses the persona_temperature default of 0.8', async () => {
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness();
    await respondToUserPost({ user_post_id: id }, h.ctx, h.deps);
    expect(h.infos[0]!.temperature).toBe(0.8);
  });

  it('an empty corpus stores the canned reply with no LLM call', async () => {
    const id = await addPost(s.user_b, null);
    await sql`UPDATE papers SET status = 'processing' WHERE id = ${s.paper_b}`;
    const h = harness();
    expect(await respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).toEqual({ status: 'complete', user_post_id: id });
    expect(h.chats()).toHaveLength(0);
    expect(h.embeds()).toHaveLength(0);
    const row = await postRow(id);
    expect(row).toEqual({
      status: 'complete',
      sources: [],
      replies: [
        {
          role: 'archivist',
          persona: 'archivist',
          content:
            "Your corpus is empty — I don't have any papers to search. Upload some PDFs and I'll be able to answer questions about them.",
        },
      ],
    });
  });

  it("the row's corpus_id wins over the argument", async () => {
    const [other] = await sql`INSERT INTO corpora (user_id, name) VALUES (${s.user_a}, 'Other') RETURNING id`;
    const a3 = await addPaper(s.user_a, other!.id as string);
    await addChunks(a3, s.user_a);
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness();
    await respondToUserPost({ user_post_id: id, corpus_id: other!.id as string }, h.ctx, h.deps);
    const sources = (await postRow(id)).sources as Array<Record<string, unknown>>;
    expect(new Set(sources.map((x) => x.paper_id))).toEqual(new Set([s.paper_a]));

    // A post without a corpus takes the argument's.
    const id2 = await addPost(s.user_a, null);
    await respondToUserPost({ user_post_id: id2, corpus_id: other!.id as string }, h.ctx, h.deps);
    const sources2 = (await postRow(id2)).sources as Array<Record<string, unknown>>;
    expect(new Set(sources2.map((x) => x.paper_id))).toEqual(new Set([a3]));
  });

  it('Review Focus 5: a DB prompt with a stray { fails the job and leaves the post error', async () => {
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness();
    await withArchivistPrompt('Use { wisely.', async () => {
      await expect(respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow(/^ValueError: /);
    });
    expect(h.chats()).toHaveLength(0);
    const row = await postRow(id);
    expect(row).toEqual({ status: 'error', replies: [], sources: [] });
    expect(logged(h.lines, 'archivist_response_failed')).toHaveLength(1);
  });

  it('a DB prompt is used verbatim, with doubled braces unescaped', async () => {
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness();
    await withArchivistPrompt('You are the DB Archivist. Keep {{braces}}.', () =>
      respondToUserPost({ user_post_id: id }, h.ctx, h.deps),
    );
    expect(h.infos[0]!.system.startsWith('You are the DB Archivist. Keep {braces}.\n\nFORMATTING:')).toBe(true);
  });

  it('a blank or missing persona prompt falls back with a warning', async () => {
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness();
    await withArchivistPrompt(' \n\t', () => respondToUserPost({ user_post_id: id }, h.ctx, h.deps));
    expect(h.infos[0]!.system.startsWith(ARCHIVIST_SYSTEM_FALLBACK + '\n\nFORMATTING:')).toBe(true);
    expect(logged(h.lines, 'archivist_persona_prompt_missing_using_fallback')).toHaveLength(1);

    await sql`UPDATE personas SET is_active = false WHERE key = 'archivist'`;
    // An answered first post is skipped (deliberate change 22), so the second run starts from an unanswered one.
    await sql`UPDATE user_posts SET replies = '[]'::jsonb, status = 'pending' WHERE id = ${id}`;
    try {
      const h2 = harness();
      await respondToUserPost({ user_post_id: id }, h2.ctx, h2.deps);
      expect(h2.infos[0]!.system.startsWith(ARCHIVIST_SYSTEM_FALLBACK)).toBe(true);
      expect(logged(h2.lines, 'archivist_persona_prompt_missing_using_fallback')).toHaveLength(1);
    } finally {
      await sql`UPDATE personas SET is_active = true WHERE key = 'archivist'`;
    }
  });

  it('marks the post error on a non-final attempt too, and rethrows', async () => {
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness(() => '');
    expect(h.ctx.isFinalAttempt).toBe(false);
    await expect(respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow('LLM returned empty response');
    expect((await postRow(id)).status).toBe('error');
  });

  it('deliberate change 11: a failure on the final attempt marks error and clears its own task_id', async () => {
    const h = harness(() => '', { final: true });
    expect(h.ctx.isFinalAttempt).toBe(true);
    const id = await addPost(s.user_a, s.workspace_a, { taskId: h.ctx.jobId });
    await expect(respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow('LLM returned empty response');
    expect(await markRow(id)).toEqual({ status: 'error', task_id: null });
  });

  it('a failure on a non-final attempt marks error and keeps its task_id', async () => {
    const h = harness(() => '');
    const id = await addPost(s.user_a, s.workspace_a, { taskId: h.ctx.jobId });
    await expect(respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow('LLM returned empty response');
    expect(await markRow(id)).toEqual({ status: 'error', task_id: h.ctx.jobId });
  });

  it.each([false, true])('a row owned by another job is not marked (final=%s)', async (final) => {
    const h = harness(() => '', { final });
    const other = randomUUID();
    const id = await addPost(s.user_a, s.workspace_a, { taskId: other });
    await expect(respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow('LLM returned empty response');
    expect(await markRow(id)).toEqual({ status: 'pending', task_id: other });
    expect(logged(h.lines, 'archivist_response_failed')).toHaveLength(1);
  });

  it('a missing row throws', async () => {
    const id = randomUUID();
    const h = harness();
    await expect(respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow(`User post ${id} not found`);
  });

  it('provider isolation: the LLM call carries the post owner model', async () => {
    await setSettings(s.user_a, { ollama_llm_model: 'model-a' });
    await setSettings(s.user_b, { ollama_llm_model: 'model-b' });
    await addChunks(s.paper_b, s.user_b);
    const a = await addPost(s.user_a, null);
    const b = await addPost(s.user_b, null);
    const ha = harness();
    const hb = harness();
    await Promise.all([
      respondToUserPost({ user_post_id: a }, ha.ctx, ha.deps),
      respondToUserPost({ user_post_id: b }, hb.ctx, hb.deps),
    ]);
    expect(ha.chats().map((c) => c.model)).toEqual(['model-a']);
    expect(hb.chats().map((c) => c.model)).toEqual(['model-b']);
  });
});

describe('respond_to_user_post_followup', () => {
  const history = [
    { role: 'archivist', persona: 'archivist', content: 'First answer.' },
    { role: 'user', content: 'And what about cohorts?' },
  ];
  const sources = [{ chunk_id: 'kept', paper_id: 'kept', paper_title: 'T', section: 's', content: 'c', score: 1 }];

  it('appends the reply, leaves sources unchanged, and retrieves with the latest user turn', async () => {
    const id = await addPost(s.user_a, s.workspace_a, { replies: history, sources });
    const h = harness();
    const result = await respondToUserPostFollowup({ user_post_id: id }, h.ctx, h.deps);
    expect(result).toEqual({ status: 'complete', user_post_id: id, duration_ms: expect.any(Number) });

    const row = await postRow(id);
    expect(row.status).toBe('complete');
    expect(row.sources).toEqual(sources);
    expect(row.replies).toEqual([
      ...history,
      { role: 'archivist', persona: 'archivist', content: 'Alpha (2021) found turns cluster. disagrees.' },
    ]);
    expect(h.embeds().map((c) => (c.body as { input: string[] }).input)).toEqual([['And what about cohorts?']]);
    expect(h.infos[0]!.user).toBe(followupUserPrompt('What do the papers say about turn-taking?', history));
    expect(h.infos[0]).toMatchObject({ purpose: 'archivist', maxTokens: 1024, temperature: 0.8 });
    expect(logged(h.lines, 'archivist_followup_hallucinated_citation')[0]).toMatchObject({
      count: 1,
      citations: ['Doe (2019)'],
    });
  });

  it.each([
    ['a system last turn', [{ role: 'system', content: 'Done.' }]],
    ['no turns', []],
  ])('%s throws and marks the post error', async (_name, replies) => {
    const id = await addPost(s.user_a, s.workspace_a, { replies });
    const h = harness();
    await expect(respondToUserPostFollowup({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow(
      'No pending user turn in replies',
    );
    expect(await postRow(id)).toEqual({ status: 'error', replies, sources: [] });
    expect(h.chats()).toHaveLength(0);
    expect(logged(h.lines, 'archivist_followup_failed')).toHaveLength(1);
  });

  it('deliberate change 11: a redelivered follow-up whose answer is stored is an idempotent skip', async () => {
    const replies = [...history, { role: 'archivist', persona: 'archivist', content: 'Second answer.' }];
    const h = harness();
    const id = await addPost(s.user_a, s.workspace_a, { replies, sources, status: 'complete', taskId: h.ctx.jobId });
    expect(await respondToUserPostFollowup({ user_post_id: id }, h.ctx, h.deps)).toEqual({
      status: 'complete',
      user_post_id: id,
      idempotent: true,
    });
    expect(await postRow(id)).toEqual({ status: 'complete', replies, sources });
    expect(await markRow(id)).toEqual({ status: 'complete', task_id: h.ctx.jobId });
    expect(h.chats()).toHaveLength(0);
    expect(h.embeds()).toHaveLength(0);
    expect(logged(h.lines, 'archivist_followup_idempotent_skip')).toHaveLength(1);
    expect(logged(h.lines, 'archivist_followup_failed')).toHaveLength(0);
  });

  describe('deliberate change 22: a redelivery answers only its own turn', () => {
    it('a follow-up whose post now belongs to a queued newer job is skipped with no LLM call', async () => {
      const h = harness();
      // A real queued job (no worker runs in this file), so its state is `created`.
      const newer = await h.deps.queue.send('respond_to_user_post_followup', { user_post_id: randomUUID() });
      const id = await addPost(s.user_a, s.workspace_a, { replies: history, taskId: newer });
      expect(await respondToUserPostFollowup({ user_post_id: id }, h.ctx, h.deps)).toEqual({
        status: 'complete',
        user_post_id: id,
        superseded: true,
      });
      expect(h.chats()).toHaveLength(0);
      expect(h.embeds()).toHaveLength(0);
      expect((await postRow(id)).replies).toEqual(history);
      expect(await markRow(id)).toEqual({ status: 'pending', task_id: newer });
      expect(logged(h.lines, 'archivist_followup_superseded')[0]).toMatchObject({ current_task_id: newer });
    });

    it('a task_id naming a finished or missing job does not stop the answer (a late task_id write)', async () => {
      const h = harness();
      const id = await addPost(s.user_a, s.workspace_a, { replies: history, taskId: randomUUID() });
      expect((await respondToUserPostFollowup({ user_post_id: id }, h.ctx, h.deps)).status).toBe('complete');
      expect(h.chats()).toHaveLength(1);
      expect((await postRow(id)).replies).toHaveLength(history.length + 1);
      expect(logged(h.lines, 'archivist_followup_superseded')).toHaveLength(0);
    });

    it('a redelivered first answer never overwrites a conversation that already has replies', async () => {
      const replies = [
        { role: 'archivist', persona: 'archivist', content: 'First answer.' },
        { role: 'user', content: 'And then?' },
      ];
      const h = harness();
      const id = await addPost(s.user_a, s.workspace_a, { replies, sources, status: 'pending', taskId: h.ctx.jobId });
      expect(await respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).toEqual({
        status: 'complete',
        user_post_id: id,
        idempotent: true,
      });
      expect(await postRow(id)).toEqual({ status: 'pending', replies, sources });
      expect(h.chats()).toHaveLength(0);
      expect(logged(h.lines, 'archivist_response_idempotent_skip')).toHaveLength(1);
    });
  });

  it('a follow-up failure on the final attempt clears its own task_id, so the post is retryable', async () => {
    const h = harness(() => '', { final: true });
    const id = await addPost(s.user_a, s.workspace_a, { replies: history, taskId: h.ctx.jobId });
    await expect(respondToUserPostFollowup({ user_post_id: id }, h.ctx, h.deps)).rejects.toThrow(
      'LLM returned empty response',
    );
    expect(await markRow(id)).toEqual({ status: 'error', task_id: null });
    expect((await postRow(id)).replies).toEqual(history);
  });

  it('an empty corpus appends the short canned reply', async () => {
    await sql`DELETE FROM papers WHERE user_id = ${s.user_a}`;
    const id = await addPost(s.user_a, null, { replies: history });
    const h = harness();
    expect(await respondToUserPostFollowup({ user_post_id: id }, h.ctx, h.deps)).toEqual({
      status: 'complete',
      user_post_id: id,
    });
    expect(h.chats()).toHaveLength(0);
    expect((await postRow(id)).replies).toEqual([
      ...history,
      { role: 'archivist', persona: 'archivist', content: "Your corpus is empty — I don't have any papers to search." },
    ]);
  });
});

describe('deliberate change 5: embed-model mismatch', () => {
  const mismatchText = (n: number) =>
    `None of your papers are searchable with the current embedding model (${MODEL}): ${n} chunks in scope use a different one. Re-process your papers or switch the embedding model back.`;

  it('every in-scope chunk on another model stores the canned reply with no LLM call', async () => {
    await sql`UPDATE chunks SET metadata = ${sql.json({ embed_model: OTHER_MODEL })} WHERE paper_id = ${s.paper_a}`;
    const id = await addPost(s.user_a, s.workspace_a);
    const h = harness();
    expect(await respondToUserPost({ user_post_id: id }, h.ctx, h.deps)).toEqual({ status: 'complete', user_post_id: id });
    expect(h.chats()).toHaveLength(0);
    expect(h.embeds()).toHaveLength(0);
    expect(await postRow(id)).toEqual({
      status: 'complete',
      sources: [],
      replies: [{ role: 'archivist', persona: 'archivist', content: mismatchText(4) }],
    });
    expect(logged(h.lines, 'embed_model_mismatch')[0]).toMatchObject({ expected: MODEL, excluded_chunks: 4 });

    // The follow-up appends the same reply.
    const f = await addPost(s.user_a, s.workspace_a, { replies: [{ role: 'user', content: 'More?' }] });
    const hf = harness();
    await respondToUserPostFollowup({ user_post_id: f }, hf.ctx, hf.deps);
    expect(hf.chats()).toHaveLength(0);
    expect((await postRow(f)).replies).toEqual([
      { role: 'user', content: 'More?' },
      { role: 'archivist', persona: 'archivist', content: mismatchText(4) },
    ]);
  });

  it('a partly mismatched corpus answers from the matching paper and logs embed_model_mismatch', async () => {
    await sql`UPDATE chunks SET metadata = ${sql.json({ embed_model: OTHER_MODEL })} WHERE paper_id = ${s.paper_a}`;
    const a2 = await addPaper(s.user_a, null);
    await addChunks(a2, s.user_a, 3);
    const id = await addPost(s.user_a, null);
    const h = harness();
    await respondToUserPost({ user_post_id: id }, h.ctx, h.deps);
    expect(h.chats()).toHaveLength(1);
    const row = await postRow(id);
    expect(row.status).toBe('complete');
    const srcs = row.sources as Array<Record<string, unknown>>;
    expect(srcs).toHaveLength(3);
    expect(new Set(srcs.map((x) => x.paper_id))).toEqual(new Set([a2]));
    const warn = logged(h.lines, 'embed_model_mismatch');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ expected: MODEL, excluded_chunks: 4 });
  });
});

it('both jobs are registered handlers', () => {
  expect(HANDLERS.respond_to_user_post).toBeTypeOf('function');
  expect(HANDLERS.respond_to_user_post_followup).toBeTypeOf('function');
});
