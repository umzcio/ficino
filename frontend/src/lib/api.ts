import type { Paper, Feed, FeedPost, PaperConversation, PaperSummary, GroupChatPreview, GroupChat, Workspace, ActivityItem } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || '/ficino/api'

// Auth token getter — set by AuthProvider when using supabase
let _getAuthToken: (() => string | null) | null = null
export function setAuthTokenGetter(fn: () => string | null) {
  _getAuthToken = fn
}

// Read the CSRF token the server set in a JS-readable cookie.
// Returns null when no cookie is present (dev mode with AUTH_PROVIDER=none
// or before the first GET response has landed). In those cases the server
// middleware either bypasses CSRF or the upcoming GET will set the cookie.
function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|; )ficino_csrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

// Thrown by request() on any non-2xx response. Carries the HTTP status and
// the parsed JSON body (when the response was valid JSON) alongside the
// existing `message` string, so callers that need to branch on status code
// (e.g. treating 404 as "already gone" rather than a real failure) or pull
// a server-supplied `detail` string (FastAPI's HTTPException shape) don't
// have to re-parse `err.message`. `message` keeps the exact
// `API error {status}: {text}` format request() has always thrown, so any
// existing `catch (err) { ... err.message ... }` caller is unaffected.
export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

// Pulls a FastAPI-style { detail: string } message out of a thrown ApiError,
// falling back to `fallback` when the error isn't an ApiError, has no JSON
// body, or the body has no string `detail`. Pure — no I/O — so it's unit
// tested directly (see api.test.ts) rather than only through the auth flows
// that consume it.
export function getApiErrorDetail(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const detail = (err.body as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail) return detail
  }
  return fallback
}

// True when `err` is an ApiError for a 404 — i.e. the resource is already
// gone server-side. Callers that optimistically clear/delete local state
// before the request resolves (e.g. PersonaProfile's handleClearDm) use
// this to treat "already gone" as success rather than rolling back and
// resurrecting a dead thread. (R10 wave-3 final-review Minor 5: personas'
// DM-clear 404s when the thread was already cleared from another tab; the
// naive catch-and-restore then brings a dead thread back to life.)
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let headers: Record<string, string> = { ...(options?.headers as Record<string, string> || {}) }

  // Inject auth token for supabase provider
  const token = _getAuthToken?.()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // Attach CSRF token on mutating requests when we have one. The server-side
  // middleware is skipped under AUTH_PROVIDER=none, so a missing token here
  // doesn't break single-user dev.
  const method = (options?.method || (options?.body ? 'POST' : 'GET')).toUpperCase()
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const csrf = getCsrfToken()
    if (csrf) {
      headers = { ...headers, 'X-CSRF-Token': csrf }
    }
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',  // Send cookies for basic auth
  })
  if (!res.ok) {
    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined // not JSON — leave body unset, message still carries the raw text
    }
    throw new ApiError(res.status, `API error ${res.status}: ${text}`, body)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// Papers
export async function uploadPaper(file: File, workspaceId?: string): Promise<Paper> {
  const formData = new FormData()
  formData.append('file', file)
  const query = workspaceId ? `?workspace_id=${workspaceId}` : ''
  return request<Paper>(`/papers${query}`, { method: 'POST', body: formData })
}

export async function listPapers(workspaceId?: string): Promise<Paper[]> {
  const query = workspaceId ? `?workspace_id=${workspaceId}` : ''
  return request<Paper[]>(`/papers${query}`)
}

export async function deletePaper(paperId: string): Promise<void> {
  return request<void>(`/papers/${paperId}`, { method: 'DELETE' })
}

// Feed generation
export interface GenerateResponse {
  task_id: string
  status: string
}

export interface FeedStatus {
  status: string
  task_id: string
  feed_id?: string
  post_count?: number
  duration_ms?: number
  meta?: { step?: string; post_progress?: string }
  error?: string
}

export async function generateFeed(
  corpusId?: string,
  tagFilter?: string[],
  appendToFeedId?: string,
  tabFocus?: string,
  personaKey?: string,
  numPosts?: number,
): Promise<GenerateResponse> {
  return request<GenerateResponse>('/feed/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      corpus_id: corpusId,
      tag_filter: tagFilter,
      append_to_feed_id: appendToFeedId,
      tab_focus: tabFocus,
      persona_key: personaKey,
      num_posts: numPosts,
    }),
  })
}

export async function getFeedStatus(taskId: string): Promise<FeedStatus> {
  return request<FeedStatus>(`/feed/status/${taskId}`)
}

