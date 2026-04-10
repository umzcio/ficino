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

export interface Persona {
  handle: string
  name: string
  initials: string
  color: string
}

export type PersonaKey = 'skeptic' | 'hype' | 'practitioner' | 'methodologist' | 'gradstudent'

export const PERSONAS: Record<PersonaKey, Persona> = {
  skeptic:       { handle: '@skeptical_methods', name: 'Methods Skeptic',  initials: 'MS', color: '#e85d4a' },
  hype:          { handle: '@ai_breakthroughs',  name: 'AI Breakthroughs', initials: 'AB', color: '#f5a623' },
  practitioner:  { handle: '@real_world_ml',     name: 'Practitioner Pat', initials: 'PP', color: '#4a9eff' },
  methodologist: { handle: '@stats_nerd',        name: 'Stats Nerd',       initials: 'SN', color: '#a78bfa' },
  gradstudent:   { handle: '@phd_suffering',     name: 'PhD Candidate',    initials: 'PC', color: '#34d399' },
} as const

export interface FeedPost {
  id: number
  persona: PersonaKey
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
  sources?: { paper_title: string; section: string; content: string; score: number }[]
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
