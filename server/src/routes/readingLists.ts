// Port of api/routers/reading_lists.py: curated paper sequences with one chapter feed per paper (C §1.12).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import type { Sql } from '../db/sql.js';
import { recordAudit } from '../audit.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { userRateLimit } from '../http/rateLimit.js';
import { body, params, pyInt } from '../http/validate.js';
import { insertChapters, insertReorderChapters } from '../readingLists/chapters.js';
import { modelString } from '../shared/modelString.js';
import { isUuid } from '../shared/uuid.js';

const createSchema = z.object({
  name: z.string(),
  corpus_id: z.string().nullish(),
  paper_ids: z.array(z.string()).nullish(),
});
const reorderSchema = z.object({ paper_sequence: z.array(z.string()) });
// Python's OrderedPaper has only paper_id, so model_dump() drops any client rationale text (kept on purpose).
const applySchema = z.object({ ordered_papers: z.array(z.object({ paper_id: z.string() })) });
const chapterParams = z.object({ list_id: z.string(), chapter_index: pyInt });

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Python `r.get("rationale", "")` of the first rationale entry whose paper_id equals `pid`, else `''`, as text: the
 * client renders it, and a row stored before deliberate change 28 can hold any JSON type (`modelString`, else `''`).
 */
function paperRationale(rationale: unknown, pid: string): string {
  if (!Array.isArray(rationale)) return '';
  for (const r of rationale) {
    if (isDict(r) && r.paper_id === pid) return (Object.hasOwn(r, 'rationale') ? modelString(r.rationale) : '') ?? '';
  }
  return '';
}

/** Owned papers among `ids` (as `COUNT(*)`); a non-UUID id can never be owned, so it answers -1. */
async function ownedCount(sql: Sql, ids: string[], userId: string): Promise<number> {
  if (!ids.every(isUuid)) return -1;
  const [row] = await sql`
    SELECT COUNT(*)::int AS n FROM papers WHERE id = ANY(${ids}::uuid[]) AND user_id = ${userId}`;
  return row!.n as number;
}

async function ownsList(sql: Sql, listId: string, userId: string): Promise<boolean> {
  if (!isUuid(listId)) return false;
  const [row] = await sql`SELECT id FROM reading_lists WHERE id = ${listId} AND user_id = ${userId}`;
  return Boolean(row);
}

