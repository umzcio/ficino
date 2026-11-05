import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { feedStatusFromJob } from '../feed/status.js';
import { HttpError } from '../http/errors.js';
import { userRateLimit } from '../http/rateLimit.js';
import { body, pyInt, pyUuid } from '../http/validate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FeedGenerateRequest: every field optional/nullable, unknown keys ignored (zod strips them).
const generateSchema = z.object({
  corpus_id: pyUuid.nullish(),
  tag_filter: z.array(z.string()).nullish(),
  append_to_feed_id: z.string().nullish(),
  tab_focus: z.string().nullish(),
  persona_key: z.string().nullish(),
  num_posts: pyInt.nullish(),
});

export function feedRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.post('/generate', userRateLimit('feed_generation'), body(generateSchema), async (c) => {
    const { sql, queue, logger } = c.var.deps;
    const user = c.var.user;
    const req = c.req.valid('json');

    const [{ n }] = req.corpus_id
      ? await sql`SELECT COUNT(*)::int AS n FROM papers WHERE status = 'complete' AND corpus_id = ${req.corpus_id} AND user_id = ${user.id}`
      : await sql`SELECT COUNT(*)::int AS n FROM papers WHERE status = 'complete' AND user_id = ${user.id}`;
    if (n === 0) {
      throw new HttpError(400, 'No processed papers available. Upload and wait for processing to complete.');
    }

    const data: Record<string, unknown> = {
      corpus_id: req.corpus_id ? req.corpus_id : null,
      tag_filter: req.tag_filter ?? null,
      user_id: user.id,
    };
    if (req.append_to_feed_id) {
      // Ownership check: without it another user's feed id could be submitted and overwritten.
      // A non-UUID id cannot match a uuid column (Python 500s on the cast); answer 404 instead.
      const [owned] = UUID_RE.test(req.append_to_feed_id)
        ? await sql`SELECT 1 AS ok FROM feeds WHERE id = ${req.append_to_feed_id} AND user_id = ${user.id}`
        : [];
      if (!owned) throw new HttpError(404, 'Feed not found');
      data.append_to_feed_id = req.append_to_feed_id;
    }
    if (req.tab_focus) data.tab_focus = req.tab_focus;
    if (req.persona_key) data.persona_key = req.persona_key;
    if (req.num_posts) data.num_posts = req.num_posts;

    const taskId = await queue.send('generate_feed', data);
    logger.info({ task_id: taskId }, 'feed_generation_dispatched');
    return c.json({ task_id: taskId, status: 'queued' }, 202);
  });

  // No ownership check, as in Python: auth-gated only.
  r.get('/status/:task_id', async (c) => {
    const taskId = c.req.param('task_id');
    return c.json(feedStatusFromJob(taskId, await c.var.deps.queue.getJobState(taskId)));
  });

  return r;
}
