// Port of worker/tasks/persona_tasks.py generate_feed and its helpers (W §6).
import type { Logger } from 'pino';
import type { Sql } from '../db/sql.js';
import { classifyContradiction, generatePersonaPost } from '../feed/llmPost.js';
import {
  loadPersonas,
  planFeedPosts,
  POST_TYPE_WEIGHTS,
  resolveEnabledPersonas,
  systemPrompts,
  type PlanOptions,
} from '../feed/personas.js';
import { buildPostPrompt } from '../feed/prompts.js';
import {
  countEmbedModelMismatch,
  DEFAULT_RETRIEVAL_QUERY,
  retrievalQueries,
  retrieveForPersona,
  type RetrievalCtx,
} from '../feed/retrieval.js';
import {
  commitBudget,
  filterByBudget,
  finishPost,
  paperCap,
  pickFigure,
  priorPostsSummary,
  rotateWindow,
  seedBudget,
} from '../feed/slots.js';
import type { Chunk, Contradiction, FeedFigure, Post } from '../feed/types.js';
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings, type ProviderConfig } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { embedModelId, embedTexts } from '../providers/embed.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pySlice, pyStr } from '../shared/pystr.js';
import { choice, sample, type Rng } from '../shared/random.js';
import { uuid5 } from '../shared/uuid5.js';
import type { LocalStorage } from '../storage/local.js';
import type { WorkerDeps } from '../worker/handlers.js';

/** Persisted figure URLs are a short-lived fallback; the api re-signs on every feed read. */
export const FIGURE_URL_TTL_SECONDS = 60 * 60;

export type GenerateFeedData = {
  corpus_id?: string | null;
  tag_filter?: string[] | null;
  user_id?: string | null;
  num_posts?: number;
  append_to_feed_id?: string | null;
  tab_focus?: string | null;
  persona_key?: string | null;
};

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errType = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Python truthiness for the JSON values read here. */
const truthy = (v: unknown): boolean =>
  !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));

/**
 * `_get_paper_ids_for_corpus`: complete papers in scope, every branch scoped to `userId` so another user's
 * same-named tags, papers in the corpus, or complete papers never join in.
 */
export async function getPaperIdsForCorpus(
  sql: Sql,
  corpusId: string | null | undefined,
  tagFilter: string[] | null | undefined,
  userId: string,
): Promise<string[]> {
  let rows;
  if (tagFilter && tagFilter.length > 0) {
    rows = await sql`
      SELECT DISTINCT p.id FROM papers p
      JOIN paper_tags pt ON p.id = pt.paper_id
      JOIN tags t ON pt.tag_id = t.id
      WHERE t.name = ANY(${tagFilter}::text[])
        AND p.status = 'complete'
        AND p.user_id = ${userId}
        AND t.user_id = ${userId}`;
  } else if (corpusId) {
    rows = await sql`SELECT id FROM papers WHERE corpus_id = ${corpusId} AND status = 'complete' AND user_id = ${userId}`;
  } else {
    rows = await sql`SELECT id FROM papers WHERE status = 'complete' AND user_id = ${userId}`;
  }
  return rows.map((r) => String(r.id));
}

export type TabOverrides = { personas: Set<string>; post_weights: Record<string, number> };

/** `_get_tab_overrides`: persona and post-type weight overrides for a tab, or null for an unknown tab. */
export function tabOverrides(tab: string, enabled: Set<string>): TabOverrides | null {
  const intersect = (keys: string[]) => {
    const both = new Set(keys.filter((k) => enabled.has(k)));
    return both.size > 0 ? both : enabled;
  };
  if (tab === 'debates') {
    return { personas: enabled, post_weights: { post: 0.1, thread: 0.05, quote: 0.4, reply: 0.4, figure: 0.05 } };
  }
  if (tab === 'methods') {
    return {
      personas: intersect(['skeptic', 'methodologist']),
      post_weights: { post: 0.4, thread: 0.35, quote: 0.1, reply: 0.1, figure: 0.05 },
    };
  }
  if (tab === 'findings') {
    return {
      personas: intersect(['hype', 'practitioner']),
      post_weights: { post: 0.35, thread: 0.15, quote: 0.15, reply: 0.1, figure: 0.25 },
    };
  }
  return null;
}

