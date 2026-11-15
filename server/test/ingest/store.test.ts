import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtractedFigure } from '../../src/ingest/figures.js';
import { chunkEmbedText } from '../../src/ingest/embedText.js';
import { EMBED_STORE_BATCH, embedAndStoreChunks, storeChunks, storeFigure } from '../../src/ingest/store.js';
import { resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';

const sql = testSql();
let s: Seeded;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
});

const vec = (seed: number) => Array.from({ length: 1024 }, (_, i) => ((i + seed) % 7) / 10 - 0.3);

const chunk = (i: number, content: string, prefix = '') => ({
  section: i === 0 ? 'abstract' : 'body',
  content,
  chunk_index: i,
  token_count: 3 + i,
  contextual_prefix: prefix,
});

describe('storeChunks', () => {
  it('inserts every chunk with its vector, owner, embed model, NULL for an empty prefix and a trigger-filled search_vector', async () => {
    const n = await storeChunks(
      sql,
      s.paper_a,
      s.user_a,
      [chunk(0, 'Reading groups cluster attention.', 'Situating sentence.'), chunk(1, 'Quiet members write notes.')],
      [vec(0), vec(1)],
      'ollama:qwen3-embedding:latest@1024',
    );
    expect(n).toBe(2);
    const rows = await sql`
      SELECT section, content, chunk_type, chunk_index, token_count, user_id::text AS user_id, contextual_prefix,
             metadata, embedding::text AS emb, search_vector IS NOT NULL AS has_sv
      FROM chunks WHERE paper_id = ${s.paper_a} ORDER BY chunk_index`;
    expect(rows.map((r) => [r.section, r.content, r.chunk_type, r.chunk_index, r.token_count, r.user_id])).toEqual([
      ['abstract', 'Reading groups cluster attention.', 'text', 0, 3, s.user_a],
      ['body', 'Quiet members write notes.', 'text', 1, 4, s.user_a],
    ]);
    expect(rows.map((r) => r.contextual_prefix)).toEqual(['Situating sentence.', null]);
    expect(rows.every((r) => r.has_sv)).toBe(true);
    expect(rows[0]!.metadata).toEqual({ embed_model: 'ollama:qwen3-embedding:latest@1024' });
    const stored = JSON.parse(String(rows[1]!.emb)) as number[];
    expect(stored).toHaveLength(1024);
    stored.forEach((x, i) => expect(x).toBeCloseTo(vec(1)[i]!, 6));
  });

  it('a re-run replaces the paper’s chunks (no rows left from a longer earlier run) and leaves other papers alone', async () => {
    await storeChunks(sql, s.paper_b, s.user_b, [chunk(0, 'b')], [vec(9)], 'm');
    await storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'a0'), chunk(1, 'a1'), chunk(2, 'a2')], [vec(0), vec(1), vec(2)], 'm');
    const n = await storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'new0')], [vec(3)], 'm2');
    expect(n).toBe(1);
    const rows = await sql`SELECT paper_id::text AS p, content, metadata->>'embed_model' AS m FROM chunks ORDER BY content`;
    expect(rows.map((r) => [r.p, r.content, r.m])).toEqual([
      [s.paper_b, 'b', 'm'],
      [s.paper_a, 'new0', 'm2'],
    ]);
  });

  it('no chunks: returns 0 and touches nothing (Python returns before the DELETE)', async () => {
    await storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'kept')], [vec(0)], 'm');
    expect(await storeChunks(sql, s.paper_a, s.user_a, [], [], 'm')).toBe(0);
    const [r] = await sql`SELECT count(*)::int AS n FROM chunks WHERE paper_id = ${s.paper_a}`;
    expect(r!.n).toBe(1);
  });

  it('a chunk/vector count mismatch throws and the old rows survive (one transaction)', async () => {
    await storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'kept')], [vec(0)], 'm');
    await expect(storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'x'), chunk(1, 'y')], [vec(0)], 'm')).rejects.toThrow(
      /2 chunks but 1 embeddings/,
    );
    await expect(storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'x')], [vec(0).slice(1)], 'm')).rejects.toThrow();
    const rows = await sql`SELECT content FROM chunks WHERE paper_id = ${s.paper_a}`;
    expect(rows.map((r) => r.content)).toEqual(['kept']);
  });
});

