// Port of worker/tasks/reading_list_tasks.py: propose_ordering (W §2.8).
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings } from '../providers/config.js';
import { generateText } from '../providers/llm.js';
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
import type { WorkerDeps } from '../worker/handlers.js';

export type ProposeOrderingData = { paper_ids: string[]; list_id?: string | null; user_id?: string | null };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
