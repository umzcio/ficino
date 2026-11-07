// Port of the per-slot helpers in worker/tasks/persona_tasks.py (ENGAGEMENT_RANGES :38-49, the slot loop :539-830).
import type { Logger } from 'pino';
import { type Rng, choice, randInt } from '../shared/random.js';
import { pySlice, pyStr } from '../shared/pystr.js';
import { validatePostShape } from './llmPost.js';
import { assignPostCategory, buildPostSources, buildShortCite } from './personas.js';
import type { Chunk, FeedFigure, Persona, Personas, Post } from './types.js';

export const ENGAGEMENT_RANGES: Record<string, readonly [number, number]> = {
  likes: [100, 5000],
  retweets: [20, 1000],
  replies: [10, 500],
  bookmarks: [10, 900],
};

/** Python truthiness for the JSON values these helpers meet. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `_apply_engagement_defaults`: `setdefault` per field, so a key already present (even null) is kept. */
export function applyEngagementDefaults(rng: Rng, post: Post): void {
  for (const [field, [lo, hi]] of Object.entries(ENGAGEMENT_RANGES)) {
    // Python evaluates randint before setdefault, so the draw happens either way.
    const v = randInt(rng, lo, hi);
    if (!Object.hasOwn(post, field)) post[field] = v;
  }
}

export type Budget = { usedChunkIds: Set<string>; paperPostCounts: Map<string, number> };

/** Walk a post's sources: chunk ids used, and the distinct papers it grounded on. */
function sourceIds(post: Post): { chunkIds: string[]; paperIds: Set<string> } {
  const chunkIds: string[] = [];
  const paperIds = new Set<string>();
  const sources = post.sources;
  if (truthy(sources) && Array.isArray(sources)) {
    for (const src of sources) {
      if (!isDict(src)) continue;
      if (truthy(src.chunk_id)) chunkIds.push(pyStr(src.chunk_id));
      if (truthy(src.paper_id)) paperIds.add(pyStr(src.paper_id));
    }
  }
  return { chunkIds, paperIds };
}

/** Seed the feed-level budget from posts already in the feed (:539-551). */
export function seedBudget(existingPosts: Post[]): Budget {
  const budget: Budget = { usedChunkIds: new Set(), paperPostCounts: new Map() };
  for (const ep of existingPosts) commitBudget(budget, ep);
  return budget;
}

/** Commit a finished post's chunks and papers to the budget (:819-829). */
export function commitBudget(budget: Budget, post: Post): void {
  const { chunkIds, paperIds } = sourceIds(post);
  for (const id of chunkIds) budget.usedChunkIds.add(id);
  for (const pid of paperIds) budget.paperPostCounts.set(pid, (budget.paperPostCounts.get(pid) ?? 0) + 1);
}

/** Soft per-paper cap that scales with corpus breadth (:556-563). */
export function paperCap(
  numPosts: number,
  chunksByPersona: Map<string, Chunk[]> | Record<string, Chunk[]>,
): number {
  const lists = chunksByPersona instanceof Map ? [...chunksByPersona.values()] : Object.values(chunksByPersona);
  const papers = new Set<string>();
  for (const list of lists) for (const c of list) if (truthy(c.paper_id)) papers.add(String(c.paper_id));
  const inScope = Math.max(1, papers.size);
  return Math.max(2, Math.floor((numPosts + inScope - 1) / inScope) + 1);
}

/** Each of a persona's slots sees a different window of its chunks (:589-596). */
export function rotateWindow(chunks: Chunk[], slotCount: number, slotIndex: number): Chunk[] {
  if (slotCount > 1 && chunks.length >= 3) {
    const windowSize = Math.max(3, Math.floor(chunks.length / slotCount));
    const maxStart = Math.max(0, chunks.length - windowSize);
    const start = maxStart > 0 ? (slotIndex * windowSize) % (maxStart + 1) : 0;
    return chunks.slice(start, start + windowSize);
  }
  return chunks;
}

/** Drop used chunks and over-cap papers; relax the paper cap when under 3 remain (:604-620). */
export function filterByBudget(chunks: Chunk[], budget: Budget, cap: number): Chunk[] {
  const over = new Set<string>();
  for (const [pid, n] of budget.paperPostCounts) if (n >= cap) over.add(pid);
  const filtered = chunks.filter((c) => !budget.usedChunkIds.has(String(c.id)) && !over.has(String(c.paper_id)));
  if (filtered.length < 3) return chunks.filter((c) => !budget.usedChunkIds.has(String(c.id)));
  return filtered;
}

/**
 * Figure selection for a slot (:680-706). `'skip'` means drop the slot (no figures, or none of an allowed type);
 * `null` means a non-figure slot. `postType` defaults to 'figure' so the three-argument form is the figure path.
 */
export function pickFigure(
  rng: Rng,
  figures: FeedFigure[],
  persona: Persona | undefined,
  postType = 'figure',
): FeedFigure | null | 'skip' {
  if (postType !== 'figure') return null;
  if (figures.length === 0) return 'skip';
  const allowed = new Set(persona?.allowed_figure_types ?? []);
  const eligible = figures.filter((f) => truthy(f.figure_type) && allowed.has(f.figure_type as string));
  if (eligible.length === 0) return 'skip';
  return choice(rng, eligible);
}

