// Port of worker/tasks/alert_tasks.py (_dedupe_hash, _create_alert, check_stale_papers).
import { createHash } from 'node:crypto';
import type { Sql } from '../db/sql.js';

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
