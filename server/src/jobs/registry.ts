/** Queue names are the Celery task names without the module prefix (W §1). */
export const QUEUES = {
  process_paper: { retryLimit: 2, retryDelay: 30 },
  generate_feed: { retryLimit: 2, retryDelay: 30 },
  regenerate_post: { retryLimit: 0 },
  generate_audio_for_feed: { retryLimit: 0 },
  generate_podcast_for_feed: { retryLimit: 0 },
  respond_to_user_post: { retryLimit: 2, retryDelay: 180 },
  respond_to_user_post_followup: { retryLimit: 2, retryDelay: 180 },
  generate_paper_summary: { retryLimit: 2, retryDelay: 30 },
  generate_corpus_synthesis: { retryLimit: 2, retryDelay: 30 },
  propose_ordering: { retryLimit: 2, retryDelay: 180 },
  generate_chapter: { retryLimit: 2, retryDelay: 180 },
  check_contradictions: { retryLimit: 0 },
  check_post_feed: { retryLimit: 0 },
  compute_preferences: { retryLimit: 0 },
  check_stale_papers: { retryLimit: 0 },
  prune_expired: { retryLimit: 0 },
} as const satisfies Record<string, { retryLimit: number; retryDelay?: number }>;

export type QueueName = keyof typeof QUEUES;

export function isQueueName(name: string): name is QueueName {
  return Object.hasOwn(QUEUES, name);
}
