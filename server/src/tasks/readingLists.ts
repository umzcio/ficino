// Port of worker/tasks/reading_list_tasks.py: propose_ordering and generate_chapter (W §2.8).
import { generatePersonaPost } from '../feed/llmPost.js';
import {
  loadPersonas,
  planFeedPosts,
  POST_TYPE_WEIGHTS,
  resolveEnabledPersonas,
  systemPrompts,
  type PlanOptions,
} from '../feed/personas.js';
import { buildPostPrompt } from '../feed/prompts.js';
import { assertEmbedModelScope, retrieveForPersona, type RetrievalCtx } from '../feed/retrieval.js';
import { pickFigure } from '../feed/slots.js';
import type { Chunk, Post } from '../feed/types.js';
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings } from '../providers/config.js';
import { embedModelId } from '../providers/embed.js';
import { generateText } from '../providers/llm.js';
import { chapterContext, chapterScope, finishChapterPost, promptPostType } from '../readingLists/chapter.js';
import { insertChapters } from '../readingLists/chapters.js';
import {
  ORDERING_USER,
  orderingContext,
  orderingSystemPrompt,
  parseOrderingJson,
  validateOrdering,
  type OrderingRow,
} from '../readingLists/ordering.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pySlice } from '../shared/pystr.js';
import { isUuid } from '../shared/uuid.js';
import { uuid5 } from '../shared/uuid5.js';
import { loadFigures, writeFeedPostsIndex } from './feed.js';
import type { WorkerDeps } from '../worker/handlers.js';

export type ProposeOrderingData = { paper_ids: string[]; list_id?: string | null; user_id?: string | null };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errType = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/**
 * Ask the Archivist for a reading order and, with a `list_id`, persist it: the sequence, the rationale and the
 * chapters rebuilt from scratch, in one transaction. A throw is retried by pg-boss; nothing writes a failure status.
 */
export async function proposeOrdering(
  data: ProposeOrderingData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const paperIds = data.paper_ids;
  const listId = data.list_id ?? null;
  const log = ctx.logger.child({ paper_count: paperIds.length, list_id: listId, task_id: ctx.jobId });
  log.info('propose_ordering_start');
  const start = Date.now();

  try {
    // Bill the requesting user's provider settings.
    const { providers } = await loadJobSettings(sql, data.user_id || STUB_USER_ID, deps.env, deps.config);

    // The first 5 chunks per paper in one query. ORDER BY array_position keeps the list's order for the prompt
    // and the id-mismatch fallback (Python had no ORDER BY: heap order).
    const rows = await sql<OrderingRow[]>`
      SELECT p.id, p.title, p.authors, p.year, p.filename,
             COALESCE(c.chunks, '{}') AS chunks
      FROM papers p
      LEFT JOIN LATERAL (
        SELECT array_agg(content ORDER BY chunk_index) AS chunks
        FROM (
          SELECT content, chunk_index FROM chunks
          WHERE paper_id = p.id
          ORDER BY chunk_index
          LIMIT 5
        ) s
      ) c ON true
      WHERE p.id = ANY(${paperIds}::uuid[])
      ORDER BY array_position(${paperIds}::uuid[], p.id)`;
    const papers = orderingContext([...rows]);

    if (papers.length === 0) return { ordered_papers: [], error: 'No papers found' };

    const raw = await generateText(providers, deps.providers, {
      system: orderingSystemPrompt(papers),
      user: ORDERING_USER,
      temperature: 0.3,
      maxTokens: 2048,
      signal: ctx.signal,
    });

    const { ordered, mismatch } = validateOrdering(papers, parseOrderingJson(raw));
    if (mismatch) log.warn(mismatch, 'propose_ordering_id_mismatch');

    const durationMs = Date.now() - start;

    if (listId) {
      const newSequence = ordered.map((p) => p.paper_id) as string[];
      await sql.begin(async (tx) => {
        await tx`
          UPDATE reading_lists SET paper_sequence = ${newSequence}::uuid[], rationale = ${sql.json(ordered as never)}
          WHERE id = ${listId}`;
        await tx`DELETE FROM reading_list_chapters WHERE reading_list_id = ${listId}`;
        await insertChapters(tx, listId, newSequence);
      });
      log.info({ list_id: listId }, 'propose_ordering_persisted');
    }

    log.info({ duration_ms: durationMs, papers: ordered.length }, 'propose_ordering_complete');
    return { ordered_papers: ordered, duration_ms: durationMs };
  } catch (e) {
    log.error({ error: errMessage(e) }, 'propose_ordering_failed');
    throw e;
  }
}

