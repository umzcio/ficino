import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { chunkEmbedText } from '../../src/ingest/embedText.js';
import { providerConfig, type ProviderConfig } from '../../src/providers/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';
import { embedModelId, EmbeddingUnavailableError } from '../../src/providers/embed.js';
import { embedModelCounts, reembedUserChunks } from '../../src/tasks/reembed.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, fakeVector } from '../helpers/fakeProviders.js';

const sql = testSql();
const providers = providerConfig({}, {}, loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' }));
const TARGET = embedModelId(providers);
const vecText = (v: number[]): string => `[${v.join(',')}]`;
const OLD = vecText(new Array<number>(1024).fill(0.25));
const V2 = vecText(new Array<number>(1024).fill(-0.5));

let s: Seeded;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
});

type ChunkOpts = { content?: string; prefix?: string | null; metadata?: unknown; embedding?: string };

/** One chunk; `metadata: null` stores SQL NULL, anything else (default `{}`) is stored as jsonb. */
async function addChunk(paperId: string, userId: string, index: number, o: ChunkOpts = {}): Promise<string> {
  const content = o.content ?? `Chunk ${index} of ${paperId}.`;
  const metadata = o.metadata === null ? null : sql.json((o.metadata ?? {}) as never);
  const [row] = await sql`
    INSERT INTO chunks (paper_id, user_id, section, content, chunk_index, embedding, metadata, contextual_prefix)
    VALUES (${paperId}, ${userId}, 'body', ${content}, ${index}, ${o.embedding ?? OLD}::vector, ${metadata}::jsonb,
            ${o.prefix ?? null})
    RETURNING id`;
  return String(row!.id);
}

type ChunkRow = { id: string; content: string; contextual_prefix: string | null; metadata: any; old: boolean };

async function chunks(paperId: string): Promise<ChunkRow[]> {
  return (await sql`
    SELECT id::text, content, contextual_prefix, metadata, embedding = ${OLD}::vector AS old
    FROM chunks WHERE paper_id = ${paperId} ORDER BY chunk_index`) as unknown as ChunkRow[];
}

async function embeddingIs(id: string, vec: string): Promise<boolean> {
  const [row] = await sql`SELECT embedding = ${vec}::vector AS same FROM chunks WHERE id = ${id}`;
  return row!.same as boolean;
}

/** The vector the fake embedder returns for this row's embed text. */
const fakeFor = (r: { content: string; contextual_prefix: string | null }): string =>
  vecText(fakeVector(chunkEmbedText(r), 1024));

const embedInputs = (calls: ReturnType<typeof fakeProviders>['calls']): string[] =>
  calls.filter((c) => c.kind === 'ollama-embed').flatMap((c) => (c.body as { input: string[] }).input);

/** Runs `hook` before each fetch (1-based call number); a Response it returns replaces the fake's answer. */
function withHook(deps: ProviderDeps, hook: (n: number) => Response | void | Promise<Response | void>): ProviderDeps {
  let n = 0;
  return {
    ...deps,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      n += 1;
      const replaced = await hook(n);
      return replaced ?? deps.fetch(input, init);
    }) as typeof fetch,
  };
}

