// Port of worker/tasks/preference_tasks.py.
import type { Sql } from '../db/sql.js';
import type { JobContext } from '../jobs/context.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pyRound } from '../shared/pystr.js';
import type { WorkerDeps } from '../worker/handlers.js';

/** Minimum likes before preferences kick in. */
export const MIN_LIKES_THRESHOLD = 5;
/** Extra weight an annotated like gets. */
export const ANNOTATION_BOOST = 2.0;

export type Preferences = {
  persona_weights: Record<string, number>;
  post_type_weights: Record<string, number>;
  category_weights: Record<string, number>;
  liked_paper_titles: string[];
  total_likes: number;
  has_signal: boolean;
};

/** Counts to weights summing to 1.0; Map keeps Python's first-seen key order (and any key spelling). */
function normalize(counts: Map<string, number>): Record<string, number> {
  let total = 0;
  for (const v of counts.values()) total += v;
  if (total === 0) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of counts) out[k] = pyRound(v / total, 4);
  return out;
}

function bump(m: Map<string, number>, key: string | null, w: number): void {
  if (key) m.set(key, (m.get(key) ?? 0) + w);
}

export async function computePreferences(
  data: { user_id?: string | null },
  ctx: JobContext,
  deps: WorkerDeps,
): Promise<Preferences> {
  const { sql } = deps;
  const uid = data.user_id || STUB_USER_ID;
  const log = deps.logger.child({ user_id: uid });

  const likes = await sql<
    { feed_id: string; post_index: number; persona_key: string | null; post_type: string | null; category: string | null }[]
  >`
    SELECT ul.feed_id, ul.post_index, ul.persona_key, ul.post_type, ul.category, ul.liked_at
    FROM user_likes ul
    WHERE ul.user_id = ${uid}`;

  const total = likes.length;
  if (total < MIN_LIKES_THRESHOLD) {
    const preferences: Preferences = {
      persona_weights: {},
      post_type_weights: {},
      category_weights: {},
      liked_paper_titles: [],
      total_likes: total,
      has_signal: false,
    };
    await storePreferences(sql, uid, preferences);
    log.info({ total_likes: total, has_signal: false }, 'preferences_computed');
    return preferences;
  }

  const annotated = new Set<string>();
  const annotationRows = await sql<{ feed_id: string; post_index: number }[]>`
    SELECT DISTINCT feed_id, post_index FROM annotations
    WHERE user_id = ${uid}`;
  for (const row of annotationRows) annotated.add(`${String(row.feed_id)}|${row.post_index}`);

  const personaCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  for (const like of likes) {
    const weight = annotated.has(`${String(like.feed_id)}|${like.post_index}`) ? ANNOTATION_BOOST : 1.0;
    bump(personaCounts, like.persona_key, weight);
    bump(typeCounts, like.post_type, weight);
    bump(categoryCounts, like.category, weight);
  }

  const persona_weights = normalize(personaCounts);
  const post_type_weights = normalize(typeCounts);
  const category_weights = normalize(categoryCounts);
  const liked_paper_titles = await getLikedPaperTitles(sql, uid);

  const preferences: Preferences = {
    persona_weights,
    post_type_weights,
    category_weights,
    liked_paper_titles,
    total_likes: total,
    has_signal: true,
  };
  await storePreferences(sql, uid, preferences);
  log.info(
    { total_likes: total, personas: persona_weights, types: post_type_weights, categories: category_weights, liked_papers: liked_paper_titles.length },
    'preferences_computed',
  );
  return preferences;
}

/** Unique paper_ref values and sources[*].paper_title values of liked posts, extracted in SQL. */
async function getLikedPaperTitles(sql: Sql, userId: string): Promise<string[]> {
  const rows = await sql<{ ref: string | null; title: string | null }[]>`
    WITH liked_posts AS (
      SELECT f.posts->ul.post_index AS post
      FROM user_likes ul
      JOIN feeds f ON f.id = ul.feed_id
      WHERE ul.user_id = ${userId}
        AND ul.post_index >= 0
        AND ul.post_index < jsonb_array_length(f.posts)
    )
    SELECT post->>'paper_ref' AS ref,
           src->>'paper_title' AS title
    FROM liked_posts
    LEFT JOIN LATERAL jsonb_array_elements(
      COALESCE(post->'sources', '[]'::jsonb)
    ) AS src ON true`;
  const titles = new Set<string>();
  for (const row of rows) {
    if (row.ref) titles.add(row.ref);
    if (row.title) titles.add(row.title);
  }
  return [...titles];
}

/** Writes only the `preferences` key so a concurrent PUT /settings is not clobbered. */
async function storePreferences(sql: Sql, userId: string, preferences: Preferences): Promise<void> {
  await sql`
    INSERT INTO user_settings (user_id, settings, updated_at)
    VALUES (${userId}, jsonb_build_object('preferences', ${sql.json(preferences as never)}::jsonb), NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET settings = jsonb_set(
            COALESCE(user_settings.settings, '{}'::jsonb),
            ARRAY['preferences'],
            ${sql.json(preferences as never)}::jsonb,
            true
          ),
          updated_at = NOW()`;
}
