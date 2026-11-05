import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import {
  countEmbedModelMismatch,
  retrievalQueries,
  retrieveChunks,
  retrieveForPersona,
  type RetrievalCtx,
} from '../../src/feed/retrieval.js';
import type { Chunk, Persona, Personas } from '../../src/feed/types.js';
import { providerConfig, type ProviderConfig } from '../../src/providers/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';
import { embedModelId } from '../../src/providers/embed.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';

const sql = testSql();
let s: Seeded;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
});

const DIM = 1024;
/** Unit vector on one axis: cosine distances between axes are exactly 0 or 1. */
const axis = (i: number): number[] => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));
/** Unit vector whose cosine with axis(0) is `c`. */
const cosToAxis0 = (c: number) => {
  const v = axis(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
};
const Q = axis(0);

const baseConfig = (env: Record<string, string> = {}): Config =>
  loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434', ...env });

type Call = { url: string; body: any };
function fakeDeps(handler: (call: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const deps: ProviderDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), body: JSON.parse(String(init?.body ?? 'null')) };
      calls.push(call);
      return new Response(JSON.stringify(handler(call)), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected anthropic');
    },
    sleep: async () => {},
  };
  return { deps, calls };
}
const mkLogger = () => ({ info: vi.fn(), warn: vi.fn() }) as any;

function mkCtx(
  o: { env?: Record<string, string>; providers?: (p: ProviderConfig) => ProviderConfig; handler?: (c: Call) => unknown } = {},
) {
  const config = baseConfig(o.env);
  const base = providerConfig({}, {}, config);
  const providers = o.providers ? o.providers(base) : base;
  const { deps, calls } = fakeDeps(o.handler);
  const ctx: RetrievalCtx = { sql, config, providers, deps, logger: mkLogger() };
  return { ctx, calls, model: embedModelId(providers) };
}
const withVoyageRerank = (p: ProviderConfig): ProviderConfig => ({
  ...p,
  rerank: { ...p.rerank, provider: 'voyage', voyageKey: 'vk', voyageModel: 'rerank-2-lite' },
});
const isRerank = (c: Call) => c.url === 'https://api.voyageai.com/v1/rerank';
const isEmbed = (c: Call) => c.url === 'https://api.voyageai.com/v1/embeddings';

async function seedPaper(userId: string, title: string | null, authors: string[] | null = ['Ada Lovelace']): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, title, authors, year, filename, file_path, status)
    VALUES (${id}, ${userId}, ${title}, ${authors}, 2024, ${`${id}.pdf`}, ${`/papers/${id}.pdf`}, 'complete')`;
  return id;
}

let chunkIndex = 0;
async function seedChunk(
  paperId: string,
  content: string,
  vec: number[],
  metadata: Record<string, unknown>,
  userId = s.user_a,
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO chunks (id, paper_id, user_id, section, content, chunk_index, token_count, embedding, metadata)
    VALUES (${id}, ${paperId}, ${userId}, 'results', ${content}, ${chunkIndex++}, 7,
            ${`[${vec.join(',')}]`}::vector, ${sql.json(metadata as never)}::jsonb)`;
  return id;
}

/** The hybrid score written directly in SQL with numeric literals, as Python's f-string interpolation produces. */
async function directScore(id: string, query: string, q: number[]): Promise<number> {
  const [row] = await sql`
    SELECT (1 - (c.embedding <=> ${`[${q.join(',')}]`}::vector)) * 0.7 +
           COALESCE(ts_rank(c.search_vector, plainto_tsquery('english', ${query})), 0) * 0.3 AS score
    FROM chunks c WHERE c.id = ${id}`;
  return Number(row!.score);
}

const ids = (cs: Chunk[]) => cs.map((c) => c.id);