describe('reembedUserChunks', () => {
  it('re-embeds only chunks whose embed_model differs and tags them in the same write', async () => {
    const c0 = await addChunk(s.paper_a, s.user_a, 0);
    const c1 = await addChunk(s.paper_a, s.user_a, 1, { metadata: { embed_model: 'ollama:old-model@1024', keep: 2 } });
    const c2 = await addChunk(s.paper_a, s.user_a, 2, { metadata: { embed_model: TARGET, keep: 1 }, embedding: V2 });
    const before = await chunks(s.paper_a);
    const { deps, calls } = fakeProviders();

    const result = await reembedUserChunks(sql, providers, deps, { userId: s.user_a });

    expect(result).toEqual({ target: TARGET, updated: 2, remaining: 0 });
    expect(embedInputs(calls)).toEqual([chunkEmbedText(before[0]!), chunkEmbedText(before[1]!)]);
    const after = await chunks(s.paper_a);
    expect(after.map((r) => r.metadata.embed_model)).toEqual([TARGET, TARGET, TARGET]);
    expect(after[1]!.metadata.keep).toBe(2);
    expect(after[2]!.metadata).toEqual({ embed_model: TARGET, keep: 1 });
    expect(await embeddingIs(c0, fakeFor(before[0]!))).toBe(true);
    expect(await embeddingIs(c1, fakeFor(before[1]!))).toBe(true);
    expect(await embeddingIs(c2, V2)).toBe(true);
  });

  it('embeds the same text ingestion embeds', async () => {
    await addChunk(s.paper_a, s.user_a, 0, { content: 'Body \n', prefix: ' Ctx' });
    await addChunk(s.paper_a, s.user_a, 1, { content: ' Plain ', prefix: null });
    const { deps, calls } = fakeProviders();

    await reembedUserChunks(sql, providers, deps, { userId: s.user_a });

    expect(embedInputs(calls)).toEqual(['Ctx\n\nBody', ' Plain ']);
    const rows = await chunks(s.paper_a);
    expect(embedInputs(calls)).toEqual(rows.map((r) => chunkEmbedText(r)));
  });

  it('a second run is a no-op', async () => {
    await addChunk(s.paper_a, s.user_a, 0);
    await addChunk(s.paper_a, s.user_a, 1);
    await reembedUserChunks(sql, providers, fakeProviders().deps, { userId: s.user_a });
    const { deps, calls } = fakeProviders();

    expect(await reembedUserChunks(sql, providers, deps, { userId: s.user_a })).toEqual({
      target: TARGET,
      updated: 0,
      remaining: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it('never touches another user', async () => {
    await addChunk(s.paper_a, s.user_a, 0, { content: 'Mine.' });
    await addChunk(s.paper_b, s.user_b, 0, { content: 'Theirs.' });
    await addChunk(s.paper_b, s.user_b, 1, { content: 'Also theirs.', metadata: null });
    const { deps, calls } = fakeProviders();

    expect(await reembedUserChunks(sql, providers, deps, { userId: s.user_a })).toEqual({
      target: TARGET,
      updated: 1,
      remaining: 0,
    });
    expect(embedInputs(calls)).toEqual(['Mine.']);
    const theirs = await chunks(s.paper_b);
    expect(theirs.map((r) => r.metadata)).toEqual([{}, null]);
    expect(theirs.every((r) => r.old)).toBe(true);
  });

  // Review Focus 3.
  it('abort after the first batch leaves a consistent partial', async () => {
    for (let i = 0; i < 5; i++) await addChunk(s.paper_a, s.user_a, i);
    const before = await chunks(s.paper_a);
    const ac = new AbortController();
    const fake = fakeProviders();
    // The fake still answers call 2 with vectors: only the check after embedTexts keeps batch 2 from being written.
    const deps = withHook(fake.deps, (n) => {
      if (n === 2) ac.abort();
    });

    await expect(
      reembedUserChunks(sql, providers, deps, { userId: s.user_a, signal: ac.signal, batchSize: 2 }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(embedInputs(fake.calls)).toHaveLength(4); // both batches were embedded
    const after = await chunks(s.paper_a);
    expect(after.slice(0, 2).map((r) => r.metadata)).toEqual([{ embed_model: TARGET }, { embed_model: TARGET }]);
    expect(await embeddingIs(after[0]!.id, fakeFor(before[0]!))).toBe(true);
    expect(await embeddingIs(after[1]!.id, fakeFor(before[1]!))).toBe(true);
    expect(after.slice(2).map((r) => r.metadata)).toEqual([{}, {}, {}]);
    expect(after.slice(2).every((r) => r.old)).toBe(true);

    const rerun = await reembedUserChunks(sql, providers, fakeProviders().deps, { userId: s.user_a, batchSize: 2 });
    expect(rerun).toEqual({ target: TARGET, updated: 3, remaining: 0 });
    const done = await chunks(s.paper_a);
    for (const [i, r] of done.entries()) {
      expect(r.metadata).toEqual({ embed_model: TARGET });
      expect(await embeddingIs(r.id, fakeFor(before[i]!))).toBe(true);
    }
  });

  it('stops before the first batch when the signal is already aborted', async () => {
    await addChunk(s.paper_a, s.user_a, 0);
    const ac = new AbortController();
    ac.abort();
    const { deps, calls } = fakeProviders();

    await expect(
      reembedUserChunks(sql, providers, deps, { userId: s.user_a, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
    expect((await chunks(s.paper_a))[0]!.metadata).toEqual({});
  });

  it('tags a chunk whose metadata is NULL', async () => {
    await addChunk(s.paper_a, s.user_a, 0, { metadata: null });

    expect(await reembedUserChunks(sql, providers, fakeProviders().deps, { userId: s.user_a })).toEqual({
      target: TARGET,
      updated: 1,
      remaining: 0,
    });
    expect((await chunks(s.paper_a))[0]!.metadata).toEqual({ embed_model: TARGET });

    const { deps, calls } = fakeProviders();
    expect(await reembedUserChunks(sql, providers, deps, { userId: s.user_a })).toMatchObject({ updated: 0 });
    expect(calls).toHaveLength(0);
  });

  it('leaves a chunk whose metadata is not an object and reports it as remaining', async () => {
    // `[] || {"embed_model": …}` is an array, which `->> 'embed_model'` never matches: tagging it would loop forever.
    await addChunk(s.paper_a, s.user_a, 0, { metadata: [] });
    await addChunk(s.paper_a, s.user_a, 1, { metadata: 'legacy' });
    await addChunk(s.paper_a, s.user_a, 2);
    const { deps, calls } = fakeProviders();

    expect(await reembedUserChunks(sql, providers, deps, { userId: s.user_a, batchSize: 1 })).toEqual({
      target: TARGET,
      updated: 1,
      remaining: 2,
    });
    const rows = await chunks(s.paper_a);
    expect(embedInputs(calls)).toEqual([rows[2]!.content]);
    expect(rows.map((r) => r.metadata)).toEqual([[], 'legacy', { embed_model: TARGET }]);
    expect(rows[0]!.old && rows[1]!.old).toBe(true);
  });

  // Review Focus 3.
  it('an embedding failure mid-run keeps committed batches', async () => {
    for (let i = 0; i < 5; i++) await addChunk(s.paper_a, s.user_a, i);
    const before = await chunks(s.paper_a);
    // A 4xx is not retried.
    const deps = withHook(fakeProviders().deps, (n) =>
      n === 2 ? new Response('{"error":"bad"}', { status: 400 }) : undefined,
    );

    await expect(reembedUserChunks(sql, providers, deps, { userId: s.user_a, batchSize: 2 })).rejects.toThrow();

    const after = await chunks(s.paper_a);
    expect(after.slice(0, 2).map((r) => r.metadata)).toEqual([{ embed_model: TARGET }, { embed_model: TARGET }]);
    expect(await embeddingIs(after[0]!.id, fakeFor(before[0]!))).toBe(true);
    expect(await embeddingIs(after[1]!.id, fakeFor(before[1]!))).toBe(true);
    expect(after.slice(2).map((r) => r.metadata)).toEqual([{}, {}, {}]);
    expect(after.slice(2).every((r) => r.old)).toBe(true);
  });

  it('an unavailable provider stops before writing', async () => {
    await addChunk(s.paper_a, s.user_a, 0);
    await addChunk(s.paper_a, s.user_a, 1, { metadata: null });
    const noKey: ProviderConfig = { ...providers, embed: { ...providers.embed, provider: 'openai', openaiKey: '' } };
    const { deps, calls } = fakeProviders();

    await expect(reembedUserChunks(sql, noKey, deps, { userId: s.user_a })).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
    expect(calls).toHaveLength(0);
    const rows = await chunks(s.paper_a);
    expect(rows.map((r) => r.metadata)).toEqual([{}, null]);
    expect(rows.every((r) => r.old)).toBe(true);
  });

  it('a batch that tags no row throws instead of looping', async () => {
    await addChunk(s.paper_a, s.user_a, 0);
    await addChunk(s.paper_a, s.user_a, 1);
    // Another writer tags the selected rows while the batch is being embedded.
    const deps = withHook(fakeProviders().deps, async (n) => {
      if (n === 1) {
        await sql`UPDATE chunks SET metadata = jsonb_build_object('embed_model', ${TARGET}::text)
                  WHERE paper_id = ${s.paper_a}`;
      }
    });

    await expect(reembedUserChunks(sql, providers, deps, { userId: s.user_a })).rejects.toThrow(
      'reembed made no progress on 2 chunks',
    );
    expect((await chunks(s.paper_a)).every((r) => r.old)).toBe(true);
  });

  it('ignores a chunk whose paper id is gone (another writer deleted the paper)', async () => {
    const other = randomUUID();
    await sql`INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
              VALUES (${other}, ${s.user_a}, ${s.workspace_a}, 'c.pdf', '/tmp/c.pdf', 'complete')`;
    await addChunk(s.paper_a, s.user_a, 0);
    await addChunk(other, s.user_a, 0);
    const deps = withHook(fakeProviders().deps, async (n) => {
      if (n === 1) await sql`DELETE FROM papers WHERE id = ${other}`;
    });

    expect(await reembedUserChunks(sql, providers, deps, { userId: s.user_a })).toEqual({
      target: TARGET,
      updated: 1,
      remaining: 0,
    });
  });
});

describe('embedModelCounts', () => {
  it('counts chunks per embed_model', async () => {
    await addChunk(s.paper_a, s.user_a, 0);
    await addChunk(s.paper_a, s.user_a, 1, { metadata: null });
    await addChunk(s.paper_a, s.user_a, 2, { metadata: { embed_model: TARGET } });
    await addChunk(s.paper_b, s.user_b, 0, { metadata: { embed_model: 'ollama:other@1024' } });

    expect(await embedModelCounts(sql, s.user_a)).toEqual({ '(none)': 2, [TARGET]: 1 });
    expect(await embedModelCounts(sql, s.user_b)).toEqual({ 'ollama:other@1024': 1 });
  });

  it('is empty for a user without chunks', async () => {
    expect(await embedModelCounts(sql, s.user_a)).toEqual({});
  });
});
