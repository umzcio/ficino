/**
 * E2E fixture seeding — plan 036.
 *
 * Mechanism choice (plan step 1): **A. DB fixture insert**. Every converted
 * conditional-skip site exercises READ paths only (feed rendering, thread /
 * figure / sources / reply UI, bookmark toggle, feed history, paper chat
 * open). The bookmark toggle hits the real `/bookmarks` API, which only
 * requires an owned feed row — no LLM involvement anywhere. Mechanism B
 * (API-driven seeding through real generation) was rejected: slow,
 * LLM-dependent, costs API spend, and nothing in the converted specs needs
 * real generation output.
 *
 * What this seeds (all owned by the AUTH_PROVIDER=none stub user, in the
 * Default workspace a fresh browser context boots into):
 *   - one `papers` row (status complete, chunk_count > 0) — Messages →
 *     Papers tab entry, keeps R2-9.2's orphan check green
 *   - one `figures` row + a real PNG in the api container's figures volume,
 *     so the figure post's `figure_id` resolves through the normal
 *     `_hydrate_figure_urls` re-sign path (LocalStorage backend serves it at
 *     /figures/{paper}/{figure}?token=… via the frontend proxy)
 *   - two `feeds` rows with hand-written JSONB posts covering every rendered
 *     variant the specs select for: plain post with sources, thread post,
 *     figure post, plain post. Two feeds so FeedHistory (which renders only
 *     when >1 feed with posts exists) and the history-switching test have
 *     something to switch between.
 *
 * Idempotency: fixed fixture ids in the reserved `e2e00000-…` uuid
 * namespace + INSERT … ON CONFLICT (id) DO UPDATE. `generated_at` is
 * re-stamped to now() on every run so the fixture feed is the newest in the
 * Default workspace and `useFeed` picks it as the current feed regardless of
 * what junk the shared dev DB has accumulated. `tag_filter` carries the
 * 'e2e-fixture' marker so fixtures stay identifiable for any future dev-DB
 * cleanup script (see plan 036 maintenance notes).
 *
 * Cleanup policy: leave-in-place. The dev DB already accumulates junk
 * (settled R10.5 deferral) and the fixtures are idempotent, so specs do NOT
 * call cleanupFixtures() — it exists for a future scratch-CI database
 * (plan 037) and manual use.
 *
 * Plan 037 compatibility: the psql/api targets are parameterized via env so
 * the same helper can run against a scratch stack:
 *   E2E_PSQL_CONTAINER (default ficino-e2e-postgres), E2E_PSQL_USER (ficino),
 *   E2E_PSQL_DB (ficino), E2E_API_CONTAINER (ficino-e2e-api),
 *   E2E_FIGURES_DIR (/app/figures)
 */
import { execFileSync } from 'node:child_process'

const PSQL_CONTAINER = process.env.E2E_PSQL_CONTAINER || 'ficino-e2e-postgres'
const PSQL_USER = process.env.E2E_PSQL_USER || 'ficino'
const PSQL_DB = process.env.E2E_PSQL_DB || 'ficino'
const API_CONTAINER = process.env.E2E_API_CONTAINER || 'ficino-e2e-api'
const FIGURES_DIR = process.env.E2E_FIGURES_DIR || '/app/figures'

/** Reserved fixture uuid namespace — do not reuse outside this helper. */
export const FIXTURE = {
  userId: '00000000-0000-0000-0000-000000000000', // AUTH_PROVIDER=none stub user
  corpusId: '00000000-0000-0000-0000-000000000001', // Default workspace
  paperId: 'e2e00000-0000-4000-8000-000000000001',
  figureId: 'e2e00000-0000-4000-8000-000000000002',
  feedId: 'e2e00000-0000-4000-8000-000000000011', // current feed (newest)
  pastFeedId: 'e2e00000-0000-4000-8000-000000000012', // older feed for history switching
  tag: 'e2e-fixture',
} as const

