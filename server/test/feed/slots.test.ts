import { describe, expect, it, vi } from 'vitest';
import {
  ENGAGEMENT_RANGES,
  applyEngagementDefaults,
  commitBudget,
  figureCaption,
  filterByBudget,
  finishPost,
  finishRegeneratedPost,
  paperCap,
  pickFigure,
  priorPostsSummary,
  rotateWindow,
  seedBudget,
} from '../../src/feed/slots.js';
import { unwrapPostWrapper } from '../../src/feed/llmPost.js';
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
  it('keeps the LLM post_type and drops unknown keys; sets id, time, _task_id, paper_ref, sources, category', () => {
    const out = finishPost(rngOf(0), { content: 'hi', post_type: 'thread', thread_posts: ['a'], extra: 1, paper_ref: 'LLM' }, base());
    expect(out).toMatchObject({
      content: 'hi', post_type: 'thread', persona: 'stats', id: 13, time: '11m', _task_id: 'job-1',
      paper_ref: 'Ann Smith'.split(' ')[1] + ' 2024', category: 'findings',
    });
    expect(out).not.toHaveProperty('extra');
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
  it('ignores an LLM-supplied likes (engagement counts belong to the server)', () => {
    expect(finishPost(rngOf(0), { content: 'hi', likes: 3 }, base()).likes).toBe(ENGAGEMENT_RANGES.likes![0]);
  });
  it('runs validatePostShape (throws without content)', () => {
    expect(() => finishPost(rngOf(0), {}, base())).toThrow('persona_post_missing_content');
  });
});

