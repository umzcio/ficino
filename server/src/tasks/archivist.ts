// Port of worker/tasks/archivist_tasks.py: respond_to_user_post and respond_to_user_post_followup (W §2.6).
import type { Logger } from 'pino';
import {
  ARCHIVIST_CONTEXT_SUFFIX,
  ARCHIVIST_SYSTEM_FALLBACK,
  archivistChunksText,
  EMPTY_CORPUS_FOLLOWUP_REPLY,
  EMPTY_CORPUS_REPLY,
  embedMismatchReply,
  followupUserPrompt,
  knownCitations,
  pyFormatChunks,
  validateCitations,
} from '../conversations/archivist.js';
import type { Sql } from '../db/sql.js';
import { buildPostSources, loadPersonas } from '../feed/personas.js';
import { countEmbedModelMismatch, countScopeChunks, retrieveChunks, type RetrievalCtx } from '../feed/retrieval.js';
import type { Post } from '../feed/types.js';
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings } from '../providers/config.js';
import { embedModelId } from '../providers/embed.js';
import { generateText } from '../providers/llm.js';
import { pyStr, pyStrip } from '../shared/pystr.js';
import type { WorkerDeps } from '../worker/handlers.js';

export type UserPostData = { user_post_id: string; corpus_id?: string | null };
export type UserPostFollowupData = { user_post_id: string };

type Reply = { role: 'archivist'; persona: 'archivist'; content: string };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const archivistReply = (content: string): Reply => ({ role: 'archivist', persona: 'archivist', content });

/** `_get_paper_ids`: the owner's complete papers, narrowed to the corpus when there is one. */
export async function getArchivistPaperIds(sql: Sql, ownerId: string, corpusId: string | null): Promise<string[]> {
  const [row] = corpusId
    ? await sql`
        SELECT array_agg(id::text) AS ids FROM papers
        WHERE corpus_id = ${corpusId} AND user_id = ${ownerId} AND status = 'complete'`
    : await sql`
        SELECT array_agg(id::text) AS ids FROM papers
        WHERE user_id = ${ownerId} AND status = 'complete'`;
  return (row?.ids as string[] | null | undefined) ?? [];
}

/** `_get_archivist_system_prompt` minus the format: the DB persona prompt, or the fallback, plus the suffix. */
async function archivistPromptTemplate(sql: Sql, log: Logger): Promise<string> {
  let body: string;
  try {
    const db = (await loadPersonas(sql)).get('archivist')?.system_prompt;
    if (db && pyStrip(pyStr(db))) body = String(db);
    else {
      log.warn('archivist_persona_prompt_missing_using_fallback');
      body = ARCHIVIST_SYSTEM_FALLBACK;
    }
  } catch (e) {
    // A DB blip degrades to the fallback rather than failing the task.
    log.warn({ error: errMessage(e) }, 'archivist_persona_prompt_load_failed');
    body = ARCHIVIST_SYSTEM_FALLBACK;
  }
  return body + ARCHIVIST_CONTEXT_SUFFIX;
}

type Mode = {
  /** Log event prefix: archivist_response / archivist_followup. */
  event: 'archivist_response' | 'archivist_followup';
  chunksEvent: string;
  hallucinatedEvent: string;
  emptyReply: string;
  /** Loads the row's query and user prompt, `null` when the turn is already answered, or throws. */
  turn(row: Record<string, unknown>): { query: string; userPrompt: string } | null;
  store(sql: Sql, userPostId: string, reply: Reply, sources: Post[]): Promise<unknown>;
};

/** `_store_reply`: replace replies and sources, mark complete. */
const storeReply = (sql: Sql, id: string, reply: Reply, sources: Post[]) =>
  sql`
    UPDATE user_posts SET replies = ${sql.json([reply] as never)}, sources = ${sql.json(sources as never)},
      status = 'complete'
    WHERE id = ${id}`;

/** `_append_reply`: append to replies, mark complete; sources stay attached to the first turn. */
const appendReply = (sql: Sql, id: string, reply: Reply) =>
  sql`
    UPDATE user_posts SET replies = replies || ${sql.json([reply] as never)}, status = 'complete'
    WHERE id = ${id}`;

const INITIAL: Mode = {
  event: 'archivist_response',
  chunksEvent: 'archivist_chunks_retrieved',
  hallucinatedEvent: 'archivist_hallucinated_citation',
  emptyReply: EMPTY_CORPUS_REPLY,
  turn: (row) => ({ query: pyStr(row.content), userPrompt: pyStr(row.content) }),
  store: storeReply,
};

