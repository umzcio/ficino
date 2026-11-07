// Port of worker/tasks/summary_tasks.py: generate_paper_summary and generate_corpus_synthesis (W §2.9).
import {
  buildPaperSummaryPrompt,
  buildSynthesisPrompt,
  PAPER_SUMMARY_SYSTEM,
  parseChatMessages,
  SYNTHESIS_SYSTEM,
  type SummaryChunkRow,
  type SynthesisPaperRow,
} from '../conversations/summaryParse.js';
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings } from '../providers/config.js';
import { generateText } from '../providers/llm.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pyLen, pySlice } from '../shared/pystr.js';
import type { WorkerDeps } from '../worker/handlers.js';

export type PaperSummaryData = { paper_id: string };
export type CorpusSynthesisData = { synthesis_id: string; paper_ids: string[]; name: string; user_id: string };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Python `len()` of a decoded jsonb value, for the idempotency guard's count. */
function jsonLen(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string') return pyLen(v);
  if (typeof v === 'object' && v !== null) return Object.keys(v).length;
  return 0;
}

/** Python truthiness of a decoded jsonb value. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return typeof v === 'object' ? jsonLen(v) > 0 : true;
}

/** The log preview, `cleaned[:200]`: the fallback bubble's content is the cleaned text. */
const previewOf = (messages: Record<string, unknown>[]): string => pySlice(String(messages[0]?.content ?? ''), 0, 200);

export async function generatePaperSummary(
  data: PaperSummaryData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const paperId = data.paper_id;
  const log = ctx.logger.child({ paper_id: paperId, task_id: ctx.jobId });
  log.info('paper_summary_start');

  try {
    // Only an explicit 'complete' short-circuits; 'error' and NULL regenerate. 'generating' under another job id
    // means that job is producing it; under this job's id (a retry) or no id, regenerate over the row.
    const [existing] = await sql`SELECT id, status, task_id FROM paper_summaries WHERE paper_id = ${paperId}`;
    if (existing) {
      if (existing.status === 'complete') {
        log.info('paper_summary_exists');
        return { status: 'exists', paper_id: paperId };
      }
      if (existing.status === 'generating') {
        const other = existing.task_id as string | null;
        if (other && other !== ctx.jobId) {
          log.info({ other_task_id: other }, 'paper_summary_already_generating');
          return { status: 'already_generating', paper_id: paperId };
        }
      }
    }

    const [paper] = await sql`SELECT title, filename, authors, user_id FROM papers WHERE id = ${paperId}`;
    if (!paper) throw new Error(`Paper ${paperId} not found`);

    // Bill the paper owner's provider settings.
    const owner = paper.user_id ? String(paper.user_id) : STUB_USER_ID;
    const { providers } = await loadJobSettings(sql, owner, deps.env, deps.config);

    const rows = await sql`
      SELECT section, content FROM chunks
      WHERE paper_id = ${paperId} ORDER BY chunk_index LIMIT 30`;
    if (rows.length === 0) throw new Error(`No chunks found for paper ${paperId}`);

    await ctx.progress({ step: 'generating', paper_id: paperId });

    const prompt = buildPaperSummaryPrompt(
      { title: paper.title as string | null, filename: paper.filename as string },
      rows as unknown as SummaryChunkRow[],
    );
    const raw = await generateText(providers, deps.providers, {
      system: PAPER_SUMMARY_SYSTEM,
      user: prompt,
      temperature: 0.7,
      maxTokens: 1536,
      signal: ctx.signal,
    });

    const { messages, warning } = parseChatMessages(raw, 'paper', '(no content returned)');
    if (warning === 'parse_failed') log.warn({ preview: previewOf(messages) }, 'summary_parse_failed');
    if (warning === 'parse_empty') log.warn({ preview: previewOf(messages) }, 'summary_parse_empty');

    await sql`
      INSERT INTO paper_summaries (paper_id, messages, status, task_id)
      VALUES (${paperId}, ${sql.json(messages as never)}, 'complete', NULL)
      ON CONFLICT (paper_id) DO UPDATE SET messages = EXCLUDED.messages, status = 'complete', task_id = NULL,
        generated_at = NOW()`;

    log.info({ messages: messages.length }, 'paper_summary_complete');
    return { status: 'complete', paper_id: paperId, message_count: messages.length };
  } catch (e) {
    log.error({ error: errMessage(e) }, 'paper_summary_failed');
    if (ctx.isFinalAttempt) {
      // Retries exhausted: mark the placeholder so the GET handler re-dispatches instead of spinning forever.
      // Only this job's own (or an unowned) generating row: a newer job that took the row over keeps it, and a
      // row that job already completed stays complete (deliberate change 7; Python marked the row unconditionally).
      try {
        await sql`
          UPDATE paper_summaries SET status = 'error', task_id = NULL
          WHERE paper_id = ${paperId} AND status = 'generating' AND (task_id = ${ctx.jobId} OR task_id IS NULL)`;
      } catch (updateErr) {
        log.error({ error: errMessage(updateErr) }, 'paper_summary_error_mark_failed');
      }
    }
    throw e;
  }
}

