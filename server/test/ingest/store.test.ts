import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtractedFigure } from '../../src/ingest/figures.js';
import { storeChunks, storeFigure } from '../../src/ingest/store.js';
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
