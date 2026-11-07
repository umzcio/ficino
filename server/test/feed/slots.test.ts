import { describe, expect, it, vi } from 'vitest';
import {
  ENGAGEMENT_RANGES,
  applyEngagementDefaults,
  commitBudget,
  figureCaption,
  filterByBudget,
  finishPost,
  paperCap,
  pickFigure,
  priorPostsSummary,
  rotateWindow,
  seedBudget,
} from '../../src/feed/slots.js';
import type { Chunk, FeedFigure, Persona, Personas } from '../../src/feed/types.js';

const chunk = (id: string, paper = 'p1', extra: Partial<Chunk> = {}): Chunk => ({
  id,
  paper_id: paper,
  section: null,
  content: `content ${id}`,
  chunk_type: null,
  chunk_index: 0,
  token_count: null,
  paper_title: 'T',
  paper_authors: ['Ann Smith'],
  paper_year: 2024,
  paper_filename: null,
  score: 1,
  match_type: 'hybrid',
  ...extra,
});
const chunks = (n: number) => Array.from({ length: n }, (_, i) => chunk(`c${i}`));
const fig = (extra: Partial<FeedFigure> = {}): FeedFigure => ({
  id: 'f1', paper_id: 'p1', page_number: 4, image_url: '/img/f1.png', description: 'desc', claim_summary: '',
  figure_index: 0, paper_ref: 'Smith 2024', figure_type: 'chart', caption: 'Cap', figure_number: '2',
  data_claim: '', referenced_paragraph: '', detector_confidence: null, ...extra,
});
const persona = (extra: Partial<Persona> = {}): Persona => ({
  key: 'stats', handle: '@stats', name: 'S', initials: 'S', color: '#000', system_prompt: '', temperature: null,
  retrieval_query: null, allowed_figure_types: ['chart'], feed_eligible: true, ...extra,
});
const logger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) as any;
const rngOf = (v: number) => () => v;

describe('rotateWindow', () => {
  const ids = (cs: Chunk[]) => cs.map((c) => c.id);
  it('10 chunks over 3 slots', () => {
    const c = chunks(10);
    expect(ids(rotateWindow(c, 3, 0))).toEqual(['c0', 'c1', 'c2']);
    expect(ids(rotateWindow(c, 3, 1))).toEqual(['c3', 'c4', 'c5']);
    expect(ids(rotateWindow(c, 3, 2))).toEqual(['c6', 'c7', 'c8']);
  });
  it('3 chunks over 4 slots wraps (max_start 0)', () => {
    const c = chunks(3);
    for (let s = 0; s < 4; s++) expect(ids(rotateWindow(c, 4, s))).toEqual(['c0', 'c1', 'c2']);
  });
  it('single slot or <3 chunks is untouched', () => {
    expect(rotateWindow(chunks(10), 1, 0)).toHaveLength(10);
    expect(rotateWindow(chunks(2), 3, 1)).toHaveLength(2);
  });
});

describe('paperCap', () => {
  const byPersona = (papers: number) =>
    new Map([['a', Array.from({ length: papers }, (_, i) => chunk(`c${i}`, `p${i}`))]]);
  it('10 posts over 5 papers is 3, over 2 papers is 6', () => {
    expect(paperCap(10, byPersona(5))).toBe(3);
    expect(paperCap(10, byPersona(2))).toBe(6);
  });
  it('floors at 2 and treats zero papers as one', () => {
    expect(paperCap(1, byPersona(5))).toBe(2);
    expect(paperCap(4, new Map())).toBe(5);
  });
});