export function readingListsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const workspaceId = c.req.query('workspace_id');
    // A non-UUID workspace cannot match the uuid column (Python 500s on the cast); answer empty instead.
    if (workspaceId && !isUuid(workspaceId)) return c.json([]);
    const scope = workspaceId ? sql`AND rl.corpus_id = ${workspaceId}` : sql``;
    const rows = await sql`
      SELECT rl.id, rl.name, rl.paper_sequence, rl.rationale, rl.created_at,
             COUNT(rlc.id)::int AS chapter_count,
             COUNT(rlc.id) FILTER (WHERE rlc.status = 'complete')::int AS completed
      FROM reading_lists rl
      LEFT JOIN reading_list_chapters rlc ON rlc.reading_list_id = rl.id
      WHERE rl.user_id = ${c.var.user.id} ${scope}
      GROUP BY rl.id ORDER BY rl.created_at DESC`;
    return c.json(
      rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        paper_count: ((row.paper_sequence as string[] | null) ?? []).length,
        chapter_count: row.chapter_count,
        completed_chapters: row.completed,
        rationale: row.rationale,
        created_at: toPydanticIso(row.created_at ?? null),
      })),
    );
  });

  r.get('/:list_id', async (c) => {
    const { sql } = c.var.deps;
    const userId = c.var.user.id;
    const listId = c.req.param('list_id');
    const [row] = isUuid(listId)
      ? await sql`
          SELECT id, name, corpus_id, paper_sequence, rationale, created_at
          FROM reading_lists WHERE id = ${listId} AND user_id = ${userId}`
      : [];
    if (!row) throw new HttpError(404, 'Reading list not found');

    // Re-scoped to the owner: a stored foreign paper id (an old bug or a restore) never leaks another user's paper.
    const paperIds = ((row.paper_sequence as string[] | null) ?? []).map(String);
    const papers: Record<string, unknown>[] = [];
    if (paperIds.length > 0) {
      const paperRows = await sql`
        SELECT id, title, authors, year, filename FROM papers
        WHERE id = ANY(${paperIds}::uuid[]) AND user_id = ${userId}`;
      const byId = new Map(paperRows.map((p) => [String(p.id), p]));
      for (const pid of paperIds) {
        const p = byId.get(pid);
        if (!p) continue;
        papers.push({
          id: String(p.id),
          title: p.title || p.filename,
          authors: p.authors ?? [],
          year: p.year,
          rationale: paperRationale(row.rationale, pid),
        });
      }
    }

    const chapterRows = await sql`
      SELECT id, chapter_index, paper_ids, feed_id, status
      FROM reading_list_chapters WHERE reading_list_id = ${listId} ORDER BY chapter_index`;
    const chapters = chapterRows.map((ch) => ({
      id: String(ch.id),
      chapter_index: ch.chapter_index,
      paper_ids: ((ch.paper_ids as string[] | null) ?? []).map(String),
      feed_id: ch.feed_id ? String(ch.feed_id) : null,
      status: ch.status,
    }));

    return c.json({
      id: String(row.id),
      name: row.name,
      corpus_id: row.corpus_id ? String(row.corpus_id) : null,
      papers,
      chapters,
      created_at: toPydanticIso(row.created_at ?? null),
    });
  });

  r.post('/', userRateLimit('feed_generation'), body(createSchema), async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const userId = c.var.user.id;
    const { name, corpus_id: corpusId, paper_ids: bodyPaperIds } = c.req.valid('json');

    if (corpusId) {
      const [owned] = isUuid(corpusId)
        ? await sql`SELECT id FROM corpora WHERE id = ${corpusId} AND user_id = ${userId}`
        : [];
      if (!owned) throw new HttpError(404, 'Workspace not found');
    }

    let paperIds: string[];
    if (bodyPaperIds && bodyPaperIds.length > 0) {
      // Duplicates fail here too: COUNT of distinct owned rows cannot reach the list's length.
      if ((await ownedCount(sql, bodyPaperIds, userId)) !== bodyPaperIds.length) {
        throw new HttpError(404, 'One or more papers not found');
      }
      paperIds = bodyPaperIds;
    } else if (corpusId) {
      const rows = await sql`
        SELECT id FROM papers
        WHERE corpus_id = ${corpusId} AND user_id = ${userId} AND status = 'complete'
        ORDER BY uploaded_at`;
      paperIds = rows.map((p) => String(p.id));
    } else {
      throw new HttpError(400, 'Provide paper_ids or corpus_id');
    }

    if (paperIds.length < 2) throw new HttpError(400, 'Need at least 2 papers for a reading list');

    // The list and its chapters are created together: a chapterless list never exists.
    const listId = await sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO reading_lists (user_id, corpus_id, name, paper_sequence)
        VALUES (${userId}, ${corpusId || null}, ${name}, ${paperIds}::uuid[]) RETURNING id`;
      const id = String(row!.id);
      await insertChapters(tx, id, paperIds);
      return id;
    });

    // As in Python, a dispatch failure is a 500 after the list exists (the ordering is optional polish).
    const taskId = await queue.send('propose_ordering', { paper_ids: paperIds, list_id: listId, user_id: userId });
    logger.info({ list_id: listId, papers: paperIds.length, task_id: taskId }, 'reading_list_created');
    return c.json({ id: listId, task_id: taskId, paper_count: paperIds.length }, 201);
  });

  r.put('/:list_id/reorder', body(reorderSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const listId = c.req.param('list_id');
    const { paper_sequence: seq } = c.req.valid('json');
    if (!(await ownsList(sql, listId, userId))) throw new HttpError(404, 'Reading list not found');

    // An empty sequence skips both checks, as in Python. Not checked: that seq is a permutation of the list.
    if (seq.length > 0) {
      const distinct = new Set(seq).size;
      if (distinct !== seq.length) throw new HttpError(422, 'Duplicate paper IDs in sequence');
      if ((await ownedCount(sql, seq, userId)) !== distinct) throw new HttpError(404, 'One or more papers not found');
    }

    await sql.begin(async (tx) => {
      await tx`UPDATE reading_lists SET paper_sequence = ${seq}::uuid[] WHERE id = ${listId}`;
      // Chapters with a generated feed are kept; every other chapter is rebuilt after the last complete one.
      await tx`DELETE FROM reading_list_chapters WHERE reading_list_id = ${listId} AND feed_id IS NULL`;
      const [mc] = await tx`
        SELECT COALESCE(MAX(chapter_index), -1)::int AS n
        FROM reading_list_chapters WHERE reading_list_id = ${listId} AND status = 'complete'`;
      const maxComplete = mc!.n as number;
      const remaining = seq.slice(maxComplete + 1);
      if (remaining.length > 0) await insertReorderChapters(tx, listId, remaining, maxComplete);
    });

    logger.info({ list_id: listId }, 'reading_list_reordered');
    return c.json({ status: 'reordered' });
  });

  r.put('/:list_id/apply-ordering', body(applySchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const listId = c.req.param('list_id');
    const { ordered_papers: ordered } = c.req.valid('json');
    const [row] = isUuid(listId)
      ? await sql`SELECT id, paper_sequence FROM reading_lists WHERE id = ${listId} AND user_id = ${userId}`
      : [];
    if (!row) throw new HttpError(404, 'Reading list not found');
    if (ordered.length === 0) throw new HttpError(400, 'No ordering data');

    const newSequence = ordered.map((p) => p.paper_id);
    const proposed = new Set(newSequence);
    if (proposed.size !== newSequence.length) throw new HttpError(422, 'Duplicate paper IDs in ordering');
    // A string compare against the stored (lowercase) ids: foreign ids cannot be injected through this route.
    const existing = new Set(((row.paper_sequence as string[] | null) ?? []).map(String));
    if (proposed.size !== existing.size || ![...proposed].every((p) => existing.has(p))) {
      throw new HttpError(400, 'Ordering must be a permutation of the existing paper list');
    }
    const rationale = newSequence.map((paperId) => ({ paper_id: paperId }));

    await sql.begin(async (tx) => {
      await tx`
        UPDATE reading_lists SET paper_sequence = ${newSequence}::uuid[], rationale = ${tx.json(rationale as never)}
        WHERE id = ${listId}`;
      // A full rebuild, completed chapters included: exactly the create path's initial state.
      await tx`DELETE FROM reading_list_chapters WHERE reading_list_id = ${listId}`;
      await insertChapters(tx, listId, newSequence);
    });

    logger.info({ list_id: listId }, 'ai_ordering_applied');
    return c.json({ status: 'applied' });
  });

  r.post(
    '/:list_id/chapters/:chapter_index/generate',
    userRateLimit('feed_generation'),
    params(chapterParams),
    async (c) => {
      const { sql, queue, logger } = c.var.deps;
      const userId = c.var.user.id;
      const { list_id: listId, chapter_index: chapterIndex } = c.req.valid('param');
      if (!(await ownsList(sql, listId, userId))) throw new HttpError(404, 'Chapter not found');
      // An index outside int4 cannot match the column (Python 500s encoding it); it is a missing chapter.
      const [chapter] =
        chapterIndex >= INT4_MIN && chapterIndex <= INT4_MAX
          ? await sql`
              SELECT id, status FROM reading_list_chapters
              WHERE reading_list_id = ${listId} AND chapter_index = ${chapterIndex}`
          : [];
      if (!chapter) throw new HttpError(404, 'Chapter not found');
      if (chapter.status === 'locked') throw new HttpError(400, 'Chapter is locked. Complete prior chapters first.');

      const taskId = await queue.send('generate_chapter', {
        reading_list_id: listId,
        chapter_index: chapterIndex,
        user_id: userId,
      });
      logger.info({ list_id: listId, chapter: chapterIndex, task_id: taskId }, 'chapter_generation_dispatched');
      return c.json({ task_id: taskId, status: 'queued' }, 202);
    },
  );

  r.delete('/:list_id', async (c) => {
    const { sql } = c.var.deps;
    const listId = c.req.param('list_id');
    // Chapters cascade; their feeds stay (as in Python).
    const deleted = isUuid(listId)
      ? await sql`DELETE FROM reading_lists WHERE id = ${listId} AND user_id = ${c.var.user.id} RETURNING id`
      : [];
    if (deleted.length === 0) throw new HttpError(404, 'Reading list not found');
    await recordAudit(c, {
      action: 'reading_list.delete',
      resourceType: 'reading_list',
      resourceId: listId,
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  return r;
}
