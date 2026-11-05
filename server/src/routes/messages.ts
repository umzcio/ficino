import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import type { JobState } from '../jobs/queue.js';
import { toPydanticIso } from '../db/time.js';
import { isStuckJobState, summaryStatusFromJob } from '../feed/status.js';
import { HttpError } from '../http/errors.js';
import { chargeUserRateLimit, userRateLimit } from '../http/rateLimit.js';
import { body } from '../http/validate.js';
import { LIMITS } from '../shared/constants.js';
import { pySlice } from '../shared/pystr.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groupSchema = z.object({ name: z.string(), paper_ids: z.array(z.string()) });

export function messagesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  // --- Paper summaries (individual DMs) ---

  r.get('/papers', async (c) => {
    const { sql } = c.var.deps;
    const userId = c.var.user.id;
    const workspaceId = c.req.query('workspace_id');
    // A non-UUID workspace cannot match a uuid column (Python 500s on the cast); answer empty instead.
    if (workspaceId && !UUID_RE.test(workspaceId)) return c.json([]);
    const scope = workspaceId ? sql`AND p.corpus_id = ${workspaceId}` : sql``;
    // Project the preview and count in SQL so a long transcript is never shipped just to render 80 chars.
    const rows = await sql`
      SELECT p.id, p.title, p.filename, p.authors, p.chunk_count, p.figure_count,
             p.uploaded_at, ps.id AS summary_id, ps.generated_at AS summary_generated_at,
             COALESCE((ps.messages->-1->>'content'), '') AS last_msg_content,
             COALESCE(jsonb_array_length(ps.messages), 0)::int AS message_count
      FROM papers p
      LEFT JOIN paper_summaries ps ON p.id = ps.paper_id
      WHERE p.status = 'complete' AND p.user_id = ${userId} ${scope}
      ORDER BY p.uploaded_at DESC
      LIMIT ${LIMITS.PAPER_SUMMARIES}`;
    return c.json(
      rows.map((row) => {
        const last = (row.last_msg_content as string) || null;
        return {
          paper_id: String(row.id),
          title: row.title || row.filename,
          authors: row.authors || [],
          chunk_count: row.chunk_count,
          has_summary: row.summary_id !== null,
          summary_generated_at: toPydanticIso(row.summary_generated_at ?? null),
          last_message_preview: last ? pySlice(last, 0, 80) : null,
          message_count: row.message_count,
          uploaded_at: toPydanticIso(row.uploaded_at ?? null),
        };
      }),
    );
  });

  // Registered before /papers/:paper_id so "tldrs" is not read as a paper id.
  r.get('/papers/tldrs', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT ps.paper_id,
             LEFT(COALESCE(ps.messages->0->>'content', ''), 200) AS tldr
      FROM paper_summaries ps
      JOIN papers p ON ps.paper_id = p.id AND p.user_id = ${c.var.user.id}
      WHERE ps.status = 'complete' AND jsonb_array_length(ps.messages) > 0`;
    const out: Record<string, string> = {};
    for (const row of rows) if (row.tldr) out[String(row.paper_id)] = row.tldr as string;
    return c.json(out);
  });

  r.get('/papers/:paper_id', async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const paperId = c.req.param('paper_id');
    const [paper] = UUID_RE.test(paperId)
      ? await sql`
          SELECT id, title, filename, authors FROM papers
          WHERE id = ${paperId} AND user_id = ${c.var.user.id} AND status = 'complete'`
      : [];
    if (!paper) throw new HttpError(404, 'Paper not found or not processed');

    const [found] = await sql`
      SELECT messages, generated_at, status, task_id FROM paper_summaries WHERE paper_id = ${paperId}`;
    let summary: typeof found | undefined = found;

    // A row the worker marked 'error' (retries exhausted) is dropped so the dispatch below resets it.
    if (summary && (summary.status || 'complete') === 'error') {
      logger.warn({ paper_id: paperId }, 'paper_summary_error_redispatch');
      summary = undefined;
    }

    // A worker can die without writing back a terminal status. If the row says 'generating' but the
    // job is failed, cancelled, completed or unknown (or its state cannot be read), re-dispatch.
    if (summary && (summary.status || 'complete') === 'generating' && summary.task_id) {
      const oldTaskId = summary.task_id as string;
      let taskState = 'unknown';
      let readError: unknown;
      try {
        taskState = (await queue.getJobState(oldTaskId)).state;
      } catch (e) {
        readError = e;
      }
      // `completed` is stranded too: the worker commits status='complete', task_id=NULL before its handler
      // returns, so a generating row on its own completed job lost the dispatch/upsert race.
      if (readError !== undefined || isStuckJobState(taskState as JobState['state']) || taskState === 'completed') {
        logger.warn(
          {
            paper_id: paperId,
            old_task_id: oldTaskId,
            task_state: taskState,
            ...(readError !== undefined && { err: readError instanceof Error ? readError.message : String(readError) }),
          },
          'paper_summary_stuck_generating',
        );
        summary = undefined;
      }
    }

    const title = paper.title || paper.filename;
    const authors = paper.authors || [];
    if (summary) {
      const status = (summary.status as string) || 'complete';
      const result: Record<string, unknown> = {
        paper_id: paperId,
        title,
        authors,
        messages: summary.messages,
        generated_at: toPydanticIso(summary.generated_at ?? null),
        status,
      };
      if (status === 'generating' && summary.task_id) result.task_id = summary.task_id;
      return c.json(result);
    }

    // Charged only here, so cached reads never spend the budget.
    await chargeUserRateLimit(c, 'summary');
    const taskId = await queue.send('generate_paper_summary', { paper_id: paperId });
    logger.info({ paper_id: paperId, task_id: taskId }, 'paper_summary_dispatched');
    await sql`
      INSERT INTO paper_summaries (paper_id, messages, status, task_id)
      VALUES (${paperId}, '[]'::jsonb, 'generating', ${taskId})
      ON CONFLICT (paper_id) DO UPDATE SET status = 'generating', task_id = ${taskId}`;
    return c.json({ paper_id: paperId, title, authors, messages: [], status: 'generating', task_id: taskId });
  });

  // No ownership check, as in Python: auth-gated only.
  r.get('/papers/:paper_id/status/:task_id', async (c) => {
    const paperId = c.req.param('paper_id');
    const state = await c.var.deps.queue.getJobState(c.req.param('task_id'));
    return c.json(summaryStatusFromJob(paperId, state));
  });

  // --- Corpus syntheses (group chats) ---

  r.get('/groups', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT id, name,
             COALESCE(array_length(paper_ids, 1), 0)::int AS paper_count,
             COALESCE(jsonb_array_length(messages), 0)::int AS message_count,
             LEFT(COALESCE(messages->-1->>'content', ''), 80) AS last_msg,
             generated_at
      FROM corpus_syntheses
      WHERE user_id = ${c.var.user.id}
      ORDER BY generated_at DESC
      LIMIT ${LIMITS.CONTENT}`;
    return c.json(
      rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        paper_count: row.paper_count,
        message_count: row.message_count,
        last_message_preview: row.last_msg || null,
        generated_at: toPydanticIso(row.generated_at ?? null),
      })),
    );
  });

  r.post('/groups', userRateLimit('summary'), body(groupSchema), async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const { name, paper_ids: ids } = c.req.valid('json');
    const userId = c.var.user.id;
    if (ids.length < 2) throw new HttpError(400, 'Need at least 2 papers for a group chat');

    // Every id must be the caller's. Duplicates and malformed ids can never match the count.
    let owned = 0;
    if (ids.every((id) => UUID_RE.test(id))) {
      const [row] = await sql`
        SELECT COUNT(*)::int AS n FROM papers WHERE id = ANY(${ids}::uuid[]) AND user_id = ${userId}`;
      owned = row!.n as number;
    }
    if (owned !== ids.length) throw new HttpError(404, 'One or more papers not found');

    const synthesisId = randomUUID();
    const taskId = await queue.send('generate_corpus_synthesis', {
      synthesis_id: synthesisId,
      paper_ids: ids,
      name,
      user_id: userId,
    });
    logger.info({ synthesis_id: synthesisId, task_id: taskId }, 'corpus_synthesis_dispatched');

    // The placeholder gives GET /groups/:id something to read for the whole generation window.
    await sql`
      INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
      VALUES (${synthesisId}, ${userId}, ${name}, ${ids}::uuid[], '[]'::jsonb, 'generating', ${taskId})
      ON CONFLICT (id) DO UPDATE SET status = 'generating', task_id = ${taskId}`;
    return c.json({ synthesis_id: synthesisId, task_id: taskId, status: 'generating' }, 202);
  });

  r.get('/groups/:synthesis_id', async (c) => {
    const { sql } = c.var.deps;
    const synthesisId = c.req.param('synthesis_id');
    const [row] = UUID_RE.test(synthesisId)
      ? await sql`
          SELECT id, name, paper_ids, messages, generated_at, status, task_id
          FROM corpus_syntheses WHERE id = ${synthesisId} AND user_id = ${c.var.user.id}`
      : [];
    if (!row) throw new HttpError(404, 'Group chat not found');
    const status = (row.status as string) || 'complete';

    // Titles are looked up without a user scope, as in Python (the ids were verified at creation).
    const paperRows = await sql`
      SELECT id, title, filename FROM papers WHERE id = ANY(${row.paper_ids as string[]}::uuid[])`;
    const papers: Record<string, string> = {};
    for (const p of paperRows) papers[String(p.id)] = (p.title || p.filename) as string;

    const result: Record<string, unknown> = {
      id: String(row.id),
      name: row.name,
      papers,
      messages: row.messages,
      generated_at: toPydanticIso(row.generated_at ?? null),
      status,
    };
    if (status === 'generating' && row.task_id) result.task_id = row.task_id;
    return c.json(result);
  });

  return r;
}
