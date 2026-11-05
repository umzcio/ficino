import type { Logger } from 'pino';
import type { Config, Env } from '../config.js';
import type { Sql } from '../db/sql.js';
import type { JobContext } from '../jobs/context.js';
import type { JobQueue } from '../jobs/queue.js';
import type { QueueName } from '../jobs/registry.js';
import type { ProviderDeps } from '../providers/deps.js';
import type { LocalStorage } from '../storage/local.js';
import { checkStalePapers } from '../tasks/alerts.js';
import { generateFeed } from '../tasks/feed.js';
import { processPaper } from '../tasks/ingestion.js';
import { pruneExpired } from '../tasks/prune.js';
import { regeneratePost } from '../tasks/regenerate.js';
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
  check_stale_papers: (_data, _ctx, deps) => checkStalePapers(deps.sql),
  prune_expired: (_data, _ctx, deps) => pruneExpired(deps.sql),
};
