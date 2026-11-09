import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { apiLlm, llmErrorToHttp } from '../conversations/llm.js';
import { dmChunksText, dmPlan, type ConvoMessage } from '../conversations/prompts.js';
import { toPydanticIso } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { userRateLimit } from '../http/rateLimit.js';
import { body, params, pyInt, pyMaxLen } from '../http/validate.js';
import { LIMITS } from '../shared/constants.js';
import { mediaDeps, presentStoredPosts } from './postMedia.js';

const dmSchema = z.object({ message: pyMaxLen(2000) });
const deleteParams = z.object({ persona_key: z.string(), message_index: pyInt });

export function personasRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql } = c.var.deps;
    const rows = await sql`
      SELECT key, handle, name, initials, color, avatar_url, bio
      FROM personas WHERE is_active = true ORDER BY sort_order`;
    return c.json(rows.map((x) => ({ ...x })));
  });

  r.get('/:persona_key/stats', async (c) => {
    const { sql } = c.var.deps;
    const personaKey = c.req.param('persona_key');
    const [row] = await sql`
      SELECT COUNT(*)::int AS n FROM post_replies pr
      JOIN feeds f ON pr.feed_id = f.id
      WHERE pr.persona_key = ${personaKey} AND f.user_id = ${c.var.user.id}`;
    return c.json({ persona_key: personaKey, reply_threads: row?.n ?? 0 });
  });

  r.get('/:persona_key/replies', async (c) => {
    const { sql } = c.var.deps;
    const personaKey = c.req.param('persona_key');
    const rows = await sql`
      SELECT
        f.id                            AS feed_id,
        f.audio_status                  AS audio_status,
        pr.post_index                   AS post_index,
        (msg.idx - 1)::int              AS message_index,
        msg.value ->> 'content'         AS content,
        f.generated_at                  AS thread_generated_at,
        f.posts -> pr.post_index        AS parent_post
      FROM post_replies pr
      JOIN feeds f ON pr.feed_id = f.id
      CROSS JOIN LATERAL jsonb_array_elements(pr.messages)
        WITH ORDINALITY AS msg(value, idx)
      WHERE f.user_id = ${c.var.user.id}
        AND msg.value ->> 'persona' = ${personaKey}
        AND msg.value ->> 'role'    = 'interjection'
      ORDER BY f.generated_at DESC, pr.post_index, msg.idx
      LIMIT ${LIMITS.ACTIVITY}`;
    // The parent posts go out like GET /feed/:id's: media URLs re-signed from server-owned ids, never echoed.
    const parents = await presentStoredPosts(
      rows.map((x) => ({
        post: x.parent_post ?? {},
        feedId: String(x.feed_id),
        index: x.post_index as number,
        audioReady: x.audio_status === 'ready',
      })),
      c.var.user.id,
      mediaDeps(c),
    );
    return c.json(
      rows.map((x, i) => ({
        feed_id: String(x.feed_id),
        post_index: x.post_index,
        message_index: x.message_index,
        content: x.content ?? '',
        thread_generated_at: toPydanticIso(x.thread_generated_at),
        parent_post: parents[i],
      })),
    );
  });

  r.get('/:persona_key/dm', async (c) => {
    const { sql } = c.var.deps;
    const personaKey = c.req.param('persona_key');
    const [row] = await sql`
      SELECT id, messages FROM persona_dms WHERE user_id = ${c.var.user.id} AND persona_key = ${personaKey}`;
    if (!row) return c.json({ messages: [], persona_key: personaKey });
    return c.json({ id: String(row.id), messages: row.messages, persona_key: personaKey });
  });

  r.post('/:persona_key/dm', userRateLimit('persona_dm'), body(dmSchema), async (c) => {
    const deps = c.var.deps;
    const { sql, logger } = deps;
    const userId = c.var.user.id;
    const personaKey = c.req.param('persona_key');
    const { message } = c.req.valid('json');

    const [row] = await sql`
      SELECT id, messages FROM persona_dms WHERE user_id = ${userId} AND persona_key = ${personaKey}`;
    // Local snapshot for the prompt and the response; the persisted turns are appended atomically below.
    const existing: ConvoMessage[] = row ? [...(row.messages as ConvoMessage[])] : [];
    const userTurn: ConvoMessage = { role: 'user', content: message };
    existing.push(userTurn);

    const [persona] = await sql`
      SELECT system_prompt, name, handle, bio FROM personas WHERE key = ${personaKey} AND is_active = true`;
    if (!persona) throw new HttpError(404, 'Persona not found');

    let chunks = await sql`
      SELECT c.content, c.section, p.title AS paper_title
      FROM chunks c JOIN papers p ON c.paper_id = p.id
      WHERE p.status = 'complete' AND p.user_id = ${userId}
        AND c.search_vector @@ plainto_tsquery('english', ${message}::text)
      ORDER BY ts_rank(c.search_vector, plainto_tsquery('english', ${message}::text)) DESC
      LIMIT 10`;
    if (chunks.length === 0) {
      chunks = await sql`
        SELECT c.content, c.section, p.title AS paper_title
        FROM chunks c JOIN papers p ON c.paper_id = p.id
        WHERE p.status = 'complete' AND p.user_id = ${userId}
        ORDER BY p.uploaded_at DESC, c.chunk_index ASC
        LIMIT 10`;
    }

    const plan = dmPlan(
      { system_prompt: String(persona.system_prompt), name: String(persona.name), handle: String(persona.handle) },
      dmChunksText(chunks as unknown as Parameters<typeof dmChunksText>[0]),
      existing,
    );
    let response: string;
    try {
      response = await (await apiLlm(deps, userId)).chat(plan);
    } catch (e) {
      throw llmErrorToHttp(e, 'persona_dm_failed', logger);
    }

    const personaTurn: ConvoMessage = { role: 'persona', content: response };
    existing.push(personaTurn);

    const [saved] = await sql`
      INSERT INTO persona_dms (user_id, persona_key, messages)
      VALUES (${userId}, ${personaKey}, ${sql.json([userTurn, personaTurn] as never)})
      ON CONFLICT (user_id, persona_key) DO UPDATE
        SET messages = persona_dms.messages || EXCLUDED.messages,
            updated_at = NOW()
      RETURNING id`;
    logger.info({ persona: personaKey, turns: existing.length }, 'persona_dm_sent');
    return c.json({ id: String(saved!.id), messages: existing, latest_response: response });
  });

  r.delete('/:persona_key/dm/:message_index', params(deleteParams), async (c) => {
    const { sql, logger } = c.var.deps;
    const userId = c.var.user.id;
    const { persona_key: personaKey, message_index: idx } = c.req.valid('param');
    const [row] = await sql`
      SELECT jsonb_array_length(messages) AS n FROM persona_dms
      WHERE user_id = ${userId} AND persona_key = ${personaKey}`;
    if (!row) throw new HttpError(404, 'No DM thread with this persona');
    if (idx < 0 || idx >= Number(row.n)) throw new HttpError(404, 'Message index out of range');
    const [updated] = await sql`
      UPDATE persona_dms SET messages = messages - ${idx}::int, updated_at = NOW()
      WHERE user_id = ${userId} AND persona_key = ${personaKey} RETURNING messages`;
    // A clear that lands between the SELECT and the UPDATE leaves no row to update.
    if (!updated) throw new HttpError(404, 'No DM thread with this persona');
    logger.info({ persona: personaKey, index: idx }, 'persona_dm_message_deleted');
    await recordAudit(c, {
      action: 'persona_dm.delete_message',
      resourceType: 'persona_dm',
      metadata: { persona_key: personaKey, message_index: idx },
    });
    return c.json({ messages: updated.messages });
  });

  r.delete('/:persona_key/dm', async (c) => {
    const { sql, logger } = c.var.deps;
    const personaKey = c.req.param('persona_key');
    const res = await sql`DELETE FROM persona_dms WHERE user_id = ${c.var.user.id} AND persona_key = ${personaKey}`;
    if (res.count === 0) throw new HttpError(404, 'No DM thread with this persona');
    logger.info({ persona: personaKey }, 'persona_dm_cleared');
    await recordAudit(c, {
      action: 'persona_dm.clear',
      resourceType: 'persona_dm',
      metadata: { persona_key: personaKey },
    });
    return c.json({ messages: [] });
  });

  return r;
}