/** The "PRIOR POSTS" lines build_post_prompt renders (:721-730). Soft-deleted posts are excluded. */
export function priorPostsSummary(posts: Post[], personas: Personas): string[] {
  const out: string[] = [];
  for (const p of posts) {
    if (truthy(p.deleted)) continue;
    const pers = Object.hasOwn(p, 'persona') ? p.persona : 'unknown';
    const pref = truthy(p.paper_ref) ? pyStr(p.paper_ref) : '';
    const content = pySlice(truthy(p.content) ? pyStr(p.content) : '', 0, 90).replaceAll('\n', ' ');
    const handle = personas.get(pyStr(pers))?.handle ?? `@${pyStr(pers)}`;
    out.push(`${handle} on ${pref}: ${content}…`);
  }
  return out;
}

/** `Fig. N, p.P — caption. paper_ref` (:770-783). */
export function figureCaption(fig: FeedFigure): string {
  const label = truthy(fig.figure_number) ? `Fig. ${fig.figure_number}` : `Fig. ${(fig.figure_index || 0) + 1}`;
  const captionText = pySlice(truthy(fig.caption) ? fig.caption : (fig.description ?? ''), 0, 200);
  // dict.get("paper_ref", "") yields None when the key holds null, which an f-string prints as "None".
  const paperRef = fig.paper_ref === undefined ? '' : pyStr(fig.paper_ref);
  return `${label}, p.${pyStr(fig.page_number)} — ${captionText}. ${paperRef}`;
}

export type FinishPostOpts = {
  personaKey: string;
  postType: string;
  chunks: Chunk[];
  figure: FeedFigure | null;
  idOffset: number;
  timeOffset: number;
  /** len(posts) at the time: successfully appended new posts so far. */
  newCount: number;
  jobId: string | null;
  tabCategory: string | null;
  personas: Personas;
  logger: Logger;
};

export type GroundPostOpts = {
  personaKey: string;
  chunks: Chunk[];
  figure: FeedFigure | null;
  /** Overrides the persona/post_type category (generate_feed's tab_focus); null for none. */
  tabCategory: string | null;
  logger: Logger;
};

/** `figure_url`/`figure_id`/`figure_caption`, and `paper_ref` from the figure when the post has none (:762-783). */
export function attachFigure(post: Post, figure: FeedFigure): void {
  post.figure_url = figure.image_url;
  post.figure_id = figure.id;
  post.figure_caption = figureCaption(figure);
  if (!truthy(post.paper_ref)) post.paper_ref = figure.paper_ref === undefined ? '' : figure.paper_ref;
}

/**
 * The tail shared by generate_feed, regenerate_post and generate_chapter once a post has its persona, post_type, id
 * and time: cite, figure, sources, category, engagement defaults, shape validation.
 */
export function groundPost(rng: Rng, post: Post, o: GroundPostOpts): Post {
  if (o.chunks.length > 0) post.paper_ref = buildShortCite(o.chunks[0]!);
  if (o.figure) attachFigure(post, o.figure);
  post.sources = buildPostSources(o.chunks);
  post.category = assignPostCategory(o.personaKey, post.post_type as string);
  if (truthy(o.tabCategory)) post.category = o.tabCategory;
  applyEngagementDefaults(rng, post);
  validatePostShape(post, { personaKey: o.personaKey, logger: o.logger });
  return post;
}

/** Everything generate_feed does to an LLM post between generation and `posts.append` (:747-812). */
export function finishPost(rng: Rng, raw: Post, o: FinishPostOpts): Post {
  const post: Post = raw;
  post.persona = o.personaKey;
  if (!Object.hasOwn(post, 'post_type')) post.post_type = o.postType;
  post.id = o.idOffset + o.newCount + 1;
  post.time = `${o.timeOffset + (o.newCount + 1) * 2}m`;
  post._task_id = o.jobId;
  return groundPost(rng, post, o);
}

export type FinishRegeneratedOpts = GroundPostOpts & {
  postType: string;
  /** The post being replaced: its id and time are kept. */
  oldPost: Post;
  postIndex: number;
};

/** regenerate_post's fill (persona_tasks.py:1018-1040): keeps the old id and time, sets no `_task_id`. */
export function finishRegeneratedPost(rng: Rng, raw: Post, o: FinishRegeneratedOpts): Post {
  const post: Post = raw;
  post.persona = o.personaKey;
  if (!Object.hasOwn(post, 'post_type')) post.post_type = o.postType;
  post.id = Object.hasOwn(o.oldPost, 'id') ? o.oldPost.id : o.postIndex + 1;
  post.time = Object.hasOwn(o.oldPost, 'time') ? o.oldPost.time : `${o.postIndex * 2}m`;
  groundPost(rng, post, o);
  post.regenerated = true;
  return post;
}