export async function getFeed(feedId: string): Promise<Feed> {
  return request<Feed>(`/feed/${feedId}`)
}

// Trigger TTS audio generation for a feed. Backend returns 501 when
// ELEVENLABS_API_KEY is unset — callers catch that to hide the play UI.
export async function requestFeedAudio(feedId: string): Promise<{ status: string; task_id?: string }> {
  return request(`/feed/${feedId}/audio`, { method: 'POST' })
}

// Trigger two-host podcast generation for a feed. Same 501 semantics as
// requestFeedAudio — the Listen view's Podcast tab hides itself when no key.
export async function requestFeedPodcast(feedId: string): Promise<{ status: string; task_id?: string }> {
  return request(`/feed/${feedId}/podcast`, { method: 'POST' })
}

export async function listFeeds(workspaceId?: string): Promise<Feed[]> {
  const query = workspaceId ? `?workspace_id=${workspaceId}` : ''
  return request<Feed[]>(`/feed${query}`)
}

// Metadata-only list — posts[] is empty on every feed. Use this when you
// only need post_count / paper_count / generated_at. Hydrate full posts
// via getFeed(id) when the user picks a specific feed.
export async function listFeedSummaries(workspaceId?: string): Promise<Feed[]> {
  const params = new URLSearchParams({ summary: 'true' })
  if (workspaceId) params.set('workspace_id', workspaceId)
  return request<Feed[]>(`/feed?${params.toString()}`)
}

export async function regeneratePost(feedId: string, postIndex: number): Promise<{ task_id: string }> {
  return request(`/feed/${feedId}/regenerate/${postIndex}`, { method: 'POST' })
}

export async function deletePost(feedId: string, postIndex: number): Promise<void> {
  return request(`/feed/${feedId}/posts/${postIndex}`, { method: 'DELETE' })
}

// Replies
export interface ReplyMessage {
  role: 'user' | 'persona' | 'interjection'
  content: string
  persona?: string
}

export interface ReplyConversation {
  id: string
  feed_id: string
  post_index: number
  persona_key: string
  message_count: number
  last_user_message: string
  last_persona_message: string
  updated_at: string
}

export async function listReplyConversations(): Promise<ReplyConversation[]> {
  return request<ReplyConversation[]>('/replies/conversations')
}

export async function getRepliedPostIndices(feedId: string): Promise<number[]> {
  return request<number[]>(`/replies/replied-posts/${feedId}`)
}

export async function getPostReplies(feedId: string, postIndex: number): Promise<{ messages: ReplyMessage[]; persona_key: string | null }> {
  return request(`/replies/${feedId}/${postIndex}`)
}

export async function sendReply(
  feedId: string, postIndex: number, personaKey: string,
  userMessage: string, postContent: string, paperRef: string | null,
): Promise<{ messages: ReplyMessage[]; latest_response: string }> {
  return request('/replies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feed_id: feedId, post_index: postIndex, persona_key: personaKey,
      user_message: userMessage, post_content: postContent, paper_ref: paperRef,
    }),
  })
}

export async function deleteReplyMessage(
  feedId: string, postIndex: number, messageIndex: number,
): Promise<void> {
  return request(
    `/replies/${feedId}/${postIndex}/message/${messageIndex}`,
    { method: 'DELETE' },
  )
}

export async function sendZap(
  feedId: string, postIndex: number, targetPersonaKey: string,
  sourcePersonaKey: string, sourceMessage: string, postContent: string, paperRef: string | null,
): Promise<{ messages: ReplyMessage[]; content: string }> {
  return request('/replies/zap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feed_id: feedId, post_index: postIndex, target_persona_key: targetPersonaKey,
      source_persona_key: sourcePersonaKey, source_message: sourceMessage,
      post_content: postContent, paper_ref: paperRef,
    }),
  })
}

// Alerts
export interface AlertItem {
  id: string
  type: string
  title: string
  body: string
  metadata: Record<string, unknown>
  read: boolean
  created_at: string
}

export async function listAlerts(): Promise<AlertItem[]> {
  return request<AlertItem[]>('/alerts')
}

export async function getUnreadCount(): Promise<{ count: number }> {
  return request('/alerts/unread-count')
}

export async function markAlertRead(id: string): Promise<void> {
  return request(`/alerts/${id}/read`, { method: 'PUT' })
}

export async function markAllAlertsRead(): Promise<void> {
  return request('/alerts/read-all', { method: 'PUT' })
}