// Security review: model output is untrusted (a hostile paper can steer it), so it sets only the text fields the
// prompts ask for. Every server-owned field comes from worker code or is absent.
describe('model output cannot set server-owned post fields', () => {
  const personas: Personas = new Map([['stats', persona()]]);
  const feedOpts = (over: Record<string, unknown> = {}) => ({
    personaKey: 'stats', postType: 'post', chunks: chunks(2), figure: null as FeedFigure | null, idOffset: 0,
    timeOffset: 0, newCount: 0, jobId: 'job-1', tabCategory: null as string | null, personas, logger: logger(), ...over,
  });
  const regenOpts = (over: Record<string, unknown> = {}) => ({
    personaKey: 'stats', postType: 'post', chunks: chunks(2), figure: null as FeedFigure | null,
    tabCategory: null as string | null, oldPost: { id: 7, time: '14m' }, postIndex: 6, logger: logger(), ...over,
  });
  const injected: Record<string, unknown> = {
    figure_url: 'https://attacker.example/x.png?d=leak',
    figure_id: '00000000-0000-4000-8000-000000000000',
    figure_caption: 'Fig. 9, p.1 — fake',
    audio_url: 'https://attacker.example/a.mp3',
    audio_key: 'someone/else.mp3',
    sources: [{ chunk_id: 'evil', paper_id: 'evil', paper_title: 'x', section: 'x', content: 'x', score: 9 }],
    id: 999,
    time: '0m',
    deleted: true,
    regenerated: true,
    _task_id: 'forged',
    persona: 'someone_else',
    category: 'forged',
    likes: 1,
    retweets: 1,
    replies: 1,
    bookmarks: 1,
    figure_type: 'chart',
  };
  // JSON.parse makes __proto__ an own key, as a model reply would.
  const reply = (extra: Record<string, unknown>) => JSON.parse(JSON.stringify({ content: 'hi', ...extra }).replace(
    '"content"', '"__proto__":{"polluted":true},"content"')) as Record<string, unknown>;

  const serverValues = (out: Record<string, unknown>) => {
    expect(out.persona).toBe('stats');
    expect(out.category).not.toBe('forged');
    expect(out.likes).toBe(ENGAGEMENT_RANGES.likes![0]);
    expect(out.retweets).toBe(ENGAGEMENT_RANGES.retweets![0]);
    expect(out.replies).toBe(ENGAGEMENT_RANGES.replies![0]);
    expect(out.bookmarks).toBe(ENGAGEMENT_RANGES.bookmarks![0]);
    expect((out.sources as Array<{ chunk_id: string }>).map((x) => x.chunk_id)).toEqual(['c0', 'c1']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out).not.toHaveProperty('polluted');
  };

  for (const key of Object.keys(injected)) {
    it(`finishPost drops a model-supplied ${key}`, () => {
      const out = finishPost(rngOf(0), reply({ [key]: injected[key] }), feedOpts());
      if (['figure_url', 'figure_id', 'figure_caption', 'audio_url', 'audio_key', 'deleted', 'regenerated', 'figure_type'].includes(key)) {
        expect(out).not.toHaveProperty(key);
      }
      expect(out).toMatchObject({ id: 1, time: '2m', _task_id: 'job-1', post_type: 'post', content: 'hi' });
      serverValues(out);
    });
  }

  it('finishPost drops them all at once and keeps the content', () => {
    const out = finishPost(rngOf(0), reply({ post_type: 'post', ...injected }), feedOpts());
    for (const k of ['figure_url', 'figure_id', 'figure_caption', 'audio_url', 'audio_key', 'deleted', 'regenerated']) {
      expect(out).not.toHaveProperty(k);
    }
    expect(out).toMatchObject({ id: 1, time: '2m', _task_id: 'job-1', post_type: 'post', content: 'hi' });
    serverValues(out);
  });

  it('finishRegeneratedPost drops them; id and time come from the old post, regenerated from the server', () => {
    const out = finishRegeneratedPost(rngOf(0), reply({ post_type: 'post', ...injected }), regenOpts());
    for (const k of ['figure_url', 'figure_id', 'figure_caption', 'audio_url', 'audio_key', 'deleted', '_task_id']) {
      expect(out).not.toHaveProperty(k);
    }
    expect(out).toMatchObject({ id: 7, time: '14m', regenerated: true, post_type: 'post', content: 'hi' });
    serverValues(out);
  });

  it('finishRegeneratedPost falls back to the index for id and time, never the model', () => {
    const out = finishRegeneratedPost(rngOf(0), reply({ id: 999, time: '0m' }), regenOpts({ oldPost: {} }));
    expect(out).toMatchObject({ id: 7, time: '12m' });
  });

  it('a figure slot uses the server figure, not the model figure fields', () => {
    const out = finishPost(rngOf(0), reply({ post_type: 'figure', ...injected }), feedOpts({ postType: 'figure', figure: fig() }));
    expect(out).toMatchObject({
      post_type: 'figure', figure_url: '/img/f1.png', figure_id: 'f1', figure_caption: 'Fig. 2, p.4 — Cap. Smith 2024',
    });
    expect(out).not.toHaveProperty('audio_url');
    expect(out).not.toHaveProperty('deleted');
  });

  describe('post_type figure needs a worker-attached figure', () => {
    it('downgrades to the slot type on a post slot', () => {
      expect(finishPost(rngOf(0), reply({ post_type: 'figure' }), feedOpts()).post_type).toBe('post');
    });
    it('downgrades to the slot type on a thread slot (the thread survives)', () => {
      const out = finishPost(rngOf(0), reply({ post_type: 'figure', thread_posts: ['a', 'b'], thread_count: 2 }),
        feedOpts({ postType: 'thread' }));
      expect(out).toMatchObject({ post_type: 'thread', thread_posts: ['a', 'b'], thread_count: 2 });
    });
    it('downgrades to the slot type on a quote slot', () => {
      expect(finishPost(rngOf(0), reply({ post_type: 'figure' }), feedOpts({ postType: 'quote' })).post_type).toBe('quote');
    });
    it('downgrades to post on a figure slot without a figure', () => {
      expect(finishPost(rngOf(0), reply({ post_type: 'figure' }), feedOpts({ postType: 'figure' })).post_type).toBe('post');
      expect(finishPost(rngOf(0), reply({}), feedOpts({ postType: 'figure' })).post_type).toBe('post');
    });
    it('downgrades on regenerate', () => {
      expect(finishRegeneratedPost(rngOf(0), reply({ post_type: 'figure' }), regenOpts()).post_type).toBe('post');
    });
  });

  it('an unwrapped {"posts": [{"text", "type"}]} reply keeps its text as content', () => {
    const out = finishPost(rngOf(0), unwrapPostWrapper({ posts: [{ text: 'Wrapped take.', type: 'post', likes: 1 }] }), feedOpts());
    expect(out).toMatchObject({ post_type: 'post', content: 'Wrapped take.' });
    expect(out).not.toHaveProperty('text');
    expect(out).not.toHaveProperty('type');
    serverValues(out);
  });

  describe('a normal post of each type is unchanged', () => {
    const common = (out: Record<string, unknown>) => {
      expect(out).toMatchObject({ persona: 'stats', id: 1, time: '2m', _task_id: 'job-1', paper_ref: 'Smith 2024' });
      serverValues(out);
    };
    it('post', () => {
      const out = finishPost(rngOf(0), { post_type: 'post', content: 'A take.', paper_ref: 'Smith 2024' }, feedOpts());
      expect(out).toMatchObject({ post_type: 'post', content: 'A take.' });
      common(out);
    });
    it('thread', () => {
      const out = finishPost(rngOf(0),
        { post_type: 'thread', paper_ref: 'Smith 2024', thread_count: 2, thread_posts: ['One.', 'Two.'] },
        feedOpts({ postType: 'thread' }));
      expect(out).toMatchObject({ post_type: 'thread', content: 'One.\n\nTwo.', thread_count: 2, thread_posts: ['One.', 'Two.'] });
      common(out);
    });
    it('quote', () => {
      const out = finishPost(rngOf(0),
        { post_type: 'quote', content: 'Pushback.', paper_ref: null, quoting_handle: '@stats', quoting_content: 'Orig...' },
        feedOpts({ postType: 'quote' }));
      expect(out).toMatchObject({ post_type: 'quote', content: 'Pushback.', quoting_handle: '@stats', quoting_content: 'Orig...' });
      common(out);
    });
    it('reply', () => {
      const out = finishPost(rngOf(0),
        { post_type: 'reply', content: 'Go on.', paper_ref: null, replying_to: '@stats' },
        feedOpts({ postType: 'reply' }));
      expect(out).toMatchObject({ post_type: 'reply', content: 'Go on.', replying_to: '@stats' });
      common(out);
    });
    it('figure', () => {
      const out = finishPost(rngOf(0), { post_type: 'figure', content: 'Look.', paper_ref: 'Smith 2024' },
        feedOpts({ postType: 'figure', figure: fig() }));
      expect(out).toMatchObject({ post_type: 'figure', content: 'Look.', figure_url: '/img/f1.png', figure_id: 'f1' });
      common(out);
    });
  });
});
