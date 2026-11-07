import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { loadConversationAndSources, loadGrounding } from '../conversations/grounding.js';
import { apiLlm, llmErrorToHttp } from '../conversations/llm.js';
import {
  interjectionPlan,
  mentionedHandles,
  mentionPlan,
  replyMainPlan,
  zapPlan,
  type ConvoMessage,
  type LlmPlan,
  type PersonaMeta,
  type PersonaRow,
} from '../conversations/prompts.js';
import type { Sql } from '../db/sql.js';
import { toIsoformat } from '../db/time.js';
import { HttpError } from '../http/errors.js';
import { userRateLimit } from '../http/rateLimit.js';
import { body, params, pyInt, pyMaxLen } from '../http/validate.js';
import { LIMITS } from '../shared/constants.js';
import { pyStr } from '../shared/pystr.js';
import { isUuid } from '../shared/uuid.js';

const threadParams = z.object({ feed_id: z.string(), post_index: pyInt });
const deleteParams = z.object({ feed_id: z.string(), post_index: pyInt, message_index: pyInt });
const replySchema = z.object({
  feed_id: z.string(),
  post_index: pyInt,
  persona_key: z.string(),
  user_message: pyMaxLen(2000),
  post_content: pyMaxLen(4000),
  paper_ref: pyMaxLen(500).nullish(),
});
const zapSchema = z.object({
  feed_id: z.string(),
  post_index: pyInt,
  target_persona_key: z.string(),
  source_persona_key: z.string(),
  source_message: pyMaxLen(2000),
  post_content: pyMaxLen(4000),
  paper_ref: pyMaxLen(500).nullish(),
});