export async function dismissAlert(id: string): Promise<void> {
  return request(`/alerts/${id}`, { method: 'DELETE' })
}

// Personas
export interface PersonaData {
  key: string
  handle: string
  name: string
  initials: string
  color: string
  avatar_url?: string | null
  bio?: string | null
}

export async function listPersonas(): Promise<PersonaData[]> {
  return request<PersonaData[]>('/personas')
}

export interface PersonaReplyItem {
  feed_id: string
  post_index: number
  message_index: number
  content: string
  thread_generated_at: string
  // Full FeedPost JSONB straight from feeds.posts[post_index]. Typed as
  // FeedPost so the Replies tab can render it with the same PostCard used
  // everywhere else.
  parent_post: FeedPost
}

export async function getPersonaReplies(key: string): Promise<PersonaReplyItem[]> {
  return request(`/personas/${key}/replies`)
}

export async function getPersonaStats(key: string): Promise<{ reply_threads: number }> {
  return request(`/personas/${key}/stats`)
}

export async function getPersonaDm(key: string): Promise<{ messages: ReplyMessage[] }> {
  return request(`/personas/${key}/dm`)
}

export async function sendPersonaDm(key: string, message: string): Promise<{ messages: ReplyMessage[]; latest_response: string }> {
  return request(`/personas/${key}/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
}

export async function deletePersonaDmMessage(key: string, messageIndex: number): Promise<{ messages: ReplyMessage[] }> {
  return request(`/personas/${key}/dm/${messageIndex}`, { method: 'DELETE' })
}

export async function clearPersonaDm(key: string): Promise<{ messages: ReplyMessage[] }> {
  return request(`/personas/${key}/dm`, { method: 'DELETE' })
}

// Citations
export async function getCitation(title: string, format: 'apa' | 'mla' = 'apa'): Promise<{ citation: string; format: string; title: string }> {
  return request(`/citations/by-title?title=${encodeURIComponent(title)}&format=${format}`)
}

// Annotations
export interface AnnotationItem {
  id: string
  feed_id: string
  post_index: number
  body: string
  created_at: string
  updated_at: string
}

export async function listAnnotations(): Promise<AnnotationItem[]> {
  return request<AnnotationItem[]>('/annotations')
}

export async function upsertAnnotation(feedId: string, postIndex: number, body: string): Promise<AnnotationItem> {
  return request<AnnotationItem>(`/annotations/${feedId}/${postIndex}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
}

export async function deleteAnnotation(feedId: string, postIndex: number): Promise<void> {
  return request<void>(`/annotations/${feedId}/${postIndex}`, { method: 'DELETE' })
}

// User profile / account activity
export interface UserProfile {
  id: string
  email: string
  display_name: string | null
  created_at: string
}

export async function getMe(): Promise<UserProfile> {
  return request<UserProfile>('/users/me')
}

// Mirrors api/routers/users.py's audit_log row shape exactly (id, action,
// resource_type, resource_id, metadata, ip, status_code, created_at) — no
// projection happens server-side.
export interface AuditLogEntry {
  id: string
  action: string
  resource_type: string
  resource_id: string | null
  metadata: Record<string, unknown> | null
  ip: string | null
  status_code: number | null
  created_at: string
}

// Server clamps `limit` to [1, 500] (GET /users/me/audit-log); default here
// matches AccountTab's "last ~20 rows" display, not the server clamp.
export async function listAuditLog(limit: number = 20): Promise<AuditLogEntry[]> {
  return request<AuditLogEntry[]>(`/users/me/audit-log?limit=${limit}`)
}

// Settings
export async function getSettings(): Promise<Record<string, unknown>> {
  return request('/settings')
}

export async function updateSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
}

export async function getOllamaModels(): Promise<{ llm: { name: string; size: string; family: string }[]; embed: { name: string; size: string }[]; vision: { name: string; size: string }[] }> {
  return request('/settings/ollama-models')
}

export async function clearAllFeeds(): Promise<void> {
  return request('/settings/clear-feeds', { method: 'POST' })
}

export async function clearAllSummaries(): Promise<void> {
  return request('/settings/clear-summaries', { method: 'POST' })
}

export async function clearAllUserPosts(): Promise<void> {
  await request('/settings/clear-user-posts', { method: 'POST' })
  // Also drop the IDB cache and broadcast so any mounted useUserPosts hook
  // refetches — without this the UI still shows the stale list until a hard
  // reload because settings lives in a sibling view with no shared state.
  try {
    const { clearCachedUserPosts } = await import('./offline-cache')
    await clearCachedUserPosts()
  } catch { /* cache clear is best-effort */ }
  window.dispatchEvent(new CustomEvent('ficino:user-posts-cleared'))
}

