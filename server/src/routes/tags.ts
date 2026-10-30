import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { HttpError } from '../http/errors.js';
import { body } from '../http/validate.js';

const tagCreateSchema = z.object({ name: z.string() });
const paperTagSchema = z.object({ paper_id: z.string(), tag_name: z.string() });

export function tagsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT t.id, t.name, COUNT(pt.paper_id)::int AS paper_count
      FROM tags t
      LEFT JOIN paper_tags pt ON t.id = pt.tag_id
      WHERE t.user_id = ${c.var.user.id}
      GROUP BY t.id, t.name
      ORDER BY t.name`;
    return c.json(rows.map((x) => ({ id: String(x.id), name: x.name, paper_count: x.paper_count })));
  });

  r.post('/', body(tagCreateSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const name = c.req.valid('json').name.trim();
    if (!name) throw new HttpError(400, 'Tag name cannot be empty');

    const [existing] = await sql`SELECT id FROM tags WHERE user_id = ${userId} AND name = ${name}`;
    if (existing) return c.json({ id: String(existing.id), name }, 201);

    const [row] = await sql`INSERT INTO tags (user_id, name) VALUES (${userId}, ${name}) RETURNING id`;
    logger.info({ name }, 'tag_created');
    return c.json({ id: String(row!.id), name }, 201);
  });

  // Static paths before /:tag_id.
  r.post('/assign', body(paperTagSchema), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const b = c.req.valid('json');
    const name = b.tag_name.trim();
    if (!name) throw new HttpError(400, 'Tag name cannot be empty');

    // Verify the paper belongs to the caller before touching tags.
    const [owned] = await sql`SELECT id FROM papers WHERE id = ${b.paper_id} AND user_id = ${userId}`;
    if (!owned) throw new HttpError(404, 'Paper not found');

    let [tag] = await sql`SELECT id FROM tags WHERE user_id = ${userId} AND name = ${name}`;
    if (!tag) [tag] = await sql`INSERT INTO tags (user_id, name) VALUES (${userId}, ${name}) RETURNING id`;
    const tagId = String(tag!.id);

    await sql`INSERT INTO paper_tags (paper_id, tag_id) VALUES (${b.paper_id}, ${tagId}) ON CONFLICT DO NOTHING`;
    logger.info({ paper_id: b.paper_id, tag: name }, 'tag_assigned');
    return c.json({ paper_id: b.paper_id, tag_id: tagId, tag_name: name }, 201);
  });

  r.delete('/assign/:paper_id/:tag_id', async (c) => {
    const { sql, logger } = c.var.deps;
    const paperId = c.req.param('paper_id');
    const tagId = c.req.param('tag_id');
    const userId = c.var.user.id;
    // Intentionally idempotent (R10 BP-3): an already-untagged pair is a no-op success.
    await sql`
      DELETE FROM paper_tags
      WHERE paper_id = ${paperId} AND tag_id = ${tagId}
        AND paper_id IN (SELECT id FROM papers WHERE user_id = ${userId})
        AND tag_id IN (SELECT id FROM tags WHERE user_id = ${userId})`;
    logger.info({ paper_id: paperId, tag_id: tagId }, 'tag_unassigned');
    await recordAudit(c, {
      action: 'tag.unassign',
      resourceType: 'paper',
      resourceId: paperId,
      metadata: { tag_id: tagId },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  r.get('/paper/:paper_id', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT t.id, t.name FROM tags t
      JOIN paper_tags pt ON t.id = pt.tag_id
      JOIN papers p ON pt.paper_id = p.id AND p.user_id = ${c.var.user.id}
      WHERE pt.paper_id = ${c.req.param('paper_id')}
      ORDER BY t.name`;
    return c.json(rows.map((x) => ({ id: String(x.id), name: x.name })));
  });

  r.delete('/:tag_id', async (c) => {
    const { sql, logger } = c.var.deps;
    const tagId = c.req.param('tag_id');
    const res = await sql`DELETE FROM tags WHERE id = ${tagId} AND user_id = ${c.var.user.id}`;
    if (res.count === 0) throw new HttpError(404, 'Tag not found');
    logger.info({ tag_id: tagId }, 'tag_deleted');
    await recordAudit(c, { action: 'tag.delete', resourceType: 'tag', resourceId: tagId, statusCode: 204 });
    return c.body(null, 204);
  });

  return r;
}
