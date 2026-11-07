import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PREFERENCE_BLEND,
  POST_TYPE_WEIGHTS,
  SYSTEM_PREAMBLE,
  assignPostCategory,
  blendWeights,
  buildPostSources,
  buildShortCite,
  eligiblePersonaKeys,
  loadPersonas,
  planFeedPosts,
  resolveEnabledPersonas,
  systemPrompts,
} from '../../src/feed/personas.js';
import type { Chunk, Persona, Personas } from '../../src/feed/types.js';
import { testSql } from '../helpers/db.js';
import { fromPythonSystemPrompt } from '../helpers/preamble.js';

const gold = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/feed-pure.json', import.meta.url), 'utf8'),
) as Record<string, any>;

const mk = (key: string, feed_eligible = true): Persona => ({
  key, handle: `@${key}`, name: key, initials: key.slice(0, 2), color: '#000', system_prompt: 'p',
  temperature: null, retrieval_query: null, allowed_figure_types: null, feed_eligible,
});
const personasOf = (keys: string[], archivist = false): Personas => {
  const m: Personas = new Map(keys.map((k) => [k, mk(k)]));
  if (archivist) m.set('archivist', mk('archivist', false));
  return m;
};
const goldPersonas = (): Personas =>
  new Map((gold.personas as string[]).map((k) => [k, mk(k, k !== 'archivist')]));

describe('goldens', () => {
  it('SYSTEM_PREAMBLE is the Python constant with only its {"posts": [...]} schema sentence replaced', () => {
    const python = readFileSync(new URL('../fixtures/goldens/system-preamble.txt', import.meta.url), 'utf8');
    expect(Buffer.from(SYSTEM_PREAMBLE, 'utf8').equals(Buffer.from(fromPythonSystemPrompt(python), 'utf8'))).toBe(true);
    expect(SYSTEM_PREAMBLE).not.toContain('"posts"');
  });
  it('PREFERENCE_BLEND matches', () => expect(PREFERENCE_BLEND).toBe(gold.preference_blend));
  it('buildShortCite', () => {
    for (const c of gold.short_cite) expect(buildShortCite(c.chunk as Chunk)).toBe(c.expected);
  });
  it('buildPostSources', () => {
    for (const c of gold.sources) expect(buildPostSources(c.chunks, c.top_n)).toEqual(c.expected);
  });
  it('assignPostCategory', () => {
    for (const c of gold.category) expect(assignPostCategory(c.persona, c.post_type)).toBe(c.expected);
  });
  it('blendWeights', () => {
    for (const c of gold.blend) expect(blendWeights(c.manual, c.learned, c.blend)).toEqual(c.expected);
  });
  it('resolveEnabledPersonas', () => {
    for (const c of gold.enabled) {
      expect([...resolveEnabledPersonas(c.settings, goldPersonas())].sort()).toEqual(c.expected);
    }
  });
});

describe('buildShortCite deliberate change 4', () => {
  it('a whitespace-only author falls through to the title', () => {
    expect(buildShortCite({ paper_authors: ['  '], paper_title: 'T', paper_year: 2024 } as unknown as Chunk)).toBe(
      'T (2024)',
    );
  });
});

describe('ported helper tests', () => {
  const chunk = (i: number, extra: Partial<Chunk> = {}): Chunk =>
    ({ id: `c${i}`, paper_id: 'p', section: 'S', content: 'x', score: 0.5, paper_title: `T${i}`, ...extra }) as Chunk;

  it('test_build_post_sources_key_shape_and_truncation', () => {
    const [s] = buildPostSources([chunk(1, { content: 'y'.repeat(500), score: 0.12345 })]);
    expect(Object.keys(s!)).toEqual(['chunk_id', 'paper_id', 'paper_title', 'section', 'content', 'score']);
    expect((s!.content as string).length).toBe(300);
    expect(s!.score).toBe(0.123);
  });
  it('test_build_post_sources_respects_top_n', () => {
    const cs = Array.from({ length: 7 }, (_, i) => chunk(i));
    expect(buildPostSources(cs)).toHaveLength(5);
    expect(buildPostSources(cs, 2)).toHaveLength(2);
  });
  it('test_build_post_sources_falls_back_to_paper_filename', () => {
    const [s] = buildPostSources([chunk(1, { paper_title: null, paper_filename: 'f.pdf' })]);
    expect(s!.paper_title).toBe('f.pdf');
    expect(buildPostSources([chunk(1, { paper_title: null, paper_filename: null })])[0]!.paper_title).toBe('Unknown');
  });
  it('test_resolve_enabled_personas_is_opt_out', () => {
    const p = personasOf(['skeptic', 'hype'], true);
    expect([...resolveEnabledPersonas({ personas_enabled: { hype: false } }, p)]).toEqual(['skeptic']);
    expect(resolveEnabledPersonas({ personas_enabled: { newbie: true } }, p).has('hype')).toBe(true);
  });
  it('test_resolve_enabled_personas_handles_missing_settings', () => {
    const p = personasOf(['skeptic', 'hype'], true);
    expect([...resolveEnabledPersonas({}, p)].sort()).toEqual(['hype', 'skeptic']);
    expect([...resolveEnabledPersonas({ personas_enabled: null }, p)].sort()).toEqual(['hype', 'skeptic']);
  });
  it('test_fallback_excludes_reply_only_personas', () => {
    const keys = eligiblePersonaKeys(new Set(), personasOf(['skeptic', 'hype'], true));
    expect(keys).not.toContain('archivist');
    expect(keys).toEqual(['skeptic', 'hype']);
  });
});

