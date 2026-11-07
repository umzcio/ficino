import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { STUB_USER_ID } from '../../src/shared/constants.js';
import { LocalStorage } from '../../src/storage/local.js';
import { proposeOrdering, type ProposeOrderingData } from '../../src/tasks/readingLists.js';
import { HANDLERS, type WorkerDeps } from '../../src/worker/handlers.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID } from '../helpers/db.js';
import { fakeProviders, type ChatInfo } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

// Ports worker/tests/test_reading_list_persist.py plus the plan 05 Task 3 handler contract.

const sql = testSql();
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const storage = new LocalStorage(config, Buffer.from('k'.repeat(32)));

type Line = Record<string, unknown> & { msg?: string };

beforeEach(async () => {
  await resetDb(sql);
  await seedUsers(sql);
});

async function newPaper(userId: string | null, title: string, chunks: string[] = []): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, title, authors, year, filename, file_path, status)
    VALUES (${id}, ${userId}, ${title}, ${['Ada Alpha']}, 2024, 'x.pdf', '/tmp/x.pdf', 'complete')`;
  for (const [i, content] of chunks.entries()) {
    await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, token_count)
      VALUES (${id}, ${userId ?? STUB_USER_ID}, 'results', ${content}, ${i}, 5)`;
  }
  return id;
}