const PAPER_TITLE = 'E2E Fixture Paper: Attention in Transformers'

// Posts cover every PostCard variant the converted specs select on. Persona
// keys must exist in the personas table (PostCard renders null otherwise):
// methodologist / hype / skeptic / practitioner / archivist are all active.
const FEED_POSTS = [
  {
    id: 1,
    persona: 'methodologist',
    post_type: 'post',
    content:
      'E2E fixture: the ablation table is doing more work than the headline claim. ' +
      'Removing the auxiliary loss drops accuracy 4 points — that is the real story here.',
    paper_ref: 'Fixture et al., 2026',
    time: '2m',
    likes: 0,
    retweets: 0,
    replies: 0,
    bookmarks: 0,
    category: 'methods',
    sources: [
      {
        paper_title: PAPER_TITLE,
        section: '4.2 Ablation',
        content:
          'Removing the auxiliary consistency loss reduces top-1 accuracy from 84.1 ' +
          'to 80.0 on the held-out split, the largest single-component drop reported.',
        score: 0.91,
      },
      {
        paper_title: PAPER_TITLE,
        section: '2.1 Architecture',
        content:
          'The encoder stacks 12 pre-norm transformer blocks with rotary position ' +
          'embeddings and grouped-query attention across all layers.',
        score: 0.83,
      },
    ],
  },
  {
    id: 2,
    persona: 'hype',
    post_type: 'thread',
    content: 'Thread: why this fixture paper matters',
    thread_count: 3,
    thread_posts: [
      '1/ This fixture paper quietly fixes the three biggest pain points in retrieval-grounded feed generation.',
      '2/ First: chunked evidence selection with per-section scoring beats whole-document prompting on every metric they report.',
      '3/ Second: persona-condensed posts stay faithful — the faithfulness audit shows zero contradictions across 200 sampled posts.',
    ],
    paper_ref: 'Fixture et al., 2026',
    time: '6m',
    likes: 0,
    retweets: 0,
    replies: 0,
    bookmarks: 0,
    category: 'findings',
  },
  {
    id: 3,
    persona: 'skeptic',
    post_type: 'figure',
    content: 'Look at the variance across seeds before believing the trend line.',
    paper_ref: 'Fixture et al., 2026',
    time: '10m',
    likes: 0,
    retweets: 0,
    replies: 0,
    bookmarks: 0,
    category: 'findings',
    figure_id: FIXTURE.figureId,
    figure_caption:
      'Fig. 1, p.1 — E2E fixture figure: accuracy over epochs. Fixture et al., 2026',
  },
  {
    id: 4,
    persona: 'practitioner',
    post_type: 'post',
    content:
      'Tried the fixture recipe on our internal set: same gains, half the tuning. Shipping it.',
    paper_ref: 'Fixture et al., 2026',
    time: '14m',
    likes: 0,
    retweets: 0,
    replies: 0,
    bookmarks: 0,
    category: 'general',
  },
]

const PAST_FEED_POSTS = [
  {
    id: 1,
    persona: 'archivist',
    post_type: 'post',
    content:
      'E2E fixture archive note: an earlier pass over the same fixture paper, ' +
      'kept around so feed-history switching has a second feed to load.',
    paper_ref: 'Fixture et al., 2026',
    time: '1h',
    likes: 0,
    retweets: 0,
    replies: 0,
    bookmarks: 0,
    category: 'general',
  },
]

