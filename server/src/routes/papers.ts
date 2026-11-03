import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../app.js';
import { recordAudit } from '../audit.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { userRateLimit } from '../http/rateLimit.js';
import { DEFAULT_WORKSPACE_ID, LIMITS } from '../shared/constants.js';

// +16384 allowance for multipart boilerplate around the file bytes, so a file exactly at the cap is not rejected.
const MULTIPART_SLACK = 16384;

type Row = Record<string, any>;

/** The one place a `Paper` is built (port of _paper_from_row); every key is always present. */
export function paperFromRow(row: Row) {
  let tags = row.tags;
  if (typeof tags === 'string') tags = JSON.parse(tags);
  return {
    id: String(row.id),
    user_id: row.user_id == null ? null : String(row.user_id),
    corpus_id: row.corpus_id == null ? null : String(row.corpus_id),
    title: row.title ?? null,
    authors: row.authors || [],
    year: row.year ?? null,
    doi: row.doi ?? null,
    filename: row.filename as string,
    status: row.status || 'pending',
    extraction_path: row.extraction_path ?? null,
    error_message: row.error_message ?? null,
    chunk_count: row.chunk_count || 0,
    figure_count: row.figure_count || 0,
    tags: tags || [],
    uploaded_at: toPydanticIso(row.uploaded_at ?? null),
    processed_at: toPydanticIso(row.processed_at ?? null),
  };
}