async function seedList(userId: string, paperIds: string[], statuses?: string[]): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO reading_lists (id, user_id, name, paper_sequence)
    VALUES (${id}, ${userId}, 'L', ${paperIds}::uuid[])`;
  for (const [i, pid] of paperIds.entries()) {
    const status = statuses?.[i] ?? (i === 0 ? 'unlocked' : 'locked');
    await sql`
      INSERT INTO reading_list_chapters (reading_list_id, chapter_index, paper_ids, status)
      VALUES (${id}, ${i}, ${[pid]}::uuid[], ${status})`;
  }
  return id;
}

const chapterRows = async (listId: string) =>
  [...(await sql`SELECT chapter_index, paper_ids, status FROM reading_list_chapters
                  WHERE reading_list_id = ${listId} ORDER BY chapter_index`)].map((r) => ({ ...r }));

const listRow = async (listId: string) =>
  (await sql`SELECT paper_sequence, rationale FROM reading_lists WHERE id = ${listId}`)[0]!;

async function setSettings(userId: string, settings: Record<string, unknown>) {
  await sql`INSERT INTO user_settings (user_id, settings) VALUES (${userId}, ${sql.json(settings as never)})`;
}

function harness(chat?: (info: ChatInfo) => string) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x)) });
  const infos: ChatInfo[] = [];
  const providers = fakeProviders({
    chat: (_body, info) => {
      infos.push(info);
      return chat ? chat(info) : '[]';
    },
  });
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'propose_ordering', retryCount: 0, signal: new AbortController().signal },
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
  return { ctx, deps, lines, infos, calls: providers.calls };
}

async function run(data: ProposeOrderingData, chat?: (info: ChatInfo) => string) {
  const h = harness(chat);
  const result = await proposeOrdering(data, h.ctx, h.deps);
  return { ...h, result };
}

const events = (lines: Line[]) => lines.map((l) => l.msg);

describe('propose_ordering', () => {
  it('is registered', () => {
    expect(HANDLERS.propose_ordering).toBeTypeOf('function');
  });

  it('the route and the job build chapters with the one shared insertChapters', () => {
    const src = (rel: string) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8');
    for (const file of ['routes/readingLists.ts', 'tasks/readingLists.ts']) {
      const text = src(file);
      expect(text).toMatch(/import \{[^}]*\binsertChapters\b[^}]*\} from '\.\.\/readingLists\/chapters\.js'/);
      expect(text).not.toMatch(/INSERT INTO reading_list_chapters/);
    }
  });

  it('deliberate change 19: a repeated paper id is kept once, so no paper gets a second chapter', async () => {
    const p1 = await newPaper(USER_A_ID, 'Foundations', ['Base chunk.']);
    const p2 = await newPaper(USER_A_ID, 'Follow-up', ['Later chunk.']);
    const listId = await seedList(USER_A_ID, [p1, p2]);
    const answer = JSON.stringify([
      { paper_id: p2, position: 1, rationale: 'First.' },
      { paper_id: p1, position: 2, rationale: 'Second.' },
      { paper_id: p2, position: 3, rationale: 'Again.' },
    ]);
    const { result, lines } = await run({ paper_ids: [p1, p2], list_id: listId, user_id: USER_A_ID }, () => answer);
    const row = await listRow(listId);
    expect(row.paper_sequence).toEqual([p2, p1]);
    expect((row.rationale as Array<{ rationale: string }>).map((r) => r.rationale)).toEqual(['First.', 'Second.']);
    expect(await chapterRows(listId)).toEqual([
      { chapter_index: 0, paper_ids: [p2], status: 'unlocked' },
      { chapter_index: 1, paper_ids: [p1], status: 'locked' },
    ]);
    expect((result.ordered_papers as unknown[]).length).toBe(2);
    expect(lines.filter((l) => l.msg === 'propose_ordering_duplicate_ids')).toMatchObject([{ dropped: 1 }]);
    expect(lines.filter((l) => l.msg === 'propose_ordering_id_mismatch')).toHaveLength(0);
  });

  it('persists the reversed order, the rationale and chapters rebuilt from scratch', async () => {
    const p1 = await newPaper(USER_A_ID, 'Foundations', ['Base chunk.']);
    const p2 = await newPaper(USER_A_ID, 'Follow-up', ['Later chunk.']);
    const listId = await seedList(USER_A_ID, [p1, p2], ['complete', 'unlocked']);
    const answer = JSON.stringify([
      { paper_id: p2, position: 1, rationale: 'Read the follow-up first.' },
      { paper_id: p1, position: 2, rationale: 'Then the foundations.' },
    ]);
    const { result, infos, lines } = await run({ paper_ids: [p1, p2], list_id: listId, user_id: USER_A_ID }, () => answer);

    expect(infos).toHaveLength(1);
    expect(infos[0]!.purpose).toBe('ordering');
    expect(infos[0]!.temperature).toBe(0.3);
    expect(infos[0]!.maxTokens).toBe(2048);
    expect(infos[0]!.user).toBe('Analyze these papers and propose the optimal reading order. Return JSON only.');
    const row = await listRow(listId);
    expect(row.paper_sequence).toEqual([p2, p1]);
    const expected = [
      { paper_id: p2, position: 1, rationale: 'Read the follow-up first.', title: 'Follow-up', authors: 'Ada Alpha', year: 2024 },
      { paper_id: p1, position: 2, rationale: 'Then the foundations.', title: 'Foundations', authors: 'Ada Alpha', year: 2024 },
    ];
    expect(row.rationale).toEqual(expected);
    // The complete chapter is wiped too, as in Python.
    expect(await chapterRows(listId)).toEqual([
      { chapter_index: 0, paper_ids: [p2], status: 'unlocked' },
      { chapter_index: 1, paper_ids: [p1], status: 'locked' },
    ]);
    expect(result.ordered_papers).toEqual(expected);
    expect(result.duration_ms).toBeTypeOf('number');
    expect(Object.keys(result).sort()).toEqual(['duration_ms', 'ordered_papers']);
    expect(events(lines)).toEqual([
      'propose_ordering_start',
      'propose_ordering_persisted',
      'propose_ordering_complete',
    ]);
    const start = lines[0]!;
    expect(start.paper_count).toBe(2);
    expect(start.list_id).toBe(listId);
    expect(lines[2]!.papers).toBe(2);
  });

  it('an unknown id falls back to the list order with empty rationales', async () => {
    const p1 = await newPaper(USER_A_ID, 'One');
    const p2 = await newPaper(USER_A_ID, 'Two');
    const p3 = await newPaper(USER_A_ID, 'Three');
    // Insertion order differs from the list order, so heap order would not match.
    const order = [p3, p1, p2];
    const listId = await seedList(USER_A_ID, order);
    const answer = JSON.stringify([{ paper_id: p1 }, { paper_id: p2 }, { paper_id: randomUUID() }]);
    const { lines, infos } = await run({ paper_ids: order, list_id: listId, user_id: USER_A_ID }, () => answer);

    // The prompt follows the list's order (deliberate change 5).
    const sys = infos[0]!.system;
    expect(sys.indexOf(`Paper ID: ${p3}`)).toBeLessThan(sys.indexOf(`Paper ID: ${p1}`));
    expect(sys.indexOf(`Paper ID: ${p1}`)).toBeLessThan(sys.indexOf(`Paper ID: ${p2}`));
    const row = await listRow(listId);
    expect(row.paper_sequence).toEqual(order);
    expect((row.rationale as Record<string, unknown>[]).map((r) => [r.paper_id, r.position, r.rationale])).toEqual([
      [p3, 0, ''],
      [p1, 1, ''],
      [p2, 2, ''],
    ]);
    const warn = lines.find((l) => l.msg === 'propose_ordering_id_mismatch')!;
    expect(warn.level).toBe(40);
    expect(warn.missing).toEqual([p3]);
    expect(warn.extra).toHaveLength(1);
    expect(warn.input_count).toBe(3);
    expect(warn.returned_count).toBe(3);
  });

  it('No papers found for unknown ids: no persist, no throw, no LLM call', async () => {
    const p1 = await newPaper(USER_A_ID, 'One');
    const listId = await seedList(USER_A_ID, [p1]);
    const { result, infos } = await run({ paper_ids: [randomUUID()], list_id: listId, user_id: USER_A_ID });
    expect(result).toEqual({ ordered_papers: [], error: 'No papers found' });
    expect(infos).toHaveLength(0);
    expect((await listRow(listId)).rationale).toEqual([]);
    expect(await chapterRows(listId)).toHaveLength(1);
  });

  it('reads at most the first 5 chunks per paper, by chunk_index', async () => {
    const p1 = await newPaper(USER_A_ID, 'One', ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    const p2 = await newPaper(USER_A_ID, 'Two');
    const { infos } = await run({ paper_ids: [p1, p2], list_id: null, user_id: USER_A_ID });
    expect(infos[0]!.system).toContain('Content preview: <untrusted>c0 c1 c2 c3 c4</untrusted>');
    expect(infos[0]!.system).toContain('Content preview: <untrusted></untrusted>');
  });

  it('without a list_id nothing is written', async () => {
    const p1 = await newPaper(USER_A_ID, 'One');
    const p2 = await newPaper(USER_A_ID, 'Two');
    const listId = await seedList(USER_A_ID, [p1, p2]);
    const answer = JSON.stringify([{ paper_id: p2, position: 1 }, { paper_id: p1, position: 2 }]);
    const { result, lines } = await run({ paper_ids: [p1, p2], user_id: USER_A_ID }, () => answer);
    expect((result.ordered_papers as { paper_id: string }[]).map((o) => o.paper_id)).toEqual([p2, p1]);
    expect((await listRow(listId)).paper_sequence).toEqual([p1, p2]);
    expect(events(lines)).not.toContain('propose_ordering_persisted');
  });

  it('persists in one transaction: a failing chapter insert leaves the list unchanged and throws', async () => {
    const p1 = await newPaper(USER_A_ID, 'One');
    const p2 = await newPaper(USER_A_ID, 'Two');
    const rationale = [{ paper_id: p1, rationale: 'old' }];
    const listId = await seedList(USER_A_ID, [p1, p2], ['complete', 'unlocked']);
    await sql`UPDATE reading_lists SET rationale = ${sql.json(rationale as never)} WHERE id = ${listId}`;
    const before = await chapterRows(listId);
    const answer = JSON.stringify([{ paper_id: p2, position: 1, rationale: 'new' }, { paper_id: p1, position: 2 }]);
    await sql.unsafe(`
      CREATE FUNCTION ficino_test_refuse_chapter() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'chapter insert refused'; END $$`);
    await sql.unsafe(`
      CREATE TRIGGER ficino_test_refuse_chapter BEFORE INSERT ON reading_list_chapters
      FOR EACH ROW EXECUTE FUNCTION ficino_test_refuse_chapter()`);
    try {
      const h = harness(() => answer);
      await expect(
        proposeOrdering({ paper_ids: [p1, p2], list_id: listId, user_id: USER_A_ID }, h.ctx, h.deps),
      ).rejects.toThrow('chapter insert refused');
      const failed = h.lines.find((l) => l.msg === 'propose_ordering_failed')!;
      expect(failed.error).toContain('chapter insert refused');
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS ficino_test_refuse_chapter ON reading_list_chapters');
      await sql.unsafe('DROP FUNCTION IF EXISTS ficino_test_refuse_chapter()');
    }
    const row = await listRow(listId);
    expect(row.paper_sequence).toEqual([p1, p2]);
    expect(row.rationale).toEqual(rationale);
    expect(await chapterRows(listId)).toEqual(before);
  });

  it('a sort TypeError fails the job before any write', async () => {
    const p1 = await newPaper(USER_A_ID, 'One');
    const p2 = await newPaper(USER_A_ID, 'Two');
    const listId = await seedList(USER_A_ID, [p1, p2]);
    const answer = JSON.stringify([{ paper_id: p1, position: 1 }, { paper_id: p2, position: 'a' }]);
    const h = harness(() => answer);
    await expect(
      proposeOrdering({ paper_ids: [p1, p2], list_id: listId, user_id: USER_A_ID }, h.ctx, h.deps),
    ).rejects.toThrow("'<' not supported between instances of 'str' and 'int'");
    expect(events(h.lines)).toContain('propose_ordering_failed');
    expect((await listRow(listId)).rationale).toEqual([]);
  });

  it("the LLM call carries the owner's stored model, not another user's", async () => {
    await setSettings(USER_A_ID, { ollama_llm_model: 'model-a' });
    await setSettings(USER_B_ID, { ollama_llm_model: 'model-b' });
    const pa = await newPaper(USER_A_ID, 'A1');
    const pa2 = await newPaper(USER_A_ID, 'A2');
    const pb = await newPaper(USER_B_ID, 'B1');
    const pb2 = await newPaper(USER_B_ID, 'B2');
    const a = await run({ paper_ids: [pa, pa2], list_id: null, user_id: USER_A_ID });
    const b = await run({ paper_ids: [pb, pb2], list_id: null, user_id: USER_B_ID });
    expect(a.calls.filter((c) => c.kind === 'ollama-chat').map((c) => c.model)).toEqual(['model-a']);
    expect(b.calls.filter((c) => c.kind === 'ollama-chat').map((c) => c.model)).toEqual(['model-b']);
  });

  it('without a user_id the stub user settings apply', async () => {
    await sql`INSERT INTO users (id, email) VALUES (${STUB_USER_ID}, 'stub@ficino.dev') ON CONFLICT (id) DO NOTHING`;
    await setSettings(STUB_USER_ID, { ollama_llm_model: 'model-stub' });
    const p1 = await newPaper(USER_A_ID, 'One');
    const p2 = await newPaper(USER_A_ID, 'Two');
    const { calls } = await run({ paper_ids: [p1, p2], list_id: null });
    expect(calls.filter((c) => c.kind === 'ollama-chat').map((c) => c.model)).toEqual(['model-stub']);
  });
});