const FOLLOWUP: Mode = {
  event: 'archivist_followup',
  chunksEvent: 'archivist_followup_chunks_retrieved',
  hallucinatedEvent: 'archivist_followup_hallucinated_citation',
  emptyReply: EMPTY_CORPUS_FOLLOWUP_REPLY,
  turn: (row) => {
    // The API appended a {role:'user'} turn before dispatch; anything else has nothing to answer.
    const replies = row.replies as Array<Record<string, unknown>> | null;
    const last = Array.isArray(replies) ? replies.at(-1) : undefined;
    // Deliberate change 11: a redelivery after this job's append committed has nothing left to do.
    if (last?.role === 'archivist') return null;
    if (!last || last.role !== 'user') throw new Error('No pending user turn in replies');
    if (!('content' in last)) throw new Error("KeyError: 'content'");
    return { query: pyStr(last.content), userPrompt: followupUserPrompt(pyStr(row.content), replies!) };
  },
  store: (sql, id, reply) => appendReply(sql, id, reply),
};

async function respond(
  mode: Mode,
  userPostId: string,
  argCorpusId: string | null,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql, config } = deps;
  const log = ctx.logger.child({ user_post_id: userPostId });
  log.info(`${mode.event}_start`);
  const start = Date.now();

  try {
    // Load the row first so provider settings are scoped to the post owner.
    const [row] =
      mode === INITIAL
        ? await sql`SELECT content, corpus_id, user_id FROM user_posts WHERE id = ${userPostId}`
        : await sql`SELECT content, replies, corpus_id, user_id FROM user_posts WHERE id = ${userPostId}`;
    if (!row) throw new Error(`User post ${userPostId} not found`);

    const turn = mode.turn(row);
    if (!turn) {
      log.info('archivist_followup_idempotent_skip');
      return { status: 'complete', user_post_id: userPostId, idempotent: true };
    }
    const { query, userPrompt } = turn;
    // str(row["user_id"]): an ownerless row queries as 'None' and fails on the uuid cast, as Python did.
    const owner = pyStr(row.user_id);
    const corpusId = row.corpus_id ? String(row.corpus_id) : argCorpusId;

    const { settings, providers } = await loadJobSettings(sql, owner, deps.env, config);
    const temperature = (settings.persona_temperature as number | null | undefined) ?? 0.8;

    const paperIds = await getArchivistPaperIds(sql, owner, corpusId);
    if (paperIds.length === 0) {
      await mode.store(sql, userPostId, archivistReply(mode.emptyReply), []);
      return { status: 'complete', user_post_id: userPostId };
    }

    // Deliberate change 5: a scope whose every chunk is on another embedding model gets a clear answer, not
    // "No relevant passages found".
    const model = embedModelId(providers);
    const mismatched = await countEmbedModelMismatch(sql, paperIds, model);
    if (mismatched > 0) log.warn({ expected: model, excluded_chunks: mismatched }, 'embed_model_mismatch');
    if (mismatched > 0 && mismatched === (await countScopeChunks(sql, paperIds))) {
      await mode.store(sql, userPostId, archivistReply(embedMismatchReply(model, mismatched)), []);
      return { status: 'complete', user_post_id: userPostId };
    }

    const rctx: RetrievalCtx = { sql, config, providers, deps: deps.providers, logger: log, signal: ctx.signal };
    const chunks = await retrieveChunks(rctx, { query, paperIds, topK: 15 });
    log.info({ chunks: chunks.length }, mode.chunksEvent);

    const system = pyFormatChunks(await archivistPromptTemplate(sql, log), archivistChunksText(chunks));
    const raw = await generateText(providers, deps.providers, {
      system,
      user: userPrompt,
      temperature,
      maxTokens: 1024,
      signal: ctx.signal,
    });

    // Strip "Author (YYYY)" citations no retrieved chunk grounds (all retrieved chunks were in the prompt).
    const { text, hallucinated } = validateCitations(raw, knownCitations(chunks));
    if (hallucinated.length > 0) {
      log.warn({ count: hallucinated.length, citations: hallucinated.slice(0, 10) }, mode.hallucinatedEvent);
    }

    await mode.store(sql, userPostId, archivistReply(text), buildPostSources(chunks));
    const durationMs = Date.now() - start;
    log.info({ duration_ms: durationMs }, `${mode.event}_complete`);
    return { status: 'complete', user_post_id: userPostId, duration_ms: durationMs };
  } catch (e) {
    log.error({ error: errMessage(e) }, `${mode.event}_failed`);
    // Every failed attempt marks the post error, as Python did; pg-boss retries after 180 s. Deliberate change 11:
    // only a post this job owns (or no job yet) is marked, and the final attempt clears task_id so a follow-up can
    // retry it; a non-final attempt keeps it, so no second answer races the pending retry.
    const clearTask = ctx.isFinalAttempt ? sql`, task_id = NULL` : sql``;
    try {
      await sql`
        UPDATE user_posts SET status = 'error' ${clearTask}
        WHERE id = ${userPostId} AND (task_id = ${ctx.jobId} OR task_id IS NULL)`;
    } catch (updateErr) {
      log.error({ error: errMessage(updateErr) }, `${mode.event}_error_mark_failed`);
    }
    throw e;
  }
}

export function respondToUserPost(
  data: UserPostData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  return respond(INITIAL, data.user_post_id, data.corpus_id ?? null, ctx, deps);
}

export function respondToUserPostFollowup(
  data: UserPostFollowupData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  return respond(FOLLOWUP, data.user_post_id, null, ctx, deps);
}