/**
 * `_detect_contradictions`: classify up to `maxPairs` random cross-paper chunk pairs, serially. Keeps the
 * contradicts/supports pairs, or the first two of any when there are none. A failed pair is logged and skipped,
 * unless the job was aborted.
 */
export async function detectContradictions(
  rng: Rng,
  providers: ProviderConfig,
  deps: ProviderDeps,
  chunks: Chunk[],
  opts: { maxPairs?: number; signal?: AbortSignal; logger: Logger },
): Promise<Contradiction[]> {
  const maxPairs = opts.maxPairs ?? 5;
  const byPaper = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const pid = pyStr(c.paper_id);
    const list = byPaper.get(pid);
    if (list) list.push(c);
    else byPaper.set(pid, [c]);
  }
  if (byPaper.size < 2) return [];

  const paperIds = [...byPaper.keys()];
  const pairs: [Chunk, Chunk][] = [];
  for (let i = 0; i < maxPairs * 3; i++) {
    if (pairs.length >= maxPairs) break;
    const [pidA, pidB] = sample(rng, paperIds, 2) as [string, string];
    pairs.push([choice(rng, byPaper.get(pidA)!), choice(rng, byPaper.get(pidB)!)]);
  }

  const out: Contradiction[] = [];
  for (const [a, b] of pairs.slice(0, maxPairs)) {
    try {
      const relationship = await classifyContradiction(
        providers,
        deps,
        pyStr(a.content),
        pyStr(b.content),
        opts.signal,
        opts.logger,
      );
      out.push({
        paper_a: a.paper_title || a.paper_filename || null,
        paper_b: b.paper_title || b.paper_filename || null,
        content_a: pyStr(a.content),
        content_b: pyStr(b.content),
        relationship,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      opts.logger.warn({ error_type: errType(e), error: pySlice(errMessage(e), 0, 200) }, 'contradiction_classify_failed');
    }
  }

  const interesting = out.filter((c) => c.relationship === 'contradicts' || c.relationship === 'supports');
  opts.logger.info({ total_pairs: pairs.length, interesting: interesting.length }, 'contradictions_detected');
  return interesting.length > 0 ? interesting : out.slice(0, 2);
}

/**
 * `_write_feed_posts_index`: upsert a slice of posts into the feed_posts search index in one statement. Scalar
 * columns are computed here; `data` is each element of the slice's jsonb array, so it is stored as an object.
 */
export async function writeFeedPostsIndex(
  sql: Sql,
  feedId: string,
  posts: Post[],
  baseIndex: number,
  userId: string,
): Promise<void> {
  if (posts.length === 0) return;
  // asyncpg would reject a non-string for a TEXT column; coercing keeps the index in step instead.
  const text = (v: unknown): string | null => (v === undefined || v === null ? null : pyStr(v));
  const contents = posts.map((p) => pyStr(Object.hasOwn(p, 'content') ? p.content : ''));
  const personas = posts.map((p) => text(p.persona));
  const postTypes = posts.map((p) => text(p.post_type));
  const categories = posts.map((p) => text(p.category));
  const paperRefs = posts.map((p) => text(p.paper_ref));
  const deleted = posts.map((p) => truthy(p.deleted));
  await sql`
    INSERT INTO feed_posts
      (feed_id, user_id, post_index, content_text, persona, post_type, category, paper_ref, data, deleted)
    SELECT ${feedId}::uuid, ${userId}::uuid, ${baseIndex}::int + (r.ord - 1)::int,
           r.content_text, r.persona, r.post_type, r.category, r.paper_ref, d.value, r.deleted
    FROM unnest(${contents}::text[], ${personas}::text[], ${postTypes}::text[], ${categories}::text[],
                ${paperRefs}::text[], ${deleted}::bool[])
           WITH ORDINALITY AS r(content_text, persona, post_type, category, paper_ref, deleted, ord),
         jsonb_array_elements(${sql.json(posts as never)}) WITH ORDINALITY AS d(value, ord)
    WHERE d.ord = r.ord
    ON CONFLICT (feed_id, post_index) DO UPDATE SET
      content_text = EXCLUDED.content_text,
      persona = EXCLUDED.persona,
      post_type = EXCLUDED.post_type,
      category = EXCLUDED.category,
      paper_ref = EXCLUDED.paper_ref,
      data = EXCLUDED.data,
      deleted = EXCLUDED.deleted`;
}

type FigureRow = {
  id: string;
  paper_id: string;
  page_number: number;
  description: string | null;
  claim_summary: string | null;
  figure_index: number | null;
  figure_type: string | null;
  caption: string | null;
  figure_number: string | null;
  data_claim: string | null;
  referenced_paragraph: string | null;
  detector_confidence: number | null;
  paper_filename: string | null;
  paper_title: string | null;
};

/** The storage seam the figure loaders need. */
export type FigureUrlSigner = Pick<LocalStorage, 'figureImageUrl'>;

/** The figure SELECT generate_feed runs (persona_tasks.py:445-457), without its WHERE. */
const figureSelect = (sql: Sql) => sql`
  SELECT f.id, f.paper_id, f.page_number, f.image_path,
         f.description, f.claim_summary, f.figure_index,
         f.figure_type, f.caption, f.figure_number,
         f.data_claim, f.referenced_paragraph,
         f.detector_confidence,
         p.user_id AS paper_user_id,
         p.filename AS paper_filename, p.title AS paper_title
  FROM figures f JOIN papers p ON f.paper_id = p.id`;

/** The FeedFigure dict (persona_tasks.py:458-486); `image_url` is signed for FIGURE_URL_TTL_SECONDS. */
function toFeedFigure(storage: FigureUrlSigner, r: FigureRow): FeedFigure {
  return {
    id: String(r.id),
    paper_id: String(r.paper_id),
    page_number: r.page_number,
    image_url: storage.figureImageUrl(String(r.paper_id), String(r.id), FIGURE_URL_TTL_SECONDS),
    description: r.description || '',
    claim_summary: r.claim_summary || '',
    figure_index: r.figure_index,
    paper_ref: r.paper_title || r.paper_filename,
    figure_type: r.figure_type,
    caption: r.caption || '',
    figure_number: r.figure_number || '',
    data_claim: r.data_claim || '',
    referenced_paragraph: r.referenced_paragraph || '',
    detector_confidence: r.detector_confidence,
  };
}

/**
 * Every figure of the in-scope papers. A figure without a type (pre-typed-extraction row) is kept here but is never
 * routed to a persona (pickFigure).
 */
export async function loadFigures(sql: Sql, storage: FigureUrlSigner, paperIds: string[]): Promise<FeedFigure[]> {
  const rows = await sql<FigureRow[]>`${figureSelect(sql)} WHERE f.paper_id = ANY(${paperIds}::uuid[])`;
  return rows.map((r) => toFeedFigure(storage, r));
}

/** One figure by id, only when its paper belongs to `ownerId` (for regenerate_post's figure posts); else null. */
export async function loadOwnedFigure(
  sql: Sql,
  storage: FigureUrlSigner,
  figureId: string,
  ownerId: string,
): Promise<FeedFigure | null> {
  const [row] = await sql<FigureRow[]>`${figureSelect(sql)} WHERE f.id = ${figureId} AND p.user_id = ${ownerId}`;
  return row ? toFeedFigure(storage, row) : null;
}

/**
 * The full feed pipeline: idempotency guard, settings, scope, retrieval, figures, contradictions, the planned
 * per-slot generation, persist, index, fan-out. Provider settings are resolved once for the owner and passed to
 * every call; `ctx.signal` reaches every provider call and is checked between slots, so an aborted job throws.
 */
export async function generateFeed(
  data: GenerateFeedData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql, config, rng } = deps;
  const signal = ctx.signal;
  const owner = data.user_id || STUB_USER_ID;
  const appendTo = data.append_to_feed_id || null;
  const requestedPersona = data.persona_key || null;
  const tabFocus = data.tab_focus || null;

  // --- Step 0: feed id and idempotency (same pg-boss job id on every retry) ---
  let feedId: string;
  let existingPosts: Post[] = [];
  if (appendTo) {
    feedId = appendTo;
    const [row] = await sql`SELECT posts FROM feeds WHERE id = ${feedId} AND user_id = ${owner}`;
    // Deliberate change 7 from Python: a feed the owner doesn't have fails here, before any LLM spend.
    if (!row) throw new Error(`Feed ${feedId} not found`);
    if (truthy(row.posts)) {
      existingPosts = (typeof row.posts === 'string' ? JSON.parse(row.posts) : row.posts) as Post[];
    }
    if (existingPosts.some((p) => isDict(p) && p._task_id === ctx.jobId)) {
      ctx.logger.info(
        { feed_id: feedId, task_id: ctx.jobId, existing_post_count: existingPosts.length },
        'generate_feed_idempotent_skip',
      );
      return { feed_id: feedId, post_count: existingPosts.length, duration_ms: 0, idempotent: true };
    }
  } else {
    feedId = uuid5(`ficino:feed:${ctx.jobId}`);
    const [existing] = await sql`SELECT post_count FROM feeds WHERE id = ${feedId} AND user_id = ${owner}`;
    if (existing && existing.post_count) {
      ctx.logger.info(
        { feed_id: feedId, task_id: ctx.jobId, existing_post_count: existing.post_count },
        'generate_feed_idempotent_skip',
      );
      return { feed_id: feedId, post_count: existing.post_count, duration_ms: 0, idempotent: true };
    }
  }
  const log = ctx.logger.child({ feed_id: feedId, task_id: ctx.jobId, append: Boolean(appendTo) });
  const startTime = Date.now();
  const progress = (meta: Record<string, unknown> = {}) => ctx.progress({ step: 'generating', feed_id: feedId, ...meta });

  try {
    // --- Settings: one frozen config for the owner, used by every call below ---
    const { settings, providers } = await loadJobSettings(sql, owner, deps.env, config);
    const personas = await loadPersonas(sql);
    let numPosts = data.num_posts ?? 12;
    // posts_per_generation applies to normal feeds, not to persona-scoped "Get their take" requests.
    if (!requestedPersona && Object.hasOwn(settings, 'posts_per_generation')) {
      numPosts = settings.posts_per_generation as number;
    }
    let enabled = resolveEnabledPersonas(settings, personas);
    const temperature = (Object.hasOwn(settings, 'persona_temperature') ? settings.persona_temperature : 0.8) as number;
    let postWeights = (
      Object.hasOwn(settings, 'post_type_weights') ? settings.post_type_weights : POST_TYPE_WEIGHTS
    ) as Record<string, number> | null;
    const preferences = (settings.preferences ?? null) as
      | (NonNullable<PlanOptions['preferences']> & { liked_paper_titles?: string[] | null })
      | null;

    if (requestedPersona) {
      enabled = new Set([requestedPersona]);
      // Threads favored, some quotes and posts, no replies (nothing to reply to), no figures.
      postWeights = { thread: 0.6, quote: 0.25, post: 0.15, reply: 0.0, figure: 0.0 };
      log.info({ persona: requestedPersona, num_posts: numPosts, weights: postWeights }, 'persona_scoped_generation');
    }

    let tabCategory: string | null = null;
    if (tabFocus) {
      tabCategory = tabFocus;
      const overrides = tabOverrides(tabFocus, enabled);
      if (overrides) {
        enabled = overrides.personas;
        postWeights = overrides.post_weights;
        log.info({ tab: tabFocus, personas: [...enabled], weights: postWeights }, 'tab_focus_applied');
      }
    }
    log.info({ num_posts: numPosts, personas: [...enabled], temperature, tab_focus: tabFocus }, 'settings_loaded');

    // --- Step 1: scope papers ---
    await progress({ step: 'scoping' });
    log.info({ step: 'scoping' }, 'feed_step');
    const paperIds = await getPaperIdsForCorpus(sql, data.corpus_id, data.tag_filter, owner);
    if (paperIds.length === 0) {
      log.warn('no_papers_found');
      // A redelivered empty feed is not caught by the post_count guard: never duplicate or error.
      await sql`
        INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)
        VALUES (${feedId}, ${owner}, ${data.corpus_id ?? null}, ${data.tag_filter ?? null}, ${sql.json([])}, ${0}, ${0}, ${0})
        ON CONFLICT (id) DO NOTHING`;
      return { status: 'complete', feed_id: feedId, post_count: 0 };
    }

    // --- Step 2: retrieval ---
    signal.throwIfAborted();
    await progress({ step: 'retrieving' });
    log.info({ step: 'retrieving', papers: paperIds.length }, 'feed_step');
    const model = embedModelId(providers);
    const mismatched = await countEmbedModelMismatch(sql, paperIds, model);
    if (mismatched > 0) log.warn({ expected: model, excluded_chunks: mismatched }, 'embed_model_mismatch');

    const rctx: RetrievalCtx = { sql, config, providers, deps: deps.providers, logger: log, signal };
    const liked =
      preferences && truthy(preferences.has_signal) ? (preferences.liked_paper_titles ?? undefined) : undefined;
    const active = [...personas.keys()].filter((k) => enabled.has(k));
    const queries = retrievalQueries(personas);
    let queryEmbeddings = new Map<string, number[]>();
    try {
      const vectors = await embedTexts(
        providers,
        deps.providers,
        active.map((k) => queries.get(k) ?? DEFAULT_RETRIEVAL_QUERY),
        { inputType: 'query', signal },
      );
      queryEmbeddings = new Map(active.map((k, i) => [k, vectors[i]!]));
    } catch (e) {
      if (signal.aborted) throw e;
      // Each persona embeds its own query inside retrieval instead.
      log.warn({ error: errMessage(e) }, 'persona_query_batch_embed_failed');
    }

    const allChunks = new Map<string, Chunk[]>();
    for (const key of active) {
      const chunks = await retrieveForPersona(rctx, personas, {
        personaKey: key,
        paperIds,
        topK: 10,
        likedPaperTitles: liked,
        queryEmbedding: queryEmbeddings.get(key),
      });
      allChunks.set(key, chunks);
      log.info({ persona: key, chunks: chunks.length }, 'persona_chunks_retrieved');
    }
    const flatChunks: Chunk[] = [];
    const seenIds = new Set<string>();
    for (const chunks of allChunks.values()) {
      for (const c of chunks) {
        if (!seenIds.has(c.id)) {
          flatChunks.push(c);
          seenIds.add(c.id);
        }
      }
    }

    const figures = await loadFigures(sql, deps.storage, paperIds);
    log.info({ count: figures.length, typed: figures.filter((f) => f.figure_type).length }, 'figures_available');

    // --- Step 3: contradictions ---
    signal.throwIfAborted();
    await progress({ step: 'classifying' });
    log.info({ step: 'classifying' }, 'feed_step');
    const contradictions =
      paperIds.length > 1
        ? await detectContradictions(rng, providers, deps.providers, flatChunks, { signal, logger: log })
        : [];

    // --- Step 4: generate posts ---
    signal.throwIfAborted();
    await progress();
    log.info({ step: 'generating', planned_posts: numPosts }, 'feed_step');
    const prompts = systemPrompts(personas);
    const plan = planFeedPosts(rng, personas, { numPosts, enabled, customWeights: postWeights, preferences });
    const posts: Post[] = [];
    const allFeedPosts = [...existingPosts];
    const idOffset = existingPosts.length;
    const timeOffset = existingPosts.length * 2;

    const slotCounts = new Map<string, number>();
    for (const a of plan) slotCounts.set(a.persona, (slotCounts.get(a.persona) ?? 0) + 1);
    const slotCursor = new Map<string, number>();
    // Feed-level chunk budget, seeded from existing posts so appended posts stake out new material.
    const budget = seedBudget(allFeedPosts);
    const cap = paperCap(numPosts, allChunks);

    for (const [i, { persona: slotPersona, post_type: postType }] of plan.entries()) {
      signal.throwIfAborted();
      await progress({ post_progress: `${i + 1}/${numPosts}` });
      const systemPrompt = prompts.get(slotPersona) ?? `You are ${slotPersona}`;
      let chunks = allChunks.get(slotPersona) ?? [];
      if (chunks.length === 0) {
        log.warn({ persona: slotPersona }, 'no_chunks_for_persona');
        continue;
      }

      // Each of a persona's slots sees a different window of its chunks.
      const slotIndex = slotCursor.get(slotPersona) ?? 0;
      slotCursor.set(slotPersona, slotIndex + 1);
      chunks = rotateWindow(chunks, slotCounts.get(slotPersona)!, slotIndex);

      const overRepresented = new Set<string>();
      for (const [pid, n] of budget.paperPostCounts) if (n >= cap) overRepresented.add(pid);
      const preCount = chunks.length;
      let filtered = filterByBudget(chunks, budget, cap);
      let reRetrieved = false;
      if (filtered.length < 5 && budget.usedChunkIds.size > 0) {
        try {
          const fresh = await retrieveForPersona(rctx, personas, {
            personaKey: slotPersona,
            paperIds,
            topK: 10,
            likedPaperTitles: liked,
            queryEmbedding: queryEmbeddings.get(slotPersona),
            excludeChunkIds: [...budget.usedChunkIds],
          });
          let freshFiltered = fresh.filter((c) => !overRepresented.has(String(c.paper_id)));
          if (freshFiltered.length < 3) freshFiltered = [...fresh];
          if (freshFiltered.length >= filtered.length) {
            filtered = freshFiltered;
            reRetrieved = true;
          }
        } catch (e) {
          if (signal.aborted) throw e;
          log.warn({ persona: slotPersona, error: errMessage(e) }, 're_retrieve_failed');
        }
      }
      log.info(
        {
          persona: slotPersona,
          available_count: filtered.length,
          pre_exclusion_count: preCount,
          excluded_count: budget.usedChunkIds.size,
          over_rep_papers: overRepresented.size,
          re_retrieved: reRetrieved,
        },
        'persona_chunks_after_exclusion',
      );
      if (filtered.length === 0) {
        log.info({ persona: slotPersona }, 'slot_skipped_no_fresh_chunks');
        continue;
      }
      chunks = filtered;

      // A figure slot needs a figure of a type this persona may post about; otherwise the slot is dropped.
      const meta = personas.get(slotPersona);
      const picked = pickFigure(rng, figures, meta, postType);
      if (picked === 'skip') {
        if (figures.length === 0) {
          log.info({ persona: slotPersona }, 'figure_post_skipped_no_figures_in_paper');
        } else {
          const types = figures.map((f) => f.figure_type).filter((t): t is string => truthy(t));
          log.info(
            {
              persona: slotPersona,
              allowed: [...new Set(meta?.allowed_figure_types ?? [])],
              available_types: [...new Set(types)].sort(),
            },
            'figure_post_skipped_no_eligible_figure',
          );
        }
        continue;
      }
      const figure = picked;

      // Soft-deleted posts are never quoted (that would resurrect hidden content) or summarized.
      const isResponse = postType === 'quote' || postType === 'reply';
      const priorPosts = [...allFeedPosts, ...posts];
      const summary = priorPostsSummary(priorPosts, personas);
      // Outside the per-slot try, as in Python: a throw here fails the job.
      const userPrompt = await buildPostPrompt({
        rng,
        sql,
        personas,
        personaKey: slotPersona,
        postType,
        chunks,
        contradictions: isResponse ? contradictions : undefined,
        existingPosts: isResponse ? priorPosts.filter((p) => !truthy(p.deleted)) : undefined,
        figure,
        priorPostsSummary: summary.length > 0 ? summary : undefined,
      });

      try {
        const personaTemp = meta?.temperature ?? null;
        const raw = await generatePersonaPost(providers, deps.providers, {
          system: systemPrompt,
          user: userPrompt,
          temperature: personaTemp !== null ? personaTemp : temperature,
          signal,
        });
        const post = finishPost(rng, raw, {
          personaKey: slotPersona,
          postType,
          chunks,
          figure,
          idOffset,
          timeOffset,
          newCount: posts.length,
          jobId: ctx.jobId,
          tabCategory,
          personas,
          logger: log,
        });
        posts.push(post);
        // Load-bearing: the next slot's filter excludes what this post used.
        commitBudget(budget, post);
        log.info({ post: i + 1, persona: slotPersona, type: post.post_type }, 'post_generated');
      } catch (e) {
        if (signal.aborted) throw e;
        log.error({ persona: slotPersona, error: errMessage(e) }, 'post_generation_failed');
      }
    }

    // --- Step 5: store ---
    signal.throwIfAborted();
    const durationMs = Date.now() - startTime;
    const allPosts = [...existingPosts, ...posts];
    if (appendTo) {
      // Postgres does the concat, so two concurrent appends can't clobber each other's slice.
      await sql`
        UPDATE feeds
        SET posts = posts || ${sql.json(posts as never)}::jsonb,
            post_count = jsonb_array_length(posts || ${sql.json(posts as never)}::jsonb),
            generation_duration_ms = generation_duration_ms + ${durationMs}
        WHERE id = ${feedId} AND user_id = ${owner}`;
    } else {
      // A conflict here is a redelivery of this same job (uuid5 of the job id): replacing the content recovers
      // an empty first attempt instead of losing the new posts.
      await sql`
        INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)
        VALUES (${feedId}, ${owner}, ${data.corpus_id ?? null}, ${data.tag_filter ?? null}, ${sql.json(allPosts as never)},
                ${paperIds.length}, ${allPosts.length}, ${durationMs})
        ON CONFLICT (id) DO UPDATE SET
          posts = EXCLUDED.posts,
          paper_count = EXCLUDED.paper_count,
          post_count = EXCLUDED.post_count,
          generation_duration_ms = EXCLUDED.generation_duration_ms`;
    }

    // feeds.posts is the source of truth; the index is best-effort and can be backfilled.
    try {
      await writeFeedPostsIndex(sql, feedId, posts, appendTo ? existingPosts.length : 0, owner);
    } catch (e) {
      log.warn(
        { error_type: errType(e), error: pySlice(errMessage(e), 0, 200) },
        'feed_posts_index_sync_failed',
      );
    }
    log.info(
      { posts: posts.length, papers: paperIds.length, duration_ms: durationMs },
      'feed_generation_complete',
    );

    // --- Fan-out (never fails the job) ---
    try {
      await deps.queue.send('check_post_feed', { feed_id: feedId });
    } catch (e) {
      log.warn({ error_type: errType(e), error: pySlice(errMessage(e), 0, 200) }, 'post_feed_alert_dispatch_failed');
    }
    try {
      await deps.queue.send('compute_preferences', { user_id: owner });
    } catch (e) {
      log.warn({ error_type: errType(e), error: pySlice(errMessage(e), 0, 200) }, 'preference_recompute_dispatch_failed');
    }

    return {
      status: 'complete',
      feed_id: feedId,
      post_count: allPosts.length,
      paper_count: paperIds.length,
      duration_ms: durationMs,
    };
  } catch (e) {
    log.error({ error: errMessage(e) }, 'feed_generation_failed');
    throw e;
  }
}
