import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPostPrompt, fetchChunksByIds } from '../../src/feed/prompts.js';
import type { Chunk, Persona, Personas } from '../../src/feed/types.js';
import { resetDb, seedUsers, testSql } from '../helpers/db.js';

type Case = { name: string; args: Record<string, any>; prompt: string };
const cases = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/persona-prompts.json', import.meta.url), 'utf8'),
) as Case[];

const personasOf = (raw: Record<string, Record<string, unknown>>): Personas =>
  new Map(Object.entries(raw).map(([key, p]) => [key, { key, ...p } as Persona]));

describe('buildPostPrompt goldens', () => {
  for (const c of cases) {
    it(`matches Python for ${c.name}`, async () => {
      const a = c.args;
      const prompt = await buildPostPrompt({
        rng: () => 0,
        sql: testSql(),
        personas: personasOf(a.personas),
        personaKey: a.persona_key,
        postType: a.post_type,
        chunks: a.chunks,
        contradictions: a.contradictions,
        existingPosts: a.existing_posts,
        figure: a.figure,
        priorPostsSummary: a.prior_posts_summary,
        fetchAnchors: async () => a.anchors as Chunk[],
      });
      expect(prompt).toBe(c.prompt);
    });
  }
});

describe('buildPostPrompt errors', () => {
  const base = cases[0]!.args;
  const common = { rng: () => 0, sql: testSql(), personas: personasOf(base.personas), chunks: base.chunks };

  it('rejects a figure post without a figure with the Python message', async () => {
    await expect(buildPostPrompt({ ...common, personaKey: 'skeptic', postType: 'figure' })).rejects.toThrow(
      "build_post_prompt called with post_type='figure' but figure=None; callers must drop the slot when no eligible figure exists.",
    );
  });

  it('rejects an unknown persona', async () => {
    await expect(buildPostPrompt({ ...common, personaKey: 'nobody', postType: 'post' })).rejects.toThrow();
  });
});

describe('fetchChunksByIds', () => {
  const sql = testSql();
  beforeEach(() => resetDb(sql));

  it('returns rows for known ids as anchor chunks and ignores unknown ones', async () => {
    const s = await seedUsers(sql);
    await sql`UPDATE papers SET title = 'T', authors = ${['Ann Lee']}, year = 2022 WHERE id = ${s.paper_a}`;
    const [c] = await sql`
      INSERT INTO chunks (paper_id, user_id, section, content, chunk_type, chunk_index, token_count)
      VALUES (${s.paper_a}, ${s.user_a}, 'Methods', 'hello', 'text', 3, 5) RETURNING id`;
    const out = await fetchChunksByIds(sql, [c!.id as string, '00000000-0000-0000-0000-000000000000']);
    expect(out).toEqual([
      {
        id: c!.id, paper_id: s.paper_a, section: 'Methods', content: 'hello', chunk_type: 'text', chunk_index: 3,
        token_count: 5, paper_title: 'T', paper_authors: ['Ann Lee'], paper_year: 2022, paper_filename: 'a.pdf',
        score: 0, match_type: 'anchor',
      },
    ]);
    expect(await fetchChunksByIds(sql, [])).toEqual([]);
  });
});
