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

/**
 * The log line for a slot `pickFigure` dropped (:688-704): no figures in scope, or none of a type the persona
 * allows. Shared by generate_feed and generate_chapter so their event fields stay identical.
 */
export function logFigureSkip(log: Logger, persona: string, meta: Persona | undefined, figures: FeedFigure[]): void {
  if (figures.length === 0) {
    log.info({ persona }, 'figure_post_skipped_no_figures_in_paper');
    return;
  }
  const types = figures.map((f) => f.figure_type).filter((t): t is string => truthy(t));
  log.info(
    { persona, allowed: [...new Set(meta?.allowed_figure_types ?? [])], available_types: [...new Set(types)].sort() },
    'figure_post_skipped_no_eligible_figure',
  );
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

/** A model text field as kept: a string or null as given, a finite number as its decimal string, else absent. */
function modelText(v: unknown): string | null | undefined {
  if (typeof v === 'string' || v === null) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * The fields a persona prompt asks the model for (prompts.ts): the post text, the thread, the quote and reply echo,
 * and a cite the server replaces anyway, each with the value startPost keeps (undefined: the field is dropped). The
 * client renders the text fields as strings and thread_count as a number, so another JSON type is never stored
 * (deliberate change 23). post_type passes as is: validatePostShape turns a non-string or unknown type into 'post'.
 */
const MODEL_FIELD_VALUE: Readonly<Record<string, (v: unknown) => unknown>> = {
  post_type: (v) => v,
  content: modelText,
  paper_ref: modelText,
  thread_count: (v) => (v === null || Number.isSafeInteger(v) ? v : undefined),
  thread_posts: (v) => (v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')) ? v : undefined),
  quoting_handle: modelText,
  quoting_content: modelText,
  replying_to: modelText,
};

/** Every other post field is the server's. */
export const MODEL_POST_FIELDS: ReadonlySet<string> = new Set(Object.keys(MODEL_FIELD_VALUE));

/**
 * The start of every finished post (generate_feed, regenerate_post, generate_chapter): a new object holding only the
 * model's MODEL_POST_FIELDS, the persona, and the post type. Model output is untrusted (a paper can steer it), so it
 * never sets figure, audio, source, id, time, deletion or engagement fields (deliberate change 15; Python kept every
 * model key), and a kept field holds only the type the client expects (MODEL_FIELD_VALUE). The model's post_type
 * stands, as in Python, except 'figure' without a figure the worker picked: that falls back to the slot type, or
 * 'post' for a figure slot.
 */
export function startPost(raw: Post, personaKey: string, slotType: string, figure: FeedFigure | null): Post {
  const post: Post = {};
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(MODEL_FIELD_VALUE, key)) continue;
    const value = MODEL_FIELD_VALUE[key]!(raw[key]);
    if (value !== undefined) post[key] = value;
  }
  post.persona = personaKey;
  if (!Object.hasOwn(post, 'post_type')) post.post_type = slotType;
  if (post.post_type === 'figure' && !figure) post.post_type = slotType === 'figure' ? 'post' : slotType;
  return post;
}

/** Everything generate_feed does to an LLM post between generation and `posts.append` (:747-812). */
export function finishPost(rng: Rng, raw: Post, o: FinishPostOpts): Post {
  const post = startPost(raw, o.personaKey, o.postType, o.figure);
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
  const post = startPost(raw, o.personaKey, o.postType, o.figure);
  post.id = Object.hasOwn(o.oldPost, 'id') ? o.oldPost.id : o.postIndex + 1;
  post.time = Object.hasOwn(o.oldPost, 'time') ? o.oldPost.time : `${o.postIndex * 2}m`;
  groundPost(rng, post, o);
  post.regenerated = true;
  return post;
}
