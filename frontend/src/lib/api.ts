import type { Paper, Feed, PaperConversation, PaperSummary, GroupChatPreview, GroupChat, Workspace, ActivityItem } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || '/ficino/api'

// Auth token getter — set by AuthProvider when using supabase
let _getAuthToken: (() => string | null) | null = null
export function setAuthTokenGetter(fn: () => string | null) {
  _getAuthToken = fn
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string> || {}) }

  // Inject auth token for supabase provider
  const token = _getAuthToken?.()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',  // Send cookies for basic auth
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API error ${res.status}: ${text}`)
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

export async function getPaper(paperId: string): Promise<Paper> {
  return request<Paper>(`/papers/${paperId}`)
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

export async function generateFeed(corpusId?: string, tagFilter?: string[], appendToFeedId?: string, tabFocus?: string): Promise<GenerateResponse> {
  return request<GenerateResponse>('/feed/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corpus_id: corpusId, tag_filter: tagFilter, append_to_feed_id: appendToFeedId, tab_focus: tabFocus }),
  })
}

export async function getFeedStatus(taskId: string): Promise<FeedStatus> {
  return request<FeedStatus>(`/feed/status/${taskId}`)
}

export async function getFeed(feedId: string): Promise<Feed> {
  return request<Feed>(`/feed/${feedId}`)
}

export async function listFeeds(workspaceId?: string): Promise<Feed[]> {
  const query = workspaceId ? `?workspace_id=${workspaceId}` : ''
  return request<Feed[]>(`/feed${query}`)
}

export async function regeneratePost(feedId: string, postIndex: number): Promise<{ task_id: string }> {
  return request(`/feed/${feedId}/regenerate/${postIndex}`, { method: 'POST' })
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

export async function applyReadingListOrdering(listId: string, orderedPapers: unknown[]): Promise<void> {
  return request(`/reading-lists/${listId}/apply-ordering`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_papers: orderedPapers }),
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
  sources: { paper_title: string; section: string; content: string; score: number }[]
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
export async function listTags(): Promise<{ id: string; name: string; paper_count: number }[]> {
  return request('/tags')
}

export async function createTag(name: string): Promise<{ id: string; name: string }> {
  return request('/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

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

export async function deleteTag(tagId: string): Promise<void> {
  return request(`/tags/${tagId}`, { method: 'DELETE' })
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

export async function getPaperSummaryStatus(paperId: string, taskId: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/messages/papers/${paperId}/status/${taskId}`)
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