export function papersRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.post(
    '/',
    userRateLimit('paper_upload'),
    async (c, next) => {
      const mb = c.var.deps.config.maxUploadSizeMb;
      const tooBig = () => new HttpError(413, `File exceeds ${mb}MB limit`);
      const max = mb * 1024 * 1024 + MULTIPART_SLACK;
      // Cheap early exit on the declared size; a client can lie, so bodyLimit enforces it on the stream.
      const declared = c.req.header('content-length');
      if (declared !== undefined && /^\s*\d+\s*$/.test(declared) && Number(declared) > max) throw tooBig();
      return bodyLimit({
        maxSize: max,
        onError: () => {
          throw tooBig();
        },
      })(c, next);
    },
    async (c) => {
      const { sql, config, logger, storage, queue } = c.var.deps;
      const user = c.var.user;

      const form = await c.req.parseBody();
      const file = form['file'];
      if (!(file instanceof File)) {
        return c.json({ detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }] }, 422);
      }
      if (!file.name || !file.name.toLowerCase().endsWith('.pdf')) {
        throw new HttpError(400, 'Only PDF files are accepted');
      }

      const maxBytes = config.maxUploadSizeMb * 1024 * 1024;
      const contents = new Uint8Array(await file.arrayBuffer());
      if (contents.length > maxBytes) throw new HttpError(413, `File exceeds ${config.maxUploadSizeMb}MB limit`);
      if (!(contents.length >= 5 && Buffer.from(contents.subarray(0, 5)).toString('latin1') === '%PDF-')) {
        throw new HttpError(400, 'File is not a valid PDF (magic bytes missing)');
      }

      const corpusId = c.req.query('workspace_id') ?? DEFAULT_WORKSPACE_ID;
      const [ws] = await sql`SELECT id FROM corpora WHERE id = ${corpusId} AND user_id = ${user.id}`;
      if (!ws) throw new HttpError(404, 'Workspace not found');

      // Row first, bytes second: a crash in between leaves a queryable 'pending' row, never an orphan file.
      let inserted: Row;
      try {
        [inserted] = await sql`
          INSERT INTO papers (user_id, corpus_id, filename, file_path, status, uploaded_at)
          VALUES (${user.id}, ${corpusId}, ${file.name}, '', 'pending', now())
          RETURNING id, uploaded_at`;
      } catch (e) {
        if ((e as { code?: string }).code === '23503') throw new HttpError(400, 'Invalid workspace');
        throw e;
      }
      const paperId = String(inserted!.id);

      let fileRef: string;
      try {
        fileRef = await storage.savePdf(paperId, contents);
      } catch (e) {
        await sql`DELETE FROM papers WHERE id = ${paperId} AND user_id = ${user.id}`;
        await storage.deletePdf(paperId).catch(() => undefined);
        logger.error({ paper_id: paperId, error: String(e).slice(0, 200) }, 'paper_upload_write_failed');
        throw new HttpError(500, 'Failed to store uploaded file');
      }
      await sql`UPDATE papers SET file_path = ${fileRef} WHERE id = ${paperId}`;
      logger.info({ paper_id: paperId, filename: file.name, size: contents.length }, 'paper_uploaded');

      try {
        await queue.send('process_paper', { paper_id: paperId });
      } catch (e) {
        // The row stays 'pending' (as in Python, where a failed send_task was an unhandled 500).
        logger.error({ paper_id: paperId, error: String(e).slice(0, 200) }, 'ingestion_task_dispatch_failed');
        throw e;
      }
      logger.info({ paper_id: paperId }, 'ingestion_task_dispatched');

      return c.json(
        paperFromRow({ id: paperId, user_id: user.id, filename: file.name, status: 'pending', uploaded_at: inserted!.uploaded_at }),
        201,
      );
    },
  );

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const workspaceId = c.req.query('workspace_id') ?? null;
    const rows = await sql`
      SELECT p.id, p.user_id, p.corpus_id, p.title, p.authors, p.year, p.doi, p.filename,
             p.status, p.extraction_path, p.error_message, p.chunk_count, p.figure_count,
             p.uploaded_at, p.processed_at,
             COALESCE(
               json_agg(json_build_object('id', t.id::text, 'name', t.name))
               FILTER (WHERE t.id IS NOT NULL), '[]'
             ) AS tags
      FROM papers p
      LEFT JOIN paper_tags pt ON p.id = pt.paper_id
      LEFT JOIN tags t ON pt.tag_id = t.id
      WHERE p.user_id = ${c.var.user.id} AND (${workspaceId}::uuid IS NULL OR p.corpus_id = ${workspaceId})
      GROUP BY p.id
      ORDER BY p.uploaded_at DESC
      LIMIT ${LIMITS.LIBRARY}`;
    return c.json(rows.map((row) => paperFromRow(row)));
  });

  r.get('/:paper_id', async (c) => {
    const { sql } = c.var.deps;
    const [row] = await sql`
      SELECT id, user_id, corpus_id, title, authors, year, doi, filename,
             status, extraction_path, error_message, chunk_count, figure_count,
             uploaded_at, processed_at
      FROM papers WHERE id = ${c.req.param('paper_id')} AND user_id = ${c.var.user.id}`;
    if (!row) throw new HttpError(404, 'Paper not found');
    return c.json(paperFromRow(row));
  });

  r.delete('/:paper_id', async (c) => {
    const { sql, logger, storage } = c.var.deps;
    const userId = c.var.user.id;
    const paperId = c.req.param('paper_id');
    const [row] = await sql`
      DELETE FROM papers WHERE id = ${paperId} AND user_id = ${userId} RETURNING corpus_id, filename`;
    if (!row) throw new HttpError(404, 'Paper not found');
    const corpusId = row.corpus_id == null ? null : String(row.corpus_id);

    // Last paper in the workspace: drop its feeds so the UI shows no dangling discourse.
    if (corpusId) {
      const [{ n }] = await sql`
        SELECT COUNT(*)::int AS n FROM papers WHERE corpus_id = ${corpusId} AND user_id = ${userId}`;
      if (n === 0) {
        await sql`DELETE FROM feeds WHERE corpus_id = ${corpusId} AND user_id = ${userId}`;
        logger.info({ corpus_id: corpusId }, 'workspace_feeds_cleared');
      }
    }

    await storage.deletePaperArtifacts(paperId);
    logger.info({ paper_id: paperId }, 'paper_deleted');

    await recordAudit(c, {
      action: 'paper.delete',
      resourceType: 'paper',
      resourceId: paperId,
      metadata: { filename: row.filename, corpus_id: corpusId },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  r.get('/:paper_id/figures', async (c) => {
    const { sql, storage } = c.var.deps;
    const paperId = c.req.param('paper_id');
    const rows = await sql`
      SELECT f.id, f.page_number, f.image_path, f.extraction_type,
             f.description, f.claim_summary, f.figure_index
      FROM figures f
      JOIN papers p ON f.paper_id = p.id AND p.user_id = ${c.var.user.id}
      WHERE f.paper_id = ${paperId} ORDER BY f.figure_index`;
    // Ids come from the DB, so they are UUIDs and signing cannot throw 'invalid id'.
    return c.json(
      rows.map((row) => ({
        id: String(row.id),
        page_number: row.page_number,
        image_url: storage.figureImageUrl(paperId, String(row.id)),
        extraction_type: row.extraction_type,
        description: row.description,
        claim_summary: row.claim_summary,
        figure_index: row.figure_index,
      })),
    );
  });

  return r;
}
