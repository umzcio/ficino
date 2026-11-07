// Cross-service constants (port of shared/ficino_shared/constants.py).
// CHAPTER_INSERT_SQL lives in readingLists/chapters.ts (insertChapters), shared by the routes and the worker.

export const STUB_USER_ID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

// Signed-URL TTLs (seconds). Short default for live listings; long for
// media URLs persisted into feed posts.
export const SIGNED_URL_DEFAULT_TTL = 600;
export const MEDIA_URL_TTL = 86400;

// List caps (api-contract C section 2.11).
export const LIMITS = {
  FEEDS: 20,
  CONTENT: 50,
  ALERTS: 50,
  ACTIVITY: 100,
  PAPER_SUMMARIES: 200,
  LIBRARY: 500,
  ANNOTATIONS: 1000,
  SEARCH: 10,
  SEARCH_CHUNKS: 15,
} as const;