// 1x1 opaque PNG — valid image so the figure <img> has nonzero layout size.
const FIGURE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function buildSql(): string {
  const posts = JSON.stringify(FEED_POSTS)
  const pastPosts = JSON.stringify(PAST_FEED_POSTS)
  // generated_at is re-stamped (not EXCLUDED) so re-runs keep the fixture
  // feed newest in the workspace even if other data appeared meanwhile.
  return `
INSERT INTO papers (id, user_id, corpus_id, title, authors, year, filename, file_path, status, chunk_count, figure_count, processed_at)
VALUES ('${FIXTURE.paperId}', '${FIXTURE.userId}', '${FIXTURE.corpusId}',
        '${PAPER_TITLE}', ARRAY['Fixture, Ada'], 2026,
        'e2e-fixture.pdf', '/app/uploads/e2e-fixture.pdf', 'complete', 3, 1, now())
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, status = 'complete', chunk_count = 3, figure_count = 1;

INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, figure_index, caption, figure_number, processed_at)
VALUES ('${FIXTURE.figureId}', '${FIXTURE.paperId}', 1, 'e2e-fixture.png', 'typed', 0,
        'E2E fixture figure: accuracy over epochs', '1', now())
ON CONFLICT (id) DO UPDATE SET image_path = EXCLUDED.image_path;

INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms, generated_at)
VALUES ('${FIXTURE.feedId}', '${FIXTURE.userId}', '${FIXTURE.corpusId}',
        ARRAY['${FIXTURE.tag}'], $posts$${posts}$posts$::jsonb, 1, ${FEED_POSTS.length}, 1200, now())
ON CONFLICT (id) DO UPDATE SET
  posts = EXCLUDED.posts, post_count = EXCLUDED.post_count, generated_at = now();

INSERT INTO feeds (id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms, generated_at)
VALUES ('${FIXTURE.pastFeedId}', '${FIXTURE.userId}', '${FIXTURE.corpusId}',
        ARRAY['${FIXTURE.tag}'], $posts$${pastPosts}$posts$::jsonb, 1, ${PAST_FEED_POSTS.length}, 900, now() - interval '1 hour')
ON CONFLICT (id) DO UPDATE SET
  posts = EXCLUDED.posts, post_count = EXCLUDED.post_count, generated_at = now() - interval '1 hour';
`
}

function run(cmd: string, args: string[], input?: string): void {
  execFileSync(cmd, args, {
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Idempotently seed the fixture paper + figure (+ PNG) + two feeds into the
 * dev stack. Throws on failure — a spec whose fixtures can't be seeded must
 * FAIL, not silently skip (that is the whole point of plan 036).
 */
export function ensureFeedFixtures(): void {
  run(
    'docker',
    ['exec', '-i', PSQL_CONTAINER, 'psql', '-U', PSQL_USER, '-d', PSQL_DB, '-v', 'ON_ERROR_STOP=1', '-q'],
    buildSql(),
  )
  const figDir = `${FIGURES_DIR}/${FIXTURE.paperId}`
  run('docker', [
    'exec', API_CONTAINER, 'sh', '-c',
    `mkdir -p '${figDir}' && echo '${FIGURE_PNG_B64}' | base64 -d > '${figDir}/e2e-fixture.png'`,
  ])
}

/**
 * Remove all fixture rows (and the figure PNG). NOT wired into afterAll —
 * see the cleanup policy in the file header. Provided for scratch databases
 * (plan 037) and manual cleanup.
 */
export function cleanupFixtures(): void {
  // Explicit per-table deletes keyed on the reserved fixture ids — never a
  // blanket delete, so non-fixture dev data is untouched.
  const sql = `
DELETE FROM feeds WHERE id IN ('${FIXTURE.feedId}', '${FIXTURE.pastFeedId}');
DELETE FROM figures WHERE id = '${FIXTURE.figureId}';
DELETE FROM papers WHERE id = '${FIXTURE.paperId}';
`
  run(
    'docker',
    ['exec', '-i', PSQL_CONTAINER, 'psql', '-U', PSQL_USER, '-d', PSQL_DB, '-v', 'ON_ERROR_STOP=1', '-q'],
    sql,
  )
  run('docker', [
    'exec', API_CONTAINER, 'sh', '-c',
    `rm -rf '${FIGURES_DIR}/${FIXTURE.paperId}'`,
  ])
}
