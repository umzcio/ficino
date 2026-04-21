export interface PaperTag {
  id: string
  name: string
}

export interface Paper {
  id: string
  user_id: string | null
  corpus_id: string | null
  title: string | null
  authors: string[]
  year: number | null
  doi: string | null
  filename: string
  status: PaperStatus
  extraction_path: string | null
  error_message: string | null
  chunk_count: number
  figure_count: number
  tags: PaperTag[]
  uploaded_at: string | null
  processed_at: string | null
}

export type PaperStatus =
  | 'pending'
  | 'extracting'
  | 'quality_checking'
  | 'chunking'
  | 'embedding'
  | 'extracting_figures'
  | 'complete'
  | 'error'

export type { PersonaData } from '../lib/api'

export interface FeedPost {
  id: number
  persona: string
  post_type: 'post' | 'thread' | 'quote' | 'reply' | 'figure'
  content: string
  paper_ref: string | null
  time: string
  likes: number
  retweets: number
  replies: number
  bookmarks: number
  thread_count?: number
  quoting_handle?: string
  quoting_content?: string
  replying_to?: string
  figure_id?: string
  figure_caption?: string
  figure_url?: string
  category?: 'general' | 'debates' | 'methods' | 'findings'
  thread_posts?: string[]
  // chunk_id + paper_id added so reply paths can re-fetch the exact
  // chunks the persona was grounded on at generation time. Optional for
  // backward compatibility with posts generated before chunk-id persistence.
  sources?: { chunk_id?: string; paper_id?: string; paper_title: string; section: string; content: string; score: number }[]
  deleted?: boolean  // soft-deleted posts are filtered from display
}

// Workspaces
export interface Workspace {
  id: string
  name: string
  paper_count: number
  feed_count: number
  last_activity: string | null
  created_at: string
}

export interface ActivityItem {
  type: 'paper_upload' | 'feed_generation'
  title: string
  detail: string
  timestamp: string
}

export interface Feed {
  id: string
  posts: FeedPost[]
  generated_at: string | null
  paper_count: number | null
  post_count: number | null
}

// DM / Messages types
export interface PaperConversation {
  paper_id: string
  title: string
  authors: string[]
  chunk_count: number
  has_summary: boolean
  summary_generated_at: string | null
  last_message_preview: string | null
  message_count: number
  uploaded_at: string
}

export interface SummaryMessage {
  role: 'paper' | 'synthesis'
  type: string
  content: string
  paper_ref?: string
}

export interface PaperSummary {
  paper_id: string
  title: string
  authors: string[]
  messages: SummaryMessage[]
  status: 'complete' | 'generating'
  task_id?: string
  generated_at?: string
}

export interface GroupChat {
  id: string
  name: string
  papers: Record<string, string>
  messages: SummaryMessage[]
  generated_at: string
}

export interface GroupChatPreview {
  id: string
  name: string
  paper_count: number
  message_count: number
  last_message_preview: string | null
  generated_at: string
}