export async function generateCorpusSynthesis(
  data: CorpusSynthesisData,
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const synthesisId = data.synthesis_id;
  const paperIds = data.paper_ids;
  const log = ctx.logger.child({ synthesis_id: synthesisId, task_id: ctx.jobId });
  log.info({ papers: paperIds.length }, 'corpus_synthesis_start');

  try {
    // A retry after the LLM call succeeded must not re-spend or overwrite the completed row.
    const [existing] = await sql`SELECT messages FROM corpus_syntheses WHERE id = ${synthesisId}`;
    if (existing && truthy(existing.messages)) {
      const count = jsonLen(existing.messages);
      // Deliberate change 23: heal a row the skip would otherwise leave `generating` (a non-array `messages` from a
      // restore), or the group-chat stuck check would charge and re-dispatch it on every poll.
      await sql`
        UPDATE corpus_syntheses SET status = 'complete', task_id = NULL
        WHERE id = ${synthesisId} AND status = 'generating'`;
      log.info({ messages: count }, 'corpus_synthesis_idempotent_skip');
      return { status: 'complete', synthesis_id: synthesisId, message_count: count, idempotent: true };
    }

    // Bill the requesting user's provider settings.
    const { providers } = await loadJobSettings(sql, data.user_id, deps.env, deps.config);

    const paperRows = await sql`
      SELECT p.id, p.title, p.filename,
             COALESCE(c.sections, ARRAY[]::text[]) AS sections,
             COALESCE(c.contents, ARRAY[]::text[]) AS contents
      FROM papers p
      LEFT JOIN LATERAL (
        SELECT array_agg(section ORDER BY chunk_index) AS sections,
               array_agg(content ORDER BY chunk_index) AS contents
        FROM (
          SELECT section, content, chunk_index FROM chunks
          WHERE paper_id = p.id
          ORDER BY chunk_index
          LIMIT 10
        ) s
      ) c ON true
      WHERE p.id = ANY(${paperIds}::uuid[])`;

    const prompt = buildSynthesisPrompt(paperRows as unknown as SynthesisPaperRow[]);

    await ctx.progress({ step: 'synthesizing', synthesis_id: synthesisId });

    const raw = await generateText(providers, deps.providers, {
      system: SYNTHESIS_SYSTEM,
      user: prompt,
      temperature: 0.7,
      maxTokens: 1024,
      signal: ctx.signal,
    });

    const { messages, warning } = parseChatMessages(raw, 'synthesis', '(no content)');
    if (warning === 'parse_failed') log.warn({ preview: previewOf(messages) }, 'synthesis_parse_failed');

    // The API inserts a 'generating' placeholder at dispatch; ON CONFLICT completes it (and covers a retry after a
    // partial write). Columns outside the SET list (name, paper_ids, user_id) keep the placeholder's values.
    await sql`
      INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
      VALUES (${synthesisId}, ${data.user_id}, ${data.name}, ${paperIds}::uuid[], ${sql.json(messages as never)},
              'complete', NULL)
      ON CONFLICT (id) DO UPDATE SET
        messages = EXCLUDED.messages,
        status = 'complete',
        task_id = NULL,
        generated_at = NOW()`;

    log.info({ messages: messages.length }, 'corpus_synthesis_complete');
    return { status: 'complete', synthesis_id: synthesisId, message_count: messages.length };
  } catch (e) {
    log.error({ error: errMessage(e) }, 'corpus_synthesis_failed');
    if (ctx.isFinalAttempt) {
      // Same scoping as the paper summary (deliberate change 7).
      try {
        await sql`
          UPDATE corpus_syntheses SET status = 'error', task_id = NULL
          WHERE id = ${synthesisId} AND status = 'generating' AND (task_id = ${ctx.jobId} OR task_id IS NULL)`;
      } catch (updateErr) {
        log.error({ error: errMessage(updateErr) }, 'corpus_synthesis_error_mark_failed');
      }
    }
    throw e;
  }
}