export async function clearAllPapers(): Promise<void> {
  await request('/settings/clear-papers', { method: 'POST' })
  // Wipe the papers AND feeds IDB stores — feeds hold paper_ids in their
  // posts JSONB and would render dangling references after the server-side
  // paper delete. Broadcast so useCorpus and useFeed refetch immediately.
  try {
    const { clearCachedPapers, clearCachedFeeds } = await import('./offline-cache')
    await Promise.all([clearCachedPapers(), clearCachedFeeds()])
  } catch { /* cache clear is best-effort */ }
  window.dispatchEvent(new CustomEvent('ficino:papers-cleared'))
}

export async function clearEverything(): Promise<void> {
  await request('/settings/clear-everything', { method: 'POST' })
  // Wipe all content IDB stores and broadcast a single event. Every
  // content hook (useCorpus, useFeed, useUserPosts, useAlerts) listens
  // for this so the UI collapses to a clean-slate state without a hard
  // reload. Alerts/notifications were the specific leak that motivated
  // this button — the granular clears never touched them.
  try {
    const { clearAllCachedContent } = await import('./offline-cache')
    await clearAllCachedContent()
  } catch { /* best-effort */ }
  window.dispatchEvent(new CustomEvent('ficino:everything-cleared'))
}

// Reading Lists
export interface ReadingListSummary {
  id: string
  name: string
  paper_count: number
  chapter_count: number
  completed_chapters: number
  created_at: string
}

export interface ReadingListPaper {
  id: string
  title: string
  authors: string[]
  year: number | null
  rationale: string
}

export interface ReadingListChapter {
  id: string
  chapter_index: number
  paper_ids: string[]
  feed_id: string | null
  status: 'locked' | 'unlocked' | 'complete'
}

export interface ReadingListDetail {
  id: string
  name: string
  corpus_id: string | null
  papers: ReadingListPaper[]
  chapters: ReadingListChapter[]
  created_at: string
}

export async function listReadingLists(workspaceId?: string): Promise<ReadingListSummary[]> {
  const query = workspaceId ? `?workspace_id=${workspaceId}` : ''
  return request<ReadingListSummary[]>(`/reading-lists${query}`)
}

export async function getReadingList(listId: string): Promise<ReadingListDetail> {
  return request<ReadingListDetail>(`/reading-lists/${listId}`)
}

export async function createReadingList(name: string, corpusId?: string, paperIds?: string[]): Promise<{ id: string; task_id: string }> {
  return request('/reading-lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, corpus_id: corpusId, paper_ids: paperIds }),
  })
}

export async function reorderReadingList(listId: string, paperSequence: string[]): Promise<void> {
  return request(`/reading-lists/${listId}/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paper_sequence: paperSequence }),
  })
}

export async function generateChapter(listId: string, chapterIndex: number): Promise<{ task_id: string }> {
  return request(`/reading-lists/${listId}/chapters/${chapterIndex}/generate`, { method: 'POST' })
}

export async function deleteReadingList(listId: string): Promise<void> {
  return request(`/reading-lists/${listId}`, { method: 'DELETE' })
}

// User Posts (Ask Your Corpus)
export interface UserPost {
  id: string
  content: string
  replies: { role: string; persona: string; content: string }[]
  sources: { chunk_id?: string; paper_id?: string; paper_title: string; section: string; content: string; score: number }[]
  status: 'pending' | 'complete' | 'error'
  created_at: string
}

export async function listUserPosts(workspaceId?: string): Promise<UserPost[]> {
  const query = workspaceId ? `?workspace_id=${workspaceId}` : ''
  return request<UserPost[]>(`/user-posts${query}`)
}

export async function createUserPost(content: string, corpusId?: string): Promise<{ id: string; task_id: string }> {
  return request('/user-posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, corpus_id: corpusId }),
  })
}

export async function getUserPost(postId: string): Promise<UserPost> {
  return request<UserPost>(`/user-posts/${postId}`)
}

export async function getUserPostStatus(postId: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/user-posts/${postId}/status`)
}

export async function deleteUserPost(postId: string): Promise<void> {
  return request(`/user-posts/${postId}`, { method: 'DELETE' })
}