describe('loadPersonas', () => {
  it('returns the seeded personas in sort_order', async () => {
    const p = await loadPersonas(testSql());
    expect(p.size).toBe(7);
    const a = p.get('archivist')!;
    expect(a.feed_eligible).toBe(false);
    expect(a.allowed_figure_types).toBeNull();
    const sk = p.get('skeptic')!;
    expect(typeof sk.temperature).toBe('number');
    expect(sk.temperature).toBeCloseTo(0.6);
    const rows = await testSql()`SELECT key FROM personas WHERE is_active = true ORDER BY sort_order`;
    expect([...p.keys()]).toEqual(rows.map((r) => r.key));
  });
  it('systemPrompts prepends the preamble', async () => {
    const p = await loadPersonas(testSql());
    const sp = systemPrompts(p);
    expect(sp.get('skeptic')).toBe(SYSTEM_PREAMBLE + p.get('skeptic')!.system_prompt);
  });
});

describe('planFeedPosts', () => {
  const five = personasOf(['skeptic', 'methodologist', 'practitioner', 'hype', 'gradstudent']);
  const all = new Set(five.keys());
  const seq = (i = 0) => () => ((i = (i * 7 + 3) % 101), i / 101);

  it('12 posts, first 3 distinct persona openers of type post', () => {
    const plan = planFeedPosts(seq(), five, { numPosts: 12, enabled: all });
    expect(plan).toHaveLength(12);
    expect(new Set(plan.slice(0, 3).map((a) => a.persona)).size).toBe(3);
    expect(plan.slice(0, 3).every((a) => a.post_type === 'post')).toBe(true);
    expect(Object.keys(POST_TYPE_WEIGHTS)).toEqual(['post', 'thread', 'quote', 'reply', 'figure']);
  });
  it('numPosts 1 still yields 3 openers', () => {
    expect(planFeedPosts(seq(), five, { numPosts: 1, enabled: all })).toHaveLength(3);
  });
  it('customWeights reply-only makes every non-opener a reply', () => {
    const plan = planFeedPosts(seq(), five, { numPosts: 12, enabled: all, customWeights: { reply: 1 } });
    expect(plan.slice(3).every((a) => a.post_type === 'reply')).toBe(true);
  });
  it('preferences blend post-type weights', () => {
    const last = () => 0.999999;
    const plan = planFeedPosts(last, five, {
      numPosts: 8, enabled: all, preferences: { has_signal: true, post_type_weights: { figure: 1 } },
    });
    expect(plan.slice(3).some((a) => a.post_type === 'figure')).toBe(true);
    // At rng 0.5 the manual weights land on quote; the blended weights (figure +0.4) land on reply.
    const base = planFeedPosts(() => 0.5, five, { numPosts: 8, enabled: all });
    expect(base.slice(3).every((a) => a.post_type === 'quote')).toBe(true);
    const mid = planFeedPosts(() => 0.5, five, {
      numPosts: 8, enabled: all, preferences: { has_signal: true, post_type_weights: { figure: 1 } },
    });
    expect(mid.slice(3).every((a) => a.post_type === 'reply')).toBe(true);
  });
  it('empty enabled set with no feed-eligible personas falls back to every persona', () => {
    const none: Personas = new Map([['a', mk('a', false)], ['b', mk('b', false)]]);
    const plan = planFeedPosts(seq(), none, { numPosts: 5, enabled: new Set() });
    expect(plan).toHaveLength(5);
    expect(new Set(plan.map((a) => a.persona))).toEqual(new Set(['a', 'b']));
  });
});
