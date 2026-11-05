// Port of worker/tasks/persona_tasks.py regenerate_post (:942-1070), with figure posts fixed (deliberate change 1).
import type { JobContext } from '../jobs/context.js';
import { loadPersonas, systemPrompts } from '../feed/personas.js';
import { generatePersonaPost } from '../feed/llmPost.js';
import { buildPostPrompt } from '../feed/prompts.js';
import { countEmbedModelMismatch, retrieveForPersona, type RetrievalCtx } from '../feed/retrieval.js';
import { finishRegeneratedPost } from '../feed/slots.js';
import type { FeedFigure, Post } from '../feed/types.js';
import { loadJobSettings } from '../providers/config.js';
import { embedModelId } from '../providers/embed.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pySlice } from '../shared/pystr.js';
import type { WorkerDeps } from '../worker/handlers.js';
import { getPaperIdsForCorpus, loadOwnedFigure, writeFeedPostsIndex } from './feed.js';

export type RegeneratePostData = { feed_id: string; post_index: number; user_id?: string | null };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errType = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/**
 * Replace one post of an existing feed in place: same persona, same id and time, fresh chunks and text. A figure
 * post is regenerated about its own figure (owner-scoped); if that figure is gone it becomes a plain post prompt.
 */
export async function regeneratePost(
  data: RegeneratePostData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<{ status: 'complete'; feed_id: string; post_index: number }> {
  const { sql, config, rng } = deps;
  const signal = ctx.signal;
  const feedId = data.feed_id;
  const postIndex = data.post_index;
  const owner = data.user_id || STUB_USER_ID;
  const log = ctx.logger.child({ feed_id: feedId, post_index: postIndex });
  log.info('regenerate_post_start');

  const { settings, providers } = await loadJobSettings(sql, owner, deps.env, config);
  const temperature = (Object.hasOwn(settings, 'persona_temperature') ? settings.persona_temperature : 0.8) as number;

  // Scoped by user_id so a task dispatched for one user can't touch another's feed.
  const [row] = await sql`SELECT posts, corpus_id FROM feeds WHERE id = ${feedId} AND user_id = ${owner}`;
  if (!row) throw new Error(`Feed ${feedId} not found`);
  const posts = (typeof row.posts === 'string' ? JSON.parse(row.posts) : row.posts) as Post[];
  if (postIndex < 0 || postIndex >= posts.length) {
    throw new Error(`Post index ${postIndex} out of range (feed has ${posts.length} posts)`);
  }

  const oldPost = posts[postIndex]!;
  const personaKey = oldPost.persona;
  const oldType = Object.hasOwn(oldPost, 'post_type') ? oldPost.post_type : 'post';
  const corpusId = row.corpus_id ? String(row.corpus_id) : null;
  if (!personaKey || typeof personaKey !== 'string') {
    throw new Error(`Post at feed ${feedId} index ${postIndex} has no persona — cannot regenerate`);
  }

  const paperIds = await getPaperIdsForCorpus(sql, corpusId, null, owner);
  if (paperIds.length === 0) throw new Error('No papers in corpus');

  const personas = await loadPersonas(sql);
  const model = embedModelId(providers);
  const mismatched = await countEmbedModelMismatch(sql, paperIds, model);
  if (mismatched > 0) log.warn({ expected: model, excluded_chunks: mismatched }, 'embed_model_mismatch');

  const rctx: RetrievalCtx = { sql, config, providers, deps: deps.providers, logger: log, signal };
  const chunks = await retrieveForPersona(rctx, personas, { personaKey, paperIds, topK: 10 });
  if (chunks.length === 0) throw new Error(`No chunks retrieved for persona ${personaKey}`);

  // A quote or reply is regenerated standalone, as a plain post.
  let postType = oldType === 'thread' || oldType === 'figure' ? (oldType as string) : 'post';
  let figure: FeedFigure | null = null;
  if (postType === 'figure') {
    const figureId = oldPost.figure_id;
    figure = typeof figureId === 'string' && figureId ? await loadOwnedFigure(sql, deps.storage, figureId, owner) : null;
    if (!figure) {
      log.info({ figure_id: figureId ?? null }, 'regenerate_figure_missing');
      postType = 'post';
    }
  }

  const systemPrompt = systemPrompts(personas).get(personaKey) ?? `You are ${personaKey}`;
  const userPrompt = await buildPostPrompt({ rng, sql, personas, personaKey, postType, chunks, figure });
  const personaTemp = personas.get(personaKey)?.temperature ?? null;
  const raw = await generatePersonaPost(providers, deps.providers, {
    system: systemPrompt,
    user: userPrompt,
    temperature: personaTemp !== null ? personaTemp : temperature,
    signal,
  });
  const post = finishRegeneratedPost(rng, raw, {
    personaKey,
    postType,
    chunks,
    figure,
    tabCategory: null,
    oldPost,
    postIndex,
    logger: log,
  });

  // Atomic jsonb_set so a concurrent regenerate or append doesn't lose the other's write.
  await sql`
    UPDATE feeds
    SET posts = jsonb_set(posts, ARRAY[${String(postIndex)}::text], ${sql.json(post as never)}::jsonb, false)
    WHERE id = ${feedId} AND user_id = ${owner}`;

  try {
    await writeFeedPostsIndex(sql, feedId, [post], postIndex, owner);
  } catch (e) {
    log.warn(
      { error_type: errType(e), error: pySlice(errMessage(e), 0, 200) },
      'feed_posts_index_sync_failed',
    );
  }
  log.info({ persona: personaKey, post_type: oldType }, 'regenerate_post_complete');
  return { status: 'complete', feed_id: feedId, post_index: postIndex };
}
