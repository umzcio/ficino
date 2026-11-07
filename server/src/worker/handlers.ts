import type { Logger } from 'pino';
import type { Config, Env } from '../config.js';
import type { Sql } from '../db/sql.js';
import type { JobContext } from '../jobs/context.js';
import type { JobQueue } from '../jobs/queue.js';
import type { QueueName } from '../jobs/registry.js';
import type { ProviderDeps } from '../providers/deps.js';
import type { LocalStorage } from '../storage/local.js';
import { checkContradictions, checkPostFeed, checkStalePapers } from '../tasks/alerts.js';
import { respondToUserPost, respondToUserPostFollowup } from '../tasks/archivist.js';
import { generateAudioForFeed, generatePodcastForFeed } from '../tasks/audio.js';
import { generateFeed } from '../tasks/feed.js';
import { processPaper } from '../tasks/ingestion.js';
import { pruneExpired } from '../tasks/prune.js';
import { computePreferences } from '../tasks/preferences.js';
import { generateChapter, proposeOrdering } from '../tasks/readingLists.js';
import { regeneratePost } from '../tasks/regenerate.js';
import { generateCorpusSynthesis, generatePaperSummary } from '../tasks/summary.js';
import type { Rng } from '../shared/random.js';

export type WorkerDeps = {
  sql: Sql;
  config: Config;
  env: Readonly<Env>;
  logger: Logger;
  storage: LocalStorage;
  queue: JobQueue;
  providers: ProviderDeps;
  rng: Rng;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (data: any, ctx: JobContext, deps: WorkerDeps) => Promise<unknown>;

/** Handlers return objects (pg-boss wraps other results as `{ value }`). Later tasks add the rest. */
export const HANDLERS: Partial<Record<QueueName, Handler>> = {
  process_paper: (data, ctx, deps) => processPaper(data, ctx, deps),
  generate_feed: (data, ctx, deps) => generateFeed(data, ctx, deps),
  regenerate_post: (data, ctx, deps) => regeneratePost(data, ctx, deps),
  check_contradictions: (data, ctx, deps) => checkContradictions(data, ctx, deps),
  check_post_feed: (data, ctx, deps) => checkPostFeed(data, ctx, deps),
  check_stale_papers: (_data, _ctx, deps) => checkStalePapers(deps.sql),
  prune_expired: (_data, _ctx, deps) => pruneExpired(deps.sql),
  compute_preferences: (data, ctx, deps) => computePreferences(data, ctx, deps),
  generate_paper_summary: (data, ctx, deps) => generatePaperSummary(data, ctx, deps),
  generate_corpus_synthesis: (data, ctx, deps) => generateCorpusSynthesis(data, ctx, deps),
  respond_to_user_post: (data, ctx, deps) => respondToUserPost(data, ctx, deps),
  respond_to_user_post_followup: (data, ctx, deps) => respondToUserPostFollowup(data, ctx, deps),
  propose_ordering: (data, ctx, deps) => proposeOrdering(data, ctx, deps),
  generate_chapter: (data, ctx, deps) => generateChapter(data, ctx, deps),
  generate_audio_for_feed: (data, ctx, deps) => generateAudioForFeed(data, ctx, deps),
  generate_podcast_for_feed: (data, ctx, deps) => generatePodcastForFeed(data, ctx, deps),
};
