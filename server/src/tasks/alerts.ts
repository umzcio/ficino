// Port of worker/tasks/alert_tasks.py (_dedupe_hash, _create_alert, check_stale_papers).
import { createHash } from 'node:crypto';
import type { Sql } from '../db/sql.js';
import { classifyContradictionsBatch } from '../feed/llmPost.js';
import type { JobContext } from '../jobs/context.js';
import { loadJobSettings } from '../providers/config.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pySlice } from '../shared/pystr.js';
import { choice } from '../shared/random.js';
import type { WorkerDeps } from '../worker/handlers.js';

/** sha256 of the sorted parts joined with `|`, hex, first 32 chars. Sorting makes (a, b) equal (b, a). */
export function dedupeHash(...parts: string[]): string {
  const payload = [...parts].sort().join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}

export async function createAlert(
  sql: Sql,
  a: {
    userId: string;
    alertType: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
    dedupeHash: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO alerts (user_id, alert_type, title, body, metadata, dedupe_hash)
    VALUES (${a.userId}, ${a.alertType}, ${a.title}, ${a.body}, ${sql.json((a.metadata ?? {}) as never)}, ${a.dedupeHash})
    ON CONFLICT (user_id, alert_type, dedupe_hash)
      WHERE dedupe_hash IS NOT NULL
      DO NOTHING`;
}

/** Alerts each paper's owner about completed papers older than 7 days that no feed of theirs covers. */
export async function checkStalePapers(sql: Sql): Promise<{ status: 'complete'; stale_count: number }> {
  const stale = await sql`
    SELECT p.id, p.user_id, p.title, p.filename, p.uploaded_at
    FROM papers p
    WHERE p.status = 'complete'
    AND p.uploaded_at < NOW() - INTERVAL '7 days'
    AND NOT EXISTS (
        SELECT 1 FROM feeds f
        WHERE f.user_id = p.user_id
          AND (f.corpus_id = p.corpus_id OR f.corpus_id IS NULL)
    )`;
  for (const paper of stale) {
    const title = (paper.title as string | null) || (paper.filename as string);
    await createAlert(sql, {
      userId: String(paper.user_id),
      alertType: 'stale_paper',
      title: 'Unused paper in your corpus',
      body: `"${title}" has been in your corpus for over a week but hasn't been part of any feed generation. Consider generating a feed or removing it.`,
      metadata: { paper_id: String(paper.id), paper_title: title },
      dedupeHash: dedupeHash('stale_paper', String(paper.id)),
    });
  }
  return { status: 'complete', stale_count: stale.length };
}

const SKIPPED_SECTIONS = ['references', 'bibliography', 'acknowledgments', 'funding'];