export type GenerateChapterData = { reading_list_id: string; chapter_index: number; user_id?: string | null };

type ListRow = { paper_sequence: string[]; corpus_id: string | null; user_id: string | null };
type ChapterRow = { id: string; paper_ids: string[]; status: string; feed_id: string | null };

/**
 * Generate the feed of one reading-list chapter, scoped to every paper up to and including the chapter's last
 * paper. Fixes the Python figure-slot bug (deliberate change 1): a `figure` slot gets a figure or is dropped. The
 * feed upsert, the complete mark and the next chapter's unlock commit together (deliberate change 3); the
 * feed_posts index follows and is non-fatal. A throw is retried by pg-boss; nothing writes a failure status.
 */
export async function generateChapter(
  data: GenerateChapterData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql, config, rng } = deps;
  const signal = ctx.signal;
  const listId = data.reading_list_id;
  const chapterIndex = data.chapter_index;
  const log = ctx.logger.child({ reading_list_id: listId, chapter_index: chapterIndex, task_id: ctx.jobId });
  log.info('generate_chapter_start');

  try {
    // No user scope, as in Python: the API checked ownership before dispatch.
    const [rl] = isUuid(listId)
      ? await sql<ListRow[]>`SELECT paper_sequence, corpus_id, user_id FROM reading_lists WHERE id = ${listId}`
      : [];
    if (!rl) throw new Error(`Reading list ${listId} not found`);

    // Deliberate change 4: a NULL list owner falls back to the stub user (Python made it the string "None").
    const owner = data.user_id || (rl.user_id ? String(rl.user_id) : null) || STUB_USER_ID;

    const [chapter] = await sql<ChapterRow[]>`
      SELECT id, paper_ids, status, feed_id FROM reading_list_chapters
      WHERE reading_list_id = ${listId} AND chapter_index = ${chapterIndex}`;
    if (!chapter) throw new Error(`Chapter ${chapterIndex} not found`);

    // A prior run (or this job's earlier attempt) already produced posts: skip the LLM spend.
    if (chapter.feed_id) {
      const [existing] = await sql`SELECT id, post_count FROM feeds WHERE id = ${chapter.feed_id} AND user_id = ${owner}`;
      if (existing && (existing.post_count || 0) > 0) {
        log.info({ feed_id: String(existing.id), post_count: existing.post_count }, 'generate_chapter_idempotent_skip');
        return { status: 'complete', feed_id: String(existing.id), post_count: existing.post_count, idempotent: true };
      }
    }

    const sequence = rl.paper_sequence.map(String);
    const chapterPaperIds = chapter.paper_ids.map(String);
    const cumulative = chapterScope(sequence, chapterPaperIds);
    log.info({ chapter_papers: chapterPaperIds.length, cumulative_papers: cumulative.length }, 'chapter_scope');

    // Deterministic per (list, chapter), so a retry upserts the same row instead of orphaning one.
    const feedId = uuid5(`ficino:chapter:${listId}:${chapterIndex}`);

    const { settings, providers } = await loadJobSettings(sql, owner, deps.env, config);
    const personas = await loadPersonas(sql);
    const numPosts = (Object.hasOwn(settings, 'posts_per_generation') ? settings.posts_per_generation : 12) as number;
    const enabled = resolveEnabledPersonas(settings, personas);
    const temperature = (Object.hasOwn(settings, 'persona_temperature') ? settings.persona_temperature : 0.8) as number;
    const postWeights = (
      Object.hasOwn(settings, 'post_type_weights') ? settings.post_type_weights : POST_TYPE_WEIGHTS
    ) as Record<string, number> | null;
    const preferences = (settings.preferences ?? null) as PlanOptions['preferences'];

    // Deliberate change 2: a scope embedded only with another model fails loudly instead of an empty chapter.
    await assertEmbedModelScope(sql, cumulative, embedModelId(providers), log);

    // Retrieval from the cumulative papers only, persona by persona (no boost, exclusions or contradictions).
    const rctx: RetrievalCtx = { sql, config, providers, deps: deps.providers, logger: log, signal };
    const allChunks = new Map<string, Chunk[]>();
    for (const key of [...personas.keys()].filter((k) => enabled.has(k))) {
      allChunks.set(key, await retrieveForPersona(rctx, personas, { personaKey: key, paperIds: cumulative, topK: 10 }));
    }

    // Deliberate change 1: figure slots get a figure from the scope, or are dropped.
    const figures = await loadFigures(sql, deps.storage, cumulative);

    const plan = planFeedPosts(rng, personas, { numPosts, enabled, customWeights: postWeights, preferences });
    const prompts = systemPrompts(personas);
    const posts: Post[] = [];

    for (const [i, { persona, post_type: postType }] of plan.entries()) {
      signal.throwIfAborted();
      const chunks = allChunks.get(persona) ?? [];
      if (chunks.length === 0) continue;

      const meta = personas.get(persona);
      const picked = pickFigure(rng, figures, meta, postType);
      if (picked === 'skip') {
        if (figures.length === 0) {
          log.info({ persona }, 'figure_post_skipped_no_figures_in_paper');
        } else {
          const types = figures.map((f) => f.figure_type).filter((t): t is string => Boolean(t));
          log.info(
            { persona, allowed: [...new Set(meta?.allowed_figure_types ?? [])], available_types: [...new Set(types)].sort() },
            'figure_post_skipped_no_eligible_figure',
          );
        }
        continue;
      }
      const figure = picked;

      const system = (prompts.get(persona) ?? `You are ${persona}`) + chapterContext(chapterIndex);
      // Outside the slot try, as in Python: any other throw here (an unknown persona) fails the chapter.
      const user = await buildPostPrompt({
        rng,
        sql,
        personas,
        personaKey: persona,
        postType: promptPostType(postType),
        chunks,
        figure,
      });

      try {
        // The user's temperature only: Python's chapter path has no per-persona override.
        const raw = await generatePersonaPost(providers, deps.providers, { system, user, temperature, signal });
        posts.push(
          finishChapterPost(rng, raw, { personaKey: persona, plannedType: postType, slotIndex: i, chunks, figure, logger: log }),
        );
      } catch (e) {
        // Deliberate change 16: an abort fails the job, never one slot.
        if (signal.aborted) throw e;
        log.error({ error: errMessage(e) }, 'chapter_post_failed');
      }
    }

    // An abort during the last slot never commits the chapter.
    signal.throwIfAborted();
    const corpusId = rl.corpus_id ? String(rl.corpus_id) : null;
    // Deliberate change 3: the feed, the complete mark and the unlock commit together.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO feeds (id, user_id, corpus_id, posts, paper_count, post_count, generation_duration_ms)
        VALUES (${feedId}, ${owner}, ${corpusId}, ${sql.json(posts as never)}, ${cumulative.length}, ${posts.length}, ${0})
        ON CONFLICT (id) DO UPDATE SET
          posts = EXCLUDED.posts,
          paper_count = EXCLUDED.paper_count,
          post_count = EXCLUDED.post_count,
          generated_at = NOW()`;
      await tx`UPDATE reading_list_chapters SET feed_id = ${feedId}, status = 'complete' WHERE id = ${chapter.id}`;
      await tx`
        UPDATE reading_list_chapters SET status = 'unlocked'
        WHERE reading_list_id = ${listId} AND chapter_index = ${chapterIndex + 1} AND status = 'locked'`;
    });

    // feeds.posts is the source of truth; the index is best-effort and can be backfilled.
    try {
      await writeFeedPostsIndex(sql, feedId, posts, 0, owner);
    } catch (e) {
      log.warn(
        { feed_id: feedId, error_type: errType(e), error: pySlice(errMessage(e), 0, 200) },
        'feed_posts_index_sync_failed',
      );
    }

    log.info({ feed_id: feedId, posts: posts.length }, 'generate_chapter_complete');
    return { status: 'complete', feed_id: feedId, post_count: posts.length };
  } catch (e) {
    log.error({ error: errMessage(e) }, 'generate_chapter_failed');
    throw e;
  }
}