describe('budget', () => {
  it('seedBudget counts each post once per paper and skips falsy ids', () => {
    const b = seedBudget([
      { sources: [{ chunk_id: 'a', paper_id: 'p1' }, { chunk_id: 'b', paper_id: 'p1' }, 'junk', { chunk_id: '', paper_id: null }] },
      { sources: null },
      { sources: [{ chunk_id: 'c', paper_id: 'p2' }, { chunk_id: 'd', paper_id: 'p1' }] },
    ]);
    expect([...b.usedChunkIds].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(b.paperPostCounts.get('p1')).toBe(2);
    expect(b.paperPostCounts.get('p2')).toBe(1);
  });
  it('commitBudget adds to both counters', () => {
    const b = seedBudget([]);
    commitBudget(b, { sources: [{ chunk_id: 'x', paper_id: 'p9' }, { chunk_id: 'y', paper_id: 'p9' }] });
    commitBudget(b, { sources: undefined });
    expect([...b.usedChunkIds].sort()).toEqual(['x', 'y']);
    expect(b.paperPostCounts.get('p9')).toBe(1);
  });
  it('filterByBudget drops used chunks and over-represented papers', () => {
    const b = seedBudget([]);
    b.usedChunkIds.add('c0');
    b.paperPostCounts.set('pB', 3);
    const cs = [chunk('c0'), chunk('c1'), chunk('c2'), chunk('c3'), chunk('c4', 'pB'), chunk('c5', 'pB')];
    expect(filterByBudget(cs, b, 3).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });
  it('filterByBudget relaxes the paper cap when fewer than 3 remain, keeping used exclusion', () => {
    const b = seedBudget([]);
    b.usedChunkIds.add('c0');
    b.paperPostCounts.set('pB', 3);
    const cs = [chunk('c0'), chunk('c1'), chunk('c4', 'pB'), chunk('c5', 'pB')];
    expect(filterByBudget(cs, b, 3).map((c) => c.id)).toEqual(['c1', 'c4', 'c5']);
  });
});

describe('pickFigure', () => {
  it('skips with no figures', () => expect(pickFigure(rngOf(0), [], persona())).toBe('skip'));
  it('skips when allowed_figure_types is null or persona unknown', () => {
    expect(pickFigure(rngOf(0), [fig()], persona({ allowed_figure_types: null }))).toBe('skip');
    expect(pickFigure(rngOf(0), [fig()], undefined)).toBe('skip');
  });
  it('skips when no figure type matches or type is empty', () => {
    expect(pickFigure(rngOf(0), [fig({ figure_type: 'photo' }), fig({ figure_type: null })], persona())).toBe('skip');
  });
  it('returns an eligible figure', () => {
    const a = fig({ id: 'a' });
    const b = fig({ id: 'b' });
    const photo = fig({ id: 'p', figure_type: 'photo' });
    expect(pickFigure(rngOf(0.99), [photo, a, b], persona())).toBe(b);
    expect(pickFigure(rngOf(0), [photo, a, b], persona())).toBe(a);
  });
  it('returns null for a non-figure slot', () => {
    expect(pickFigure(rngOf(0), [fig()], persona(), 'post')).toBeNull();
  });
});

describe('figureCaption', () => {
  it('uses figure_number', () => {
    expect(figureCaption(fig())).toBe('Fig. 2, p.4 — Cap. Smith 2024');
  });
  it('falls back to figure_index + 1', () => {
    expect(figureCaption(fig({ figure_number: '', figure_index: 2 }))).toBe('Fig. 3, p.4 — Cap. Smith 2024');
    expect(figureCaption(fig({ figure_number: '', figure_index: null }))).toBe('Fig. 1, p.4 — Cap. Smith 2024');
  });
  it('falls back to description and caps caption at 200 code points', () => {
    expect(figureCaption(fig({ caption: '' }))).toBe('Fig. 2, p.4 — desc. Smith 2024');
    const out = figureCaption(fig({ caption: '😀'.repeat(250) }));
    expect(out).toBe(`Fig. 2, p.4 — ${'😀'.repeat(200)}. Smith 2024`);
  });
});

describe('priorPostsSummary', () => {
  const personas: Personas = new Map([['stats', persona()]]);
  it('replaces newlines, slices to 90 code points and appends the ellipsis', () => {
    const out = priorPostsSummary(
      [
        { persona: 'stats', paper_ref: 'Smith 2024', content: `a\nb${'x'.repeat(200)}` },
        { persona: 'ghost', content: '😀'.repeat(100) },
        { persona: 'stats', content: 'hidden', deleted: true },
        { content: null },
      ],
      personas,
    );
    expect(out).toEqual([
      `@stats on Smith 2024: a b${'x'.repeat(87)}…`,
      `@ghost on : ${'😀'.repeat(90)}…`,
      '@unknown on : …',
    ]);
  });
});

describe('applyEngagementDefaults', () => {
  it('sets absent keys only', () => {
    const post: Record<string, unknown> = { likes: 7, retweets: 0 };
    applyEngagementDefaults(rngOf(0), post);
    expect(post).toEqual({ likes: 7, retweets: 0, replies: ENGAGEMENT_RANGES.replies![0], bookmarks: ENGAGEMENT_RANGES.bookmarks![0] });
  });
});

describe('finishPost', () => {
  const personas: Personas = new Map([['stats', persona()]]);
  const base = (over: Record<string, unknown> = {}) => ({
    personaKey: 'stats', postType: 'post', chunks: chunks(2), figure: null as FeedFigure | null, idOffset: 10,
    timeOffset: 5, newCount: 2, jobId: 'job-1', tabCategory: null as string | null, personas, logger: logger(), ...over,
  });
  it('keeps extra keys and the LLM post_type; sets id, time, _task_id, paper_ref, sources, category', () => {
    const out = finishPost(rngOf(0), { content: 'hi', post_type: 'thread', thread_posts: ['a'], extra: 1, paper_ref: 'LLM' }, base());
    expect(out).toMatchObject({
      content: 'hi', post_type: 'thread', extra: 1, persona: 'stats', id: 13, time: '11m', _task_id: 'job-1',
      paper_ref: 'Ann Smith'.split(' ')[1] + ' 2024', category: 'findings',
    });
    expect(Array.isArray(out.sources)).toBe(true);
    expect(out.likes).toBe(ENGAGEMENT_RANGES.likes![0]);
  });
  it('keeps a thread slot whose reply follows the thread prompt (thread_posts, no content or post_type)', () => {
    const out = finishPost(rngOf(0), { thread_posts: ['Hook.', 'Point.'], thread_count: 2 }, base({ postType: 'thread' }));
    expect(out).toMatchObject({ post_type: 'thread', content: 'Hook.\n\nPoint.', thread_posts: ['Hook.', 'Point.'] });
  });
  it('defaults post_type to the slot type', () => {
    expect(finishPost(rngOf(0), { content: 'hi' }, base({ postType: 'quote' })).post_type).toBe('quote');
  });
  it('fills a missing paper_ref from the figure and attaches figure fields', () => {
    const out = finishPost(rngOf(0), { content: 'hi' }, base({ chunks: [], figure: fig(), postType: 'figure' }));
    expect(out).toMatchObject({
      figure_url: '/img/f1.png', figure_id: 'f1', paper_ref: 'Smith 2024',
      figure_caption: 'Fig. 2, p.4 — Cap. Smith 2024', category: 'findings',
    });
  });
  it('applies the tab override', () => {
    expect(finishPost(rngOf(0), { content: 'hi' }, base({ tabCategory: 'methods' })).category).toBe('methods');
  });
  it('does not overwrite an LLM-supplied likes', () => {
    expect(finishPost(rngOf(0), { content: 'hi', likes: 3 }, base()).likes).toBe(3);
  });
  it('runs validatePostShape (throws without content)', () => {
    expect(() => finishPost(rngOf(0), {}, base())).toThrow('persona_post_missing_content');
  });
});