// Security review: a paper's vectors and their pgvector text were all held at once, so a paper of many chunks could
// exhaust the worker's heap. Chunks are embedded and written batch by batch instead.
describe('embedAndStoreChunks', () => {
  const MODEL = 'ollama:qwen3-embedding:latest@1024';
  const five = () => [0, 1, 2, 3, 4].map((i) => chunk(i, `Chunk ${i} text.`, i % 2 ? '' : `Prefix ${i}.`));
  const ROWS = (paperId: string) => sql`
    SELECT section, content, chunk_type, chunk_index, token_count, user_id::text AS user_id, contextual_prefix,
           metadata, embedding::text AS emb
    FROM chunks WHERE paper_id = ${paperId} ORDER BY chunk_index`;
  const count = async (paperId: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM chunks WHERE paper_id = ${paperId}`)[0]!.n);

  it('uses a batch of a few hundred chunks by default, so a real paper is one batch', () => {
    expect(EMBED_STORE_BATCH).toBe(256);
  });

  it('embeds and writes batch by batch (each written before the next is embedded) and stores what storeChunks stores', async () => {
    const chunks = five();
    const seen: Array<{ texts: string[]; storedBefore: number }> = [];
    const n = await embedAndStoreChunks(sql, {
      paperId: s.paper_a,
      userId: s.user_a,
      chunks,
      embedModel: MODEL,
      batchSize: 2,
      embed: async (texts) => {
        seen.push({ texts, storedBefore: await count(s.paper_a) });
        return texts.map((t) => vec(t.length));
      },
    });
    expect(n).toBe(5);
    expect(seen.map((c) => c.texts.length)).toEqual([2, 2, 1]);
    expect(seen.map((c) => c.storedBefore)).toEqual([0, 2, 4]);
    expect(seen.flatMap((c) => c.texts)).toEqual(chunks.map((c) => chunkEmbedText(c)));

    // The same chunks and vectors through the one-shot storeChunks, for another paper: identical rows.
    const texts = chunks.map((c) => chunkEmbedText(c));
    await storeChunks(sql, s.paper_b, s.user_a, chunks, texts.map((t) => vec(t.length)), MODEL);
    expect(await ROWS(s.paper_a)).toEqual(await ROWS(s.paper_b));
  });

  it('replaces the rows of an earlier, longer run', async () => {
    const old = [0, 1, 2, 3, 4, 5, 6].map((i) => chunk(i, `old ${i}`));
    await storeChunks(sql, s.paper_a, s.user_a, old, old.map((_, i) => vec(i)), 'm');
    await embedAndStoreChunks(sql, {
      paperId: s.paper_a,
      userId: s.user_a,
      chunks: five(),
      embedModel: MODEL,
      batchSize: 2,
      embed: async (texts) => texts.map(() => vec(1)),
    });
    const rows = await ROWS(s.paper_a);
    expect(rows.map((r) => r.content)).toEqual(five().map((c) => c.content));
    expect(new Set(rows.map((r) => (r.metadata as { embed_model: string }).embed_model))).toEqual(new Set([MODEL]));
  });

  it('a failure in a middle batch removes the batches already written and rethrows', async () => {
    const old = [chunk(0, 'old 0')];
    await storeChunks(sql, s.paper_a, s.user_a, old, [vec(0)], 'm');
    await storeChunks(sql, s.paper_b, s.user_b, old, [vec(0)], 'm');
    const boom = new Error('embedding backend failed');
    let calls = 0;
    await expect(
      embedAndStoreChunks(sql, {
        paperId: s.paper_a,
        userId: s.user_a,
        chunks: five(),
        embedModel: MODEL,
        batchSize: 2,
        embed: async (texts) => {
          calls++;
          if (calls === 2) throw boom;
          return texts.map(() => vec(1));
        },
      }),
    ).rejects.toBe(boom);
    expect(calls).toBe(2);
    expect(await count(s.paper_a)).toBe(0);
    expect(await count(s.paper_b)).toBe(1); // another paper is untouched
  });

  it('a failure in the first batch writes nothing and leaves the earlier rows (as the one-shot store did)', async () => {
    await storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'kept')], [vec(0)], 'm');
    await expect(
      embedAndStoreChunks(sql, {
        paperId: s.paper_a,
        userId: s.user_a,
        chunks: five(),
        embedModel: MODEL,
        batchSize: 2,
        embed: async () => {
          throw new Error('down');
        },
      }),
    ).rejects.toThrow('down');
    expect((await ROWS(s.paper_a)).map((r) => r.content)).toEqual(['kept']);
  });

  it('a vector count mismatch in a later batch fails and leaves no partial set', async () => {
    let calls = 0;
    await expect(
      embedAndStoreChunks(sql, {
        paperId: s.paper_a,
        userId: s.user_a,
        chunks: five(),
        embedModel: MODEL,
        batchSize: 2,
        embed: async (texts) => (++calls === 2 ? [vec(1)] : texts.map(() => vec(1))),
      }),
    ).rejects.toThrow(/2 chunks but 1 embeddings/);
    expect(await count(s.paper_a)).toBe(0);
  });

  it('an abort between batches stops before the next batch, removes the partial set and rejects with the reason', async () => {
    const ac = new AbortController();
    const reason = new Error('job aborted');
    let calls = 0;
    await expect(
      embedAndStoreChunks(sql, {
        paperId: s.paper_a,
        userId: s.user_a,
        chunks: five(),
        embedModel: MODEL,
        batchSize: 2,
        signal: ac.signal,
        embed: async (texts) => {
          if (++calls === 2) ac.abort(reason); // an embed call does not always reject on abort
          return texts.map(() => vec(1));
        },
      }),
    ).rejects.toBe(reason);
    expect(calls).toBe(2);
    expect(await count(s.paper_a)).toBe(0);
  });

  it('no chunks: returns 0 without embedding or touching the table', async () => {
    await storeChunks(sql, s.paper_a, s.user_a, [chunk(0, 'kept')], [vec(0)], 'm');
    let calls = 0;
    const n = await embedAndStoreChunks(sql, {
      paperId: s.paper_a,
      userId: s.user_a,
      chunks: [],
      embedModel: MODEL,
      embed: async () => {
        calls++;
        return [];
      },
    });
    expect([n, calls, await count(s.paper_a)]).toEqual([0, 0, 1]);
  });

  it('rejects a batch size below 1', async () => {
    await expect(
      embedAndStoreChunks(sql, {
        paperId: s.paper_a,
        userId: s.user_a,
        chunks: five(),
        embedModel: MODEL,
        batchSize: 0,
        embed: async () => [],
      }),
    ).rejects.toThrow('batchSize must be at least 1');
  });
});

const fig = (over: Partial<ExtractedFigure> = {}): ExtractedFigure => ({
  page: 2,
  filename: 'fig_p2_0.png',
  image_bytes: new Uint8Array([1]),
  extraction_type: 'vlm_detected',
  width: 10,
  height: 20,
  figure_index: 0,
  figure_type: 'chart_line',
  caption: 'Fig. 1. Share of turns.',
  figure_number: '1',
  data_claim: 'Attention clusters on dense paragraphs. Quiet members return to them.',
  referenced_paragraph: 'As Fig. 1 shows...',
  bbox: { page: 2, x0: 0.1, y0: 0.5, x1: 0.6, y1: 0.8 },
  detector_confidence: 0.75,
  ...over,
});

async function figureRow(index = 0) {
  const [r] = await sql`
    SELECT page_number, image_path, extraction_type, description, claim_summary, figure_index, figure_type, caption,
           figure_number, data_claim, referenced_paragraph, bbox, detector_confidence, processed_at IS NOT NULL AS done
    FROM figures WHERE paper_id = ${s.paper_a} AND figure_index = ${index}`;
  return r!;
}

describe('storeFigure', () => {
  it('stores the typed columns and derives the legacy description and claim_summary from data_claim', async () => {
    await storeFigure(sql, s.paper_a, fig(), '/figs/a/fig_p2_0.png');
    expect(await figureRow()).toEqual({
      page_number: 2,
      image_path: '/figs/a/fig_p2_0.png',
      extraction_type: 'vlm_detected',
      description: 'Attention clusters on dense paragraphs. Quiet members return to them.',
      claim_summary: 'Attention clusters on dense paragraphs',
      figure_index: 0,
      figure_type: 'chart_line',
      caption: 'Fig. 1. Share of turns.',
      figure_number: '1',
      data_claim: 'Attention clusters on dense paragraphs. Quiet members return to them.',
      referenced_paragraph: 'As Fig. 1 shows...',
      bbox: { page: 2, x0: 0.1, y0: 0.5, x1: 0.6, y1: 0.8 },
      detector_confidence: 0.75,
      done: true,
    });
  });

  it('no data_claim: description and claim_summary fall back to the caption (capped at 400 code points); empty fields become NULL', async () => {
    const caption = '😀'.repeat(450);
    await storeFigure(
      sql,
      s.paper_a,
      fig({ data_claim: '', caption, figure_type: '', figure_number: '', referenced_paragraph: '' }),
      'p',
    );
    const r = await figureRow();
    expect(r.description).toBe(caption);
    expect(r.claim_summary).toBe('😀'.repeat(400));
    expect([r.figure_type, r.figure_number, r.data_claim, r.referenced_paragraph]).toEqual([null, null, null, null]);
  });

  it('caps a long first sentence at 400 and keeps description empty-string when both texts are empty', async () => {
    await storeFigure(sql, s.paper_a, fig({ data_claim: `  ${'x'.repeat(500)}. tail` }), 'p');
    expect((await figureRow()).claim_summary).toBe('x'.repeat(400));
    await storeFigure(sql, s.paper_a, fig({ figure_index: 1, data_claim: '', caption: '' }), 'p');
    const r = await figureRow(1);
    expect([r.description, r.claim_summary, r.caption, r.data_claim]).toEqual(['', '', null, null]);
  });

  it('upserts on (paper_id, figure_index), so a retry does not duplicate rows', async () => {
    await storeFigure(sql, s.paper_a, fig(), 'old');
    await storeFigure(sql, s.paper_a, fig({ caption: 'New caption', data_claim: '' }), 'new');
    const rows = await sql`SELECT image_path, caption, description FROM figures WHERE paper_id = ${s.paper_a}`;
    expect(rows.map((r) => [r.image_path, r.caption, r.description])).toEqual([['new', 'New caption', 'New caption']]);
  });
});