describe('retrieveChunks', () => {
  it('labels vector, keyword and hybrid matches and scores them exactly as the numeric-literal SQL does', async () => {
    const { ctx, model } = mkCtx();
    const paper = await seedPaper(s.user_a, 'Leaf Paper');
    const v = await seedChunk(paper, 'Gardens need patient tending.', axis(0), { embed_model: model });
    const k = await seedChunk(paper, 'Photosynthesis converts light into sugar.', axis(1), { embed_model: model });
    const h = await seedChunk(paper, 'Photosynthesis rates rise with photosynthesis enzymes.', cosToAxis0(0.9), {
      embed_model: model,
    });
    const far = await seedChunk(paper, 'Nothing relevant at all.', axis(2), { embed_model: model });

    const out = await retrieveChunks(ctx, { query: 'photosynthesis', queryEmbedding: Q });
    const byId = new Map(out.map((c) => [c.id, c]));
    expect(byId.get(v)!.match_type).toBe('vector');
    expect(byId.get(k)!.match_type).toBe('keyword');
    expect(byId.get(h)!.match_type).toBe('hybrid');
    expect(byId.get(far)!.match_type).toBe('vector');

    for (const id of [v, k, h, far]) expect(byId.get(id)!.score).toBe(await directScore(id, 'photosynthesis', Q));
    expect(byId.get(v)!.score).toBe(0.7);
    expect(byId.get(far)!.score).toBe(0);
    // ts_rank is real; real * numeric resolves to float8 * float8. An untyped weight bind would resolve to
    // real * real and leave a float4-rounded keyword term, which this catches.
    const kScore = byId.get(k)!.score;
    expect(kScore).toBeGreaterThan(0);
    expect(Math.fround(kScore)).not.toBe(kScore);

    // Ordered by score DESC; the full row maps onto Chunk.
    const scores = out.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(byId.get(h)).toEqual({
      id: h,
      paper_id: paper,
      section: 'results',
      content: 'Photosynthesis rates rise with photosynthesis enzymes.',
      chunk_type: 'text',
      chunk_index: expect.any(Number),
      token_count: 7,
      paper_title: 'Leaf Paper',
      paper_authors: ['Ada Lovelace'],
      paper_year: 2024,
      paper_filename: `${paper}.pdf`,
      score: await directScore(h, 'photosynthesis', Q),
      match_type: 'hybrid',
    });
  });

  it('paper_authors NULL maps to []; topK limits the SQL rows when rerank is none', async () => {
    const { ctx, model, calls } = mkCtx();
    const paper = await seedPaper(s.user_a, null, null);
    for (let i = 0; i < 6; i++) await seedChunk(paper, `filler ${i}`, axis(i), { embed_model: model });
    const out = await retrieveChunks(ctx, { query: 'filler', queryEmbedding: Q, topK: 4 });
    expect(out).toHaveLength(4);
    expect(out.every((c) => Array.isArray(c.paper_authors) && c.paper_authors.length === 0)).toBe(true);
    expect(out[0]!.paper_title).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('paperIds scoping drops other papers from both stages; no paperIds means every paper', async () => {
    const { ctx, model } = mkCtx();
    const pa = await seedPaper(s.user_a, 'A');
    const pb = await seedPaper(s.user_b, 'B');
    const a1 = await seedChunk(pa, 'Mitochondria matter.', axis(1), { embed_model: model });
    const b1 = await seedChunk(pb, 'Unrelated vector twin.', axis(0), { embed_model: model }, s.user_b);
    const b2 = await seedChunk(pb, 'Mitochondria keyword twin.', axis(3), { embed_model: model }, s.user_b);

    const scoped = await retrieveChunks(ctx, { query: 'mitochondria', paperIds: [pa], queryEmbedding: Q });
    expect(ids(scoped)).toEqual([a1]);

    const all = await retrieveChunks(ctx, { query: 'mitochondria', queryEmbedding: Q });
    expect(new Set(ids(all))).toEqual(new Set([a1, b1, b2]));

    const empty = await retrieveChunks(ctx, { query: 'mitochondria', paperIds: [], queryEmbedding: Q });
    expect(new Set(ids(empty))).toEqual(new Set([a1, b1, b2]));
  });

  it('excludeChunkIds removes a chunk that is both the nearest vector and a keyword hit', async () => {
    const { ctx, model } = mkCtx();
    const pa = await seedPaper(s.user_a, 'A');
    const both = await seedChunk(pa, 'Ribosomes translate ribosomes.', axis(0), { embed_model: model });
    const kw = await seedChunk(pa, 'Ribosomes again.', axis(5), { embed_model: model });
    const vec = await seedChunk(pa, 'Close but silent.', cosToAxis0(0.8), { embed_model: model });

    const before = await retrieveChunks(ctx, { query: 'ribosomes', queryEmbedding: Q });
    expect(ids(before)).toContain(both);

    const out = await retrieveChunks(ctx, { query: 'ribosomes', queryEmbedding: Q, excludeChunkIds: [both] });
    expect(new Set(ids(out))).toEqual(new Set([kw, vec]));

    const none = await retrieveChunks(ctx, { query: 'ribosomes', queryEmbedding: Q, excludeChunkIds: [] });
    expect(ids(none)).toContain(both);
  });

  it('never returns chunks from another embed model or with no embed_model, even as the best match (pool 2)', async () => {
    const { ctx, model } = mkCtx({ env: { RETRIEVAL_CANDIDATE_POOL: '2' } });
    const pa = await seedPaper(s.user_a, 'A');
    const pb = await seedPaper(s.user_b, 'B');
    const other = await seedChunk(pa, 'Enzymes enzymes enzymes.', axis(0), { embed_model: 'ollama:other@1024' });
    const bare = await seedChunk(pa, 'Enzymes enzymes enzymes!', axis(0), {});
    const good1 = await seedChunk(pa, 'Close to the query.', cosToAxis0(0.6), { embed_model: model });
    const good2 = await seedChunk(pa, 'Enzymes once.', axis(4), { embed_model: model });
    await seedChunk(pb, 'Enzymes elsewhere.', axis(0), { embed_model: 'ollama:other@1024' }, s.user_b);

    for (const paperIds of [[pa], undefined]) {
      const out = await retrieveChunks(ctx, { query: 'enzymes', paperIds, queryEmbedding: Q });
      expect(ids(out)).not.toContain(other);
      expect(ids(out)).not.toContain(bare);
      expect(ids(out)).toEqual(expect.arrayContaining([good1, good2]));
    }

    expect(await countEmbedModelMismatch(sql, [pa], model)).toBe(2);
    expect(await countEmbedModelMismatch(sql, [pa, pb], model)).toBe(3);
    expect(await countEmbedModelMismatch(sql, [pa], 'ollama:other@1024')).toBe(3);
  });

  it('voyage rerank: SQL widens to min(candidatePool, topK * 5), then output is reranked and sliced to topK', async () => {
    const scoreOf = (doc: string) => Number(doc.split(' ')[1]); // "chunk N" -> N: reverses the SQL order
    const handler = (c: Call) => ({
      data: (c.body.documents as string[]).map((d, index) => ({ index, relevance_score: scoreOf(d) })),
    });
    const { ctx, model, calls } = mkCtx({ providers: withVoyageRerank, handler });
    const pa = await seedPaper(s.user_a, 'A');
    // chunk i has cosine 1 - i/100 with the query, so SQL order is chunk 0, 1, 2, ...
    for (let i = 0; i < 20; i++) await seedChunk(pa, `chunk ${i}`, cosToAxis0(1 - i / 100), { embed_model: model });

    const out = await retrieveChunks(ctx, { query: 'q', queryEmbedding: Q, topK: 3 });
    const rr = calls.filter(isRerank);
    expect(rr).toHaveLength(1);
    expect(rr[0]!.body.documents).toEqual(Array.from({ length: 15 }, (_, i) => `chunk ${i}`));
    expect(out.map((c) => c.content)).toEqual(['chunk 14', 'chunk 13', 'chunk 12']);
    expect(out.map((c) => c.rerank_score)).toEqual([14, 13, 12]);

    const pooled = mkCtx({ providers: withVoyageRerank, handler, env: { RETRIEVAL_CANDIDATE_POOL: '10' } });
    await retrieveChunks(pooled.ctx, { query: 'chunk', queryEmbedding: Q, topK: 3 });
    expect(pooled.calls.filter(isRerank)[0]!.body.documents).toHaveLength(10);
  });

  it('computes a missing query embedding with exactly one query-type embed call; a given one makes none', async () => {
    const handler = (c: Call) => (isEmbed(c) ? { data: [{ index: 0, embedding: axis(7) }] } : {});
    const voyageEmbed = (p: ProviderConfig): ProviderConfig => ({
      ...p,
      embed: { ...p.embed, provider: 'voyage', voyageKey: 'ek', voyageModel: 'voyage-3' },
    });
    const { ctx, model, calls } = mkCtx({ providers: voyageEmbed, handler });
    expect(model).toBe('voyage:voyage-3@1024');
    const pa = await seedPaper(s.user_a, 'A');
    const near = await seedChunk(pa, 'Axis seven.', axis(7), { embed_model: model });
    await seedChunk(pa, 'Axis zero.', axis(0), { embed_model: model });

    const out = await retrieveChunks(ctx, { query: 'what is near', topK: 1 });
    expect(ids(out)).toEqual([near]);
    expect(calls).toHaveLength(1);
    expect(isEmbed(calls[0]!)).toBe(true);
    expect(calls[0]!.body).toMatchObject({ input: ['what is near'], input_type: 'query' });

    await retrieveChunks(ctx, { query: 'what is near', queryEmbedding: Q, topK: 1 });
    expect(calls).toHaveLength(1);
  });
});

const persona = (key: string, retrieval_query: string | null): Persona => ({
  key,
  handle: `@${key}`,
  name: key,
  initials: key.slice(0, 2).toUpperCase(),
  color: '#000',
  system_prompt: '',
  temperature: null,
  retrieval_query,
  allowed_figure_types: null,
  feed_eligible: true,
});

describe('retrievalQueries', () => {
  it('maps every persona to its retrieval_query, falling back for null and empty', () => {
    const personas: Personas = new Map([
      ['skeptic', persona('skeptic', 'limitations and confounds')],
      ['hype', persona('hype', null)],
      ['quiet', persona('quiet', '')],
    ]);
    expect([...retrievalQueries(personas)]).toEqual([
      ['skeptic', 'limitations and confounds'],
      ['hype', 'key findings and methodology'],
      ['quiet', 'key findings and methodology'],
    ]);
  });
});

describe('retrieveForPersona', () => {
  const personas: Personas = new Map([['skeptic', persona('skeptic', 'limitations')]]);

  /** A1 .7, A2 .63, A3 .595 on paper A; L .574 on the liked paper (boosted: .7175). */
  async function seedBoostCase(model: string) {
    const pa = await seedPaper(s.user_a, 'Other Paper');
    const pl = await seedPaper(s.user_a, 'Liked Title ');
    const a1 = await seedChunk(pa, 'a one', cosToAxis0(1), { embed_model: model });
    const a2 = await seedChunk(pa, 'a two', cosToAxis0(0.9), { embed_model: model });
    const a3 = await seedChunk(pa, 'a three', cosToAxis0(0.85), { embed_model: model });
    const l = await seedChunk(pl, 'liked one', cosToAxis0(0.82), { embed_model: model });
    return { a1, a2, a3, l };
  }

  it('uses the persona query, fetches topK * 2 with liked titles, and topK without', async () => {
    const handler = (c: Call) => ({
      data: (c.body.documents as string[]).map((_d, index) => ({ index, relevance_score: -index })),
    });
    const { ctx, model, calls } = mkCtx({ providers: withVoyageRerank, handler });
    const pa = await seedPaper(s.user_a, 'A');
    for (let i = 0; i < 25; i++) await seedChunk(pa, `chunk ${i}`, cosToAxis0(1 - i / 100), { embed_model: model });

    const liked = await retrieveForPersona(ctx, personas, {
      personaKey: 'skeptic',
      topK: 2,
      likedPaperTitles: ['Nope'],
      queryEmbedding: Q,
    });
    expect(liked).toHaveLength(2);
    expect(calls.filter(isRerank)[0]!.body.documents).toHaveLength(20); // min(100, (2 * 2) * 5)
    expect(calls.filter(isRerank)[0]!.body.query).toBe('limitations');

    await retrieveForPersona(ctx, personas, { personaKey: 'skeptic', topK: 2, queryEmbedding: Q });
    expect(calls.filter(isRerank)[1]!.body.documents).toHaveLength(10); // min(100, 2 * 5)

    await retrieveForPersona(ctx, personas, { personaKey: 'nobody', topK: 2, likedPaperTitles: [], queryEmbedding: Q });
    expect(calls.filter(isRerank)[2]!.body.query).toBe('key findings and methodology');
    expect(calls.filter(isRerank)[2]!.body.documents).toHaveLength(10);
  });

  it('boosts chunks of liked papers by 1.25 (title stripped, case-insensitive) and re-sorts by score', async () => {
    const { ctx, model } = mkCtx();
    const { a1, a2, l } = await seedBoostCase(model);

    const plain = await retrieveForPersona(ctx, personas, { personaKey: 'skeptic', topK: 2, queryEmbedding: Q });
    expect(ids(plain)).toEqual([a1, a2]);
    expect(plain.some((c) => c.boosted)).toBe(false);

    const out = await retrieveForPersona(ctx, personas, {
      personaKey: 'skeptic',
      topK: 2,
      likedPaperTitles: ['', '  liked TITLE  '],
      queryEmbedding: Q,
    });
    expect(ids(out)).toEqual([l, a1]);
    expect(out[0]!.boosted).toBe(true);
    expect(out[1]!.boosted).toBeUndefined();
    const [raw] = await sql`
      SELECT (1 - (embedding <=> ${`[${Q.join(',')}]`}::vector)) * 0.7 +
             COALESCE(ts_rank(search_vector, plainto_tsquery('english', 'limitations')), 0) * 0.3 AS s
      FROM chunks WHERE id = ${l}`;
    expect(out[0]!.score).toBe(Number(raw!.s) * 1.25);
  });

  it('re-sorts by the boosted score even when rerank put the boosted chunk last', async () => {
    const rerankScores: Record<string, number> = { 'a one': 0.9, 'a two': 0.8, 'a three': 0.7, 'liked one': 0.1 };
    const handler = (c: Call) => ({
      data: (c.body.documents as string[]).map((d, index) => ({ index, relevance_score: rerankScores[d] })),
    });
    const { ctx, model, calls } = mkCtx({ providers: withVoyageRerank, handler });
    const { a1, l } = await seedBoostCase(model);

    const out = await retrieveForPersona(ctx, personas, {
      personaKey: 'skeptic',
      topK: 2,
      likedPaperTitles: ['Liked Title'],
      queryEmbedding: Q,
    });
    expect(calls.filter(isRerank)[0]!.body.documents).toHaveLength(4);
    expect(ids(out)).toEqual([l, a1]);
    expect(out.map((c) => c.rerank_score)).toEqual([0.1, 0.9]);
  });
});