export async function replyToUserPost(postId: string, content: string): Promise<{ id: string; task_id: string; status: string }> {
  return request(`/user-posts/${postId}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

// Search
export interface SearchResults {
  query: string
  papers: { id: string; title: string; authors: string[]; year: number | null; chunk_count: number }[]
  chunks: { id: string; paper_id: string; paper_title: string; section: string; content: string; rank: number }[]
  posts: { feed_id: string; post_index: number; persona: string; post_type: string; content: string; paper_ref: string | null; generated_at: string }[]
}

export async function searchCorpus(query: string): Promise<SearchResults> {
  return request<SearchResults>(`/search?q=${encodeURIComponent(query)}`)
}

// Workspaces
export async function listWorkspaces(): Promise<Workspace[]> {
  return request<Workspace[]>('/workspaces')
}

export async function createWorkspace(name: string): Promise<{ id: string; name: string }> {
  return request('/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  return request(`/workspaces/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function deleteWorkspace(id: string): Promise<void> {
  return request(`/workspaces/${id}`, { method: 'DELETE' })
}

export async function getWorkspaceActivity(id: string): Promise<ActivityItem[]> {
  return request<ActivityItem[]>(`/workspaces/${id}/activity`)
}

// Bookmarks
export interface BookmarkItem {
  id: string
  feed_id: string
  post_index: number
  message_index?: number
  post: Record<string, unknown>
  bookmarked_at: string
}

export async function listBookmarks(): Promise<BookmarkItem[]> {
  return request<BookmarkItem[]>('/bookmarks')
}

export async function createBookmark(feedId: string, postIndex: number, postSnapshot: Record<string, unknown>, messageIndex: number = -1): Promise<{ id: string }> {
  return request('/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feed_id: feedId, post_index: postIndex, message_index: messageIndex, post_snapshot: postSnapshot }),
  })
}

export async function deleteBookmarkByPost(feedId: string, postIndex: number, messageIndex: number = -1): Promise<void> {
  return request(`/bookmarks/post/${feedId}/${postIndex}?message_index=${messageIndex}`, { method: 'DELETE' })
}

export async function deleteBookmark(bookmarkId: string): Promise<void> {
  return request(`/bookmarks/${bookmarkId}`, { method: 'DELETE' })
}

// Likes
export interface FeedLikes {
  posts: number[]
  replies: Record<string, boolean>  // "postIndex:messageIndex" → true
}

export async function listLikesForFeed(feedId: string): Promise<FeedLikes> {
  return request<FeedLikes>(`/likes/feed/${feedId}`)
}

export async function createLike(feedId: string, postIndex: number, messageIndex: number = -1, personaKey?: string, postType?: string, category?: string): Promise<{ id: string }> {
  return request('/likes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feed_id: feedId, post_index: postIndex, message_index: messageIndex, persona_key: personaKey, post_type: postType, category: category }),
  })
}

export async function deleteLike(feedId: string, postIndex: number, messageIndex: number = -1): Promise<void> {
  return request(`/likes/feed/${feedId}/${postIndex}?message_index=${messageIndex}`, { method: 'DELETE' })
}

// Tags
export async function assignTag(paperId: string, tagName: string): Promise<void> {
  return request('/tags/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paper_id: paperId, tag_name: tagName }),
  })
}

export async function unassignTag(paperId: string, tagId: string): Promise<void> {
  return request(`/tags/assign/${paperId}/${tagId}`, { method: 'DELETE' })
}

// Messages / DMs
export async function getPaperTldrs(): Promise<Record<string, string>> {
  return request<Record<string, string>>('/messages/papers/tldrs')
}

export async function listPaperConversations(workspaceId?: string): Promise<PaperConversation[]> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : ''
  return request<PaperConversation[]>(`/messages/papers${qs}`)
}

export async function getPaperSummary(paperId: string): Promise<PaperSummary> {
  return request<PaperSummary>(`/messages/papers/${paperId}`)
}

export async function getPaperSummaryStatus(paperId: string, taskId: string): Promise<{ status: string; error?: string }> {
  return request<{ status: string; error?: string }>(`/messages/papers/${paperId}/status/${taskId}`)
}

export async function listGroupChats(): Promise<GroupChatPreview[]> {
  return request<GroupChatPreview[]>('/messages/groups')
}

export async function createGroupChat(name: string, paperIds: string[]): Promise<{ synthesis_id: string; task_id: string }> {
  return request('/messages/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, paper_ids: paperIds }),
  })
}

export async function getGroupChat(synthesisId: string): Promise<GroupChat> {
  return request<GroupChat>(`/messages/groups/${synthesisId}`)
}
