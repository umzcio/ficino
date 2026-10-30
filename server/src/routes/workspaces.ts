import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { recordAudit } from '../audit.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import type { Sql } from '../db/sql.js';
import { HttpError } from '../http/errors.js';
import { body } from '../http/validate.js';
import { DEFAULT_WORKSPACE_ID } from '../shared/constants.js';

const nameBody = z.object({ name: z.string() });

/** Sortable key for a pydantic-style timestamp; null sorts oldest (R10 API-13). */
function activityKey(ts: string | null): string {
  if (ts === null) return '';
  const t = ts.replace(/Z$/, '');
  return t.includes('.') ? t : `${t}.000000`;
}

/** The caller's earliest workspace id, creating a 'Default' one if none exist. */
async function getOrCreateDefaultWorkspace(sql: Sql, userId: string): Promise<string> {
  const [row] = await sql`SELECT id FROM corpora WHERE user_id = ${userId} ORDER BY created_at LIMIT 1`;
  if (row) return String(row.id);
  const [created] = await sql`INSERT INTO corpora (user_id, name) VALUES (${userId}, 'Default') RETURNING id`;
  return String(created!.id);
}

export function workspacesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT c.id, c.name, c.created_at,
             (SELECT COUNT(*) FROM papers p WHERE p.corpus_id = c.id)::int AS paper_count,
             (SELECT COUNT(*) FROM feeds f WHERE f.corpus_id = c.id)::int AS feed_count,
             GREATEST(
               (SELECT MAX(generated_at) FROM feeds WHERE corpus_id = c.id),
               (SELECT MAX(uploaded_at) FROM papers WHERE corpus_id = c.id)
             ) AS last_activity
      FROM corpora c
      WHERE c.user_id = ${c.var.user.id}
      ORDER BY last_activity DESC NULLS LAST`;
    return c.json(
      rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        paper_count: row.paper_count,
        feed_count: row.feed_count,
        last_activity: toPydanticIso(row.last_activity),
        created_at: toPydanticIso(row.created_at),
      })),
    );
  });

  r.post('/', body(nameBody), async (c) => {
    const { sql } = c.var.deps;
    const name = c.req.valid('json').name.trim();
    if (!name) throw new HttpError(400, 'Workspace name cannot be empty');
    const [row] = await sql`INSERT INTO corpora (user_id, name) VALUES (${c.var.user.id}, ${name}) RETURNING id`;
    return c.json({ id: String(row!.id), name }, 201);
  });

  r.put('/:workspace_id', body(nameBody), async (c) => {
    const { sql } = c.var.deps;
    const workspaceId = c.req.param('workspace_id');
    const name = c.req.valid('json').name.trim();
    if (!name) throw new HttpError(400, 'Workspace name cannot be empty');
    const res = await sql`UPDATE corpora SET name = ${name} WHERE id = ${workspaceId} AND user_id = ${c.var.user.id}`;
    if (res.count === 0) throw new HttpError(404, 'Workspace not found');
    return c.json({ id: workspaceId, name });
  });

  r.delete('/:workspace_id', async (c) => {
    const { sql } = c.var.deps;
    const userId = c.var.user.id;
    const workspaceId = c.req.param('workspace_id');
    if (workspaceId === DEFAULT_WORKSPACE_ID) throw new HttpError(400, 'Cannot delete the default workspace');

    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM corpora WHERE user_id = ${userId}`;
    if (n <= 1) throw new HttpError(400, 'Cannot delete your only workspace');

    // Move papers into the caller's own workspace, never the shared stub one (cross-tenant leak).
    let target = await getOrCreateDefaultWorkspace(sql, userId);
    if (target === workspaceId) {
      const [other] = await sql`
        SELECT id FROM corpora WHERE user_id = ${userId} AND id != ${workspaceId} ORDER BY created_at LIMIT 1`;
      if (other) target = String(other.id);
    }
    await sql`UPDATE papers SET corpus_id = ${target} WHERE corpus_id = ${workspaceId} AND user_id = ${userId}`;
    // Idempotent on a missing id: still 204 (R10 BP-3).
    await sql`DELETE FROM corpora WHERE id = ${workspaceId} AND user_id = ${userId}`;
    c.var.deps.logger.info({ workspace_id: workspaceId, moved_papers_to: target }, 'workspace_deleted');

    await recordAudit(c, {
      action: 'workspace.delete',
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: { moved_papers_to: target },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  r.get('/:workspace_id/activity', async (c) => {
    const { sql } = c.var.deps;
    const userId = c.var.user.id;
    const workspaceId = c.req.param('workspace_id');
    const [owner] = await sql`SELECT id FROM corpora WHERE id = ${workspaceId} AND user_id = ${userId}`;
    if (!owner) throw new HttpError(404, 'Workspace not found');

    const activities: { type: string; title: string; detail: string; timestamp: string | null }[] = [];

    const papers = await sql`
      SELECT id, title, filename, uploaded_at, status, chunk_count
      FROM papers WHERE user_id = ${userId} AND corpus_id = ${workspaceId}
      ORDER BY uploaded_at DESC LIMIT 10`;
    for (const p of papers) {
      activities.push({
        type: 'paper_upload',
        title: p.title || p.filename,
        detail: `${p.chunk_count} chunks · ${p.status}`,
        timestamp: toPydanticIso(p.uploaded_at),
      });
    }

    const feeds = await sql`
      SELECT id, post_count, paper_count, generated_at, generation_duration_ms
      FROM feeds WHERE user_id = ${userId} AND corpus_id = ${workspaceId}
      ORDER BY generated_at DESC LIMIT 10`;
    for (const f of feeds) {
      let detail = `${f.post_count} posts · ${f.paper_count} papers`;
      if (f.generation_duration_ms) detail += ` · ${Math.floor(f.generation_duration_ms / 1000)}s`;
      activities.push({
        type: 'feed_generation',
        title: 'Generated feed',
        detail,
        timestamp: toPydanticIso(f.generated_at),
      });
    }

    // Stable DESC sort, nulls oldest (Python sort(reverse=True) is stable too).
    activities.sort((a, b) => {
      const ka = activityKey(a.timestamp);
      const kb = activityKey(b.timestamp);
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
    return c.json(activities.slice(0, 20));
  });

  return r;
}