/** Compares a newly ingested paper's chunks with up to 8 other complete papers in its corpus (3 sampled pairs each). */
export async function checkContradictions(
  data: { paper_id: string },
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<{ status: 'skipped'; reason: string } | { status: 'complete'; contradictions: number }> {
  const { sql } = deps;
  const paperId = data.paper_id;
  const log = ctx.logger.child({ paper_id: paperId, task_id: ctx.jobId });
  log.info('contradiction_check_start');
  try {
    const [paper] = await sql`SELECT id, title, filename, corpus_id, user_id FROM papers WHERE id = ${paperId}`;
    if (!paper) return { status: 'skipped', reason: 'paper_not_found' };

    const paperTitle = (paper.title as string | null) || (paper.filename as string);
    const paperUserId = paper.user_id ? String(paper.user_id) : STUB_USER_ID;
    // Classification runs under the paper owner's provider settings.
    const { providers } = await loadJobSettings(sql, paperUserId, deps.env, deps.config);

    // corpus_id = NULL matches nothing, so a paper without a corpus is skipped, as in Python.
    const otherPapers = await sql`
      SELECT id, title, filename FROM papers
      WHERE corpus_id = ${paper.corpus_id as string | null} AND id != ${paperId} AND status = 'complete'
      ORDER BY random() LIMIT 8`;
    if (otherPapers.length === 0) {
      log.info('no_other_papers_to_compare');
      return { status: 'skipped', reason: 'no_other_papers' };
    }

    const newChunks = await sql`
      SELECT content, section FROM chunks
      WHERE paper_id = ${paperId} AND section NOT IN ${sql(SKIPPED_SECTIONS)}
      ORDER BY chunk_index LIMIT 8`;
    if (newChunks.length === 0) return { status: 'skipped', reason: 'no_chunks' };

    const otherIds = otherPapers.map((o) => String(o.id));
    const otherChunkRows = await sql`
      SELECT paper_id, content, section FROM chunks
      WHERE paper_id = ANY(${otherIds}::uuid[]) AND section NOT IN ${sql(SKIPPED_SECTIONS)}
      ORDER BY paper_id, chunk_index`;
    const chunksByPaper = new Map<string, string[]>();
    for (const row of otherChunkRows) {
      const k = String(row.paper_id);
      const list = chunksByPaper.get(k) ?? [];
      list.push(row.content as string);
      chunksByPaper.set(k, list);
    }

    const pairs: [string, string][] = [];
    const pairMeta: Array<{ otherId: string; otherTitle: string; chunkA: string; chunkB: string }> = [];
    for (const other of otherPapers) {
      const otherId = String(other.id);
      const otherTitle = (other.title as string | null) || (other.filename as string);
      const otherChunks = (chunksByPaper.get(otherId) ?? []).slice(0, 8);
      if (otherChunks.length === 0) continue;
      for (let i = 0; i < 3; i++) {
        const nc = choice(deps.rng, newChunks).content as string;
        const oc = choice(deps.rng, otherChunks);
        pairs.push([nc, oc]);
        pairMeta.push({ otherId, otherTitle, chunkA: nc, chunkB: oc });
      }
    }
    if (pairs.length === 0) {
      log.info('no_pairs_to_classify');
      return { status: 'complete', contradictions: 0 };
    }

    const results = await classifyContradictionsBatch(providers, deps.providers, pairs, {
      concurrency: 5,
      signal: ctx.signal,
      logger: log,
    });

    let found = 0;
    const seen = new Set<string>();
    for (const [i, m] of pairMeta.entries()) {
      if (seen.has(m.otherId)) continue;
      if (results[i] === 'contradicts') {
        found++;
        seen.add(m.otherId);
        await createAlert(sql, {
          userId: paperUserId,
          alertType: 'contradiction',
          title: 'Contradiction detected',
          body: `"${paperTitle}" challenges a finding in "${m.otherTitle}". The papers present conflicting evidence on overlapping topics.`,
          metadata: {
            new_paper_id: paperId,
            other_paper_id: m.otherId,
            new_paper_title: paperTitle,
            other_paper_title: m.otherTitle,
            chunk_a_preview: pySlice(m.chunkA, 0, 200),
            chunk_b_preview: pySlice(m.chunkB, 0, 200),
          },
          dedupeHash: dedupeHash('contradiction', paperId, m.otherId),
        });
      }
    }
    log.info({ contradictions: found }, 'contradiction_check_complete');
    return { status: 'complete', contradictions: found };
  } catch (e) {
    log.error({ error: e instanceof Error ? e.message : String(e) }, 'contradiction_check_failed');
    throw e;
  }
}

/** Alerts on a debate-heavy feed (more than half quotes/replies) and on debated papers the owner never summarized. */
export async function checkPostFeed(
  data: { feed_id: string },
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<{ status: 'skipped' | 'complete' }> {
  const { sql } = deps;
  const feedId = data.feed_id;
  const log = ctx.logger.child({ feed_id: feedId, task_id: ctx.jobId });
  log.info('post_feed_check_start');
  try {
    const [feed] = await sql`SELECT user_id, posts, post_count FROM feeds WHERE id = ${feedId}`;
    if (!feed) return { status: 'skipped' };
    let posts = feed.posts as unknown;
    if (typeof posts === 'string') posts = JSON.parse(posts);
    // Python falsy: null, empty list or empty dict.
    if (!posts || (Array.isArray(posts) && posts.length === 0)) return { status: 'skipped' };
    if (!Array.isArray(posts)) return { status: 'skipped' };

    const ownerId = String(feed.user_id);
    // Runs no LLM call today; resolves the owner's settings so a future one is scoped correctly.
    await loadJobSettings(sql, ownerId, deps.env, deps.config);

    const list = posts as Array<Record<string, unknown>>;
    const debateCount = list.filter((p) => p.post_type === 'quote' || p.post_type === 'reply').length;
    const total = list.length;
    if (total > 0 && debateCount / total > 0.5) {
      await createAlert(sql, {
        userId: ownerId,
        alertType: 'disagreement_spike',
        title: 'High-debate feed generated',
        body: `Your latest feed has ${debateCount} debate posts out of ${total} \u2014 the personas are really arguing. Something in your corpus is provocative.`,
        metadata: { feed_id: feedId, debate_count: debateCount, total },
        dedupeHash: dedupeHash('disagreement_spike', feedId),
      });
    }

    const paperRefs = new Set<string>();
    for (const p of list) {
      const ref = p.paper_ref;
      if (typeof ref === 'string' && ref) paperRefs.add(ref);
    }
    if (paperRefs.size > 0) {
      const unsummarized = await sql`
        SELECT p.id, p.title, p.filename FROM papers p
        LEFT JOIN paper_summaries ps ON p.id = ps.paper_id
        WHERE ps.id IS NULL AND p.status = 'complete' AND p.user_id = ${ownerId}`;
      for (const paper of unsummarized) {
        const title = (paper.title as string | null) || (paper.filename as string);
        if ([...paperRefs].some((ref) => ref.includes(title))) {
          await createAlert(sql, {
            userId: ownerId,
            alertType: 'reading_gap',
            title: 'Go deeper on this paper',
            body: `Personas are debating "${title}" in your feeds, but you haven't read its summary yet. Tap to explore.`,
            metadata: { paper_id: String(paper.id), paper_title: title },
            dedupeHash: dedupeHash('reading_gap', String(paper.id)),
          });
        }
      }
    }
    log.info('post_feed_check_complete');
    return { status: 'complete' };
  } catch (e) {
    log.error({ error: e instanceof Error ? e.message : String(e) }, 'post_feed_check_failed');
    throw e;
  }
}