/** The caller owns `feedId`, or 404. A non-UUID id cannot match the uuid column (Python 500s on the cast). */
async function requireOwnedFeed(sql: Sql, feedId: string, userId: string): Promise<void> {
  const [owner] = isUuid(feedId)
    ? await sql`SELECT id FROM feeds WHERE id = ${feedId} AND user_id = ${userId}`
    : [];
  if (!owner) throw new HttpError(404, 'Feed not found');
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The new turns are appended with `||`, so a concurrent reply's turns are never overwritten. */
async function upsertTurns(
  sql: Sql,
  o: { feedId: string; postIndex: number; personaKey: string; turns: ConvoMessage[] },
): Promise<{ id: string; messages: ConvoMessage[] }> {
  const [row] = await sql`
    INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
    VALUES (${o.feedId}, ${o.postIndex}, ${o.personaKey}, ${sql.json(o.turns as never)})
    ON CONFLICT (feed_id, post_index) DO UPDATE
      SET messages = post_replies.messages || EXCLUDED.messages,
          updated_at = NOW()
    RETURNING id, messages`;
  return { id: String(row!.id), messages: row!.messages as ConvoMessage[] };
}

export function repliesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/conversations', async (c) => {
    const { sql } = c.var.deps;
    // WITH ORDINALITY so ORDER BY ord DESC finds the LATEST turn of each role.
    const rows = await sql`
      SELECT pr.id, pr.feed_id, pr.post_index, pr.persona_key, pr.updated_at,
             COALESCE(jsonb_array_length(pr.messages), 0)::int AS message_count,
             COALESCE(
               (SELECT LEFT(m->>'content', 100)
                FROM jsonb_array_elements(pr.messages) WITH ORDINALITY AS t(m, ord)
                WHERE m->>'role' = 'user'
                ORDER BY ord DESC LIMIT 1),
               ''
             ) AS last_user,
             COALESCE(
               (SELECT LEFT(m->>'content', 100)
                FROM jsonb_array_elements(pr.messages) WITH ORDINALITY AS t(m, ord)
                WHERE m->>'role' = 'persona'
                ORDER BY ord DESC LIMIT 1),
               ''
             ) AS last_persona
      FROM post_replies pr
      JOIN feeds f ON pr.feed_id = f.id AND f.user_id = ${c.var.user.id}
      ORDER BY pr.updated_at DESC
      LIMIT ${LIMITS.ACTIVITY}`;
    return c.json(
      rows.map((x) => ({
        id: String(x.id),
        feed_id: String(x.feed_id),
        post_index: x.post_index,
        persona_key: x.persona_key,
        message_count: x.message_count,
        last_user_message: x.last_user,
        last_persona_message: x.last_persona,
        updated_at: toIsoformat(x.updated_at),
      })),
    );
  });

  r.get('/replied-posts/:feed_id', async (c) => {
    const { sql } = c.var.deps;
    const feedId = c.req.param('feed_id');
    // A non-UUID id cannot match a uuid column (Python 500s on the cast); answer empty instead.
    if (!isUuid(feedId)) return c.json([]);
    const rows = await sql`
      SELECT pr.post_index FROM post_replies pr
      JOIN feeds f ON pr.feed_id = f.id AND f.user_id = ${c.var.user.id}
      WHERE pr.feed_id = ${feedId}`;
    return c.json(rows.map((x) => x.post_index as number));
  });

  r.post('/', userRateLimit('reply'), body(replySchema), async (c) => {
    const deps = c.var.deps;
    const { sql, logger } = deps;
    const userId = c.var.user.id;
    const b = c.req.valid('json');
    await requireOwnedFeed(sql, b.feed_id, userId);

    const { messages: snapshot, postSources } = await loadConversationAndSources(sql, userId, b.feed_id, b.post_index);
    // Only history.slice(initialLen) is written back, appended with ||, so concurrent replies both land.
    const history: ConvoMessage[] = [...snapshot];
    const initialLen = history.length;
    history.push({ role: 'user', content: b.user_message });

    const [persona] = await sql`
      SELECT system_prompt FROM personas WHERE key = ${b.persona_key} AND is_active = true`;
    const personaPrompt = persona?.system_prompt ? String(persona.system_prompt) : `You are ${b.persona_key}`;

    const { chunksText } = await loadGrounding(sql, {
      userId,
      postSources,
      postContent: b.post_content,
      userMessage: b.user_message,
      paperRef: b.paper_ref ?? null,
    });
    const main = replyMainPlan({ personaPrompt, postContent: b.post_content, chunksText, history });

    // At most 3 handles, each one SQL lookup; a miss (or the replying persona itself) is skipped.
    const handles = mentionedHandles(b.user_message);
    const mentions: Array<LlmPlan & { meta: PersonaMeta; handle: string }> = [];
    for (const handle of handles) {
      const [mentioned] = await sql`
        SELECT key, name, handle, system_prompt FROM personas
        WHERE handle = ${'@' + handle} AND is_active = true AND key <> ${b.persona_key}`;
      if (!mentioned) continue;
      const plan = mentionPlan({ mentioned: mentioned as unknown as PersonaRow, history, postContent: b.post_content, chunksText });
      mentions.push({ ...plan, handle });
    }

    // Organic only when no handle was even attempted (checked before the calls so they run in parallel).
    let organic: (LlmPlan & { meta: PersonaMeta }) | null = null;
    if (handles.length === 0 && history.filter((m) => m.role === 'user').length >= 2) {
      try {
        // ORDER BY sort_order: deliberate change 3 (Python had none, so ties fell to heap order).
        const candidates = await sql`
          SELECT key, name, handle, system_prompt, retrieval_query FROM personas
          WHERE is_active = true AND key <> ${b.persona_key}
          ORDER BY sort_order`;
        organic = interjectionPlan(
          deps.rng,
          { candidates: candidates as unknown as PersonaRow[], history, postContent: b.post_content, chunksText },
          logger,
        );
      } catch (e) {
        logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'interjection_prepare_failed');
      }
    }

    // One settings resolution for the caller, shared by every call of this request.
    const llm = await apiLlm(deps, userId);
    const call = (p: LlmPlan) =>
      llm.chat({ system: p.system, messages: p.messages, maxTokens: p.maxTokens, temperature: p.temperature });
    const [mainRes, ...rest] = await Promise.allSettled([
      call(main),
      ...mentions.map(call),
      ...(organic ? [call(organic)] : []),
    ]);
    if (mainRes!.status === 'rejected') throw llmErrorToHttp(mainRes!.reason, 'reply_generation_failed', logger);
    const latestResponse = mainRes!.value;
    history.push({ role: 'persona', content: latestResponse });

    const interjections: Array<PersonaMeta & { content: string }> = [];
    mentions.forEach((plan, i) => {
      const res = rest[i]!;
      if (res.status === 'rejected') {
        logger.warn({ handle: plan.handle, error: errorText(res.reason) }, 'mention_interjection_failed');
        return;
      }
      history.push({ role: 'interjection', persona: plan.meta.persona_key, content: res.value });
      interjections.push({ ...plan.meta, content: res.value });
      logger.info({ persona: plan.meta.persona_key, handle: plan.handle }, 'mention_interjection_generated');
    });

    let interjection: (PersonaMeta & { content: string }) | null = null;
    if (organic) {
      const res = rest[mentions.length]!;
      if (res.status === 'rejected') {
        logger.warn({ error: errorText(res.reason) }, 'interjection_failed');
      } else {
        history.push({ role: 'interjection', persona: organic.meta.persona_key, content: res.value });
        interjection = { ...organic.meta, content: res.value };
        logger.info({ persona: organic.meta.persona_key }, 'interjection_generated');
      }
    }

    const saved = await upsertTurns(sql, {
      feedId: b.feed_id,
      postIndex: b.post_index,
      personaKey: b.persona_key,
      turns: history.slice(initialLen),
    });
    logger.info({ persona: b.persona_key, turns: saved.messages.length }, 'reply_generated');
    // The RETURNING messages include any turns a concurrent reply landed after our read.
    const result: Record<string, unknown> = { id: saved.id, messages: saved.messages, latest_response: latestResponse };
    if (interjections.length > 0) result.interjections = interjections;
    else if (interjection) result.interjection = interjection;
    return c.json(result);
  });

  r.post('/zap', userRateLimit('reply'), body(zapSchema), async (c) => {
    const deps = c.var.deps;
    const { sql, logger } = deps;
    const userId = c.var.user.id;
    const b = c.req.valid('json');
    await requireOwnedFeed(sql, b.feed_id, userId);

    const [target] = await sql`
      SELECT key, name, handle, system_prompt FROM personas WHERE key = ${b.target_persona_key} AND is_active = true`;
    if (!target) throw new HttpError(404, 'Target persona not found');
    // Not filtered on is_active, as in Python.
    const [source] = await sql`SELECT name, handle FROM personas WHERE key = ${b.source_persona_key}`;
    const sourceName = source ? pyStr(source.name) : b.source_persona_key;

    const { replyId, messages, postSources } = await loadConversationAndSources(sql, userId, b.feed_id, b.post_index);
    const { chunksText } = await loadGrounding(sql, {
      userId,
      postSources,
      postContent: b.post_content,
      userMessage: b.source_message,
      paperRef: b.paper_ref ?? null,
    });
    const plan = zapPlan({
      target: target as unknown as PersonaRow,
      sourceName,
      history: messages,
      postContent: b.post_content,
      sourceMessage: b.source_message,
      chunksText,
    });

    let content: string;
    try {
      content = await (await apiLlm(deps, userId)).chat(plan);
    } catch (e) {
      throw llmErrorToHttp(e, 'zap_failed', logger);
    }

    const newTurn: ConvoMessage = { role: 'interjection', persona: String(target.key), content };
    let id: string;
    let out: ConvoMessage[];
    if (replyId) {
      await sql`
        UPDATE post_replies SET messages = messages || ${sql.json([newTurn] as never)}, updated_at = NOW()
        WHERE id = ${replyId}`;
      id = replyId;
      out = [...messages, newTurn];
    } else {
      // Two zaps that both saw no row would collide on the unique key; the upsert appends instead.
      const saved = await upsertTurns(sql, {
        feedId: b.feed_id,
        postIndex: b.post_index,
        personaKey: b.source_persona_key,
        turns: [newTurn],
      });
      id = saved.id;
      out = saved.messages;
    }
    logger.info({ target: b.target_persona_key, source: b.source_persona_key }, 'zap_generated');
    return c.json({ id, messages: out, persona_key: target.key, content });
  });

  r.get('/:feed_id/:post_index', params(threadParams), async (c) => {
    const { sql } = c.var.deps;
    const { feed_id: feedId, post_index: postIndex } = c.req.valid('param');
    const [row] = isUuid(feedId)
      ? await sql`
          SELECT pr.id, pr.messages, pr.persona_key FROM post_replies pr
          JOIN feeds f ON pr.feed_id = f.id AND f.user_id = ${c.var.user.id}
          WHERE pr.feed_id = ${feedId} AND pr.post_index = ${postIndex}`
      : [];
    if (!row) return c.json({ messages: [], persona_key: null });
    return c.json({ id: String(row.id), messages: row.messages, persona_key: row.persona_key });
  });

  r.delete('/:feed_id/:post_index/message/:message_index', params(deleteParams), async (c) => {
    const { sql } = c.var.deps;
    const { feed_id: feedId, post_index: postIndex, message_index: idx } = c.req.valid('param');
    const [owner] = isUuid(feedId)
      ? await sql`SELECT id FROM feeds WHERE id = ${feedId} AND user_id = ${c.var.user.id}`
      : [];
    if (!owner) throw new HttpError(404, 'Feed not found');
    const [row] = await sql`
      SELECT id, jsonb_array_length(messages) AS n FROM post_replies
      WHERE feed_id = ${feedId} AND post_index = ${postIndex}`;
    if (!row) throw new HttpError(404, 'Reply thread not found');
    if (idx < 0 || idx >= Number(row.n)) throw new HttpError(404, 'Message not found');
    // Single statement; jsonb - int removes the element atomically. updated_at is untouched, as in Python.
    await sql`
      UPDATE post_replies SET messages = messages - ${idx}::int
      WHERE feed_id = ${feedId} AND post_index = ${postIndex}`;
    await recordAudit(c, {
      action: 'reply.delete_message',
      resourceType: 'reply',
      metadata: { feed_id: feedId, post_index: postIndex, message_index: idx },
      statusCode: 204,
    });
    return c.body(null, 204);
  });

  return r;
}
