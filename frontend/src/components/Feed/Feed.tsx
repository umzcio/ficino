import { useState, useEffect } from 'react'
import { FileText, Loader2, AlertCircle } from 'lucide-react'
import type { FeedPost } from '../../types'
import { getRepliedPostIndices } from '../../lib/api'
import { PostCard } from './PostCard'

interface FeedProps {
  posts: FeedPost[]
  feedId: string | null
  feedState: 'idle' | 'loading' | 'generating' | 'complete' | 'error'
  generatingMeta: { step?: string; postProgress?: string }
  error: string | null
  activeTab: number
  isBookmarked: (feedId: string, postIndex: number) => string | null
  onBookmarkToggle: (feedId: string, postIndex: number, post: FeedPost) => void
  getAnnotation?: (feedId: string, postIndex: number) => string | null
  onAnnotationSave?: (feedId: string, postIndex: number, body: string) => void
  onAnnotationDelete?: (feedId: string, postIndex: number) => void
  onPostClick?: (postIndex: number) => void
  onPersonaClick?: (key: string) => void
}

const STEP_LABELS: Record<string, string> = {
  scoping: 'Finding papers...',
  retrieving: 'Retrieving relevant chunks...',
  classifying: 'Detecting contradictions...',
  generating: 'Generating persona posts...',
}

// Tab index → category filter
const TAB_CATEGORIES: Record<number, string | null> = {
  0: null,         // For You — show all
  1: 'debates',    // Debates — quotes + replies
  2: 'methods',    // Methods — skeptic + methodologist
  3: 'findings',   // Findings — hype + figure posts
}

export function FeedContent({ posts, feedId, feedState, generatingMeta, error, activeTab, isBookmarked, onBookmarkToggle, getAnnotation, onAnnotationSave, onAnnotationDelete, onPostClick, onPersonaClick }: FeedProps) {
  const [repliedIndices, setRepliedIndices] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (feedId && feedState === 'complete') {
      getRepliedPostIndices(feedId).then((indices) => setRepliedIndices(new Set(indices))).catch(() => {})
    } else {
      setRepliedIndices(new Set())
    }
  }, [feedId, feedState])
  if (feedState === 'generating') {
    const stepLabel = STEP_LABELS[generatingMeta.step || ''] || 'Starting...'
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 size={32} className="text-gold animate-spin mb-4" />
        <p className="text-sm font-medium text-text mb-1">{stepLabel}</p>
        {generatingMeta.postProgress && (
          <p className="text-xs text-text-muted">
            Post {generatingMeta.postProgress}
          </p>
        )}
      </div>
    )
  }

  if (feedState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-persona-skeptic">
        <AlertCircle size={32} className="mb-4" />
        <p className="text-sm font-medium mb-1">Generation failed</p>
        <p className="text-xs text-text-muted max-w-[300px] text-center">{error}</p>
      </div>
    )
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-muted">
        <FileText size={48} strokeWidth={1} className="mb-4 text-gold/30" />
        <p className="text-lg font-semibold text-text-mid mb-2">No posts yet</p>
        <p className="text-sm">Upload papers and click Generate to create your feed</p>
      </div>
    )
  }

  const categoryFilter = TAB_CATEGORIES[activeTab] ?? null
  const filtered = categoryFilter
    ? posts.filter((p) => p.category === categoryFilter)
    : posts

  if (filtered.length === 0 && posts.length > 0) {
    const tabNames = ['For You', 'Debates', 'Methods', 'Findings']
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-muted">
        <p className="text-sm">No {tabNames[activeTab]?.toLowerCase()} posts in this feed.</p>
        <p className="text-xs mt-1 text-text-muted/60">Try generating again for more variety.</p>
      </div>
    )
  }

  return (
    <div>
      {filtered.map((post, i) => {
        const originalIndex = posts.indexOf(post)
        return (
          <PostCard
            key={post.id ?? i}
            post={post}
            feedId={feedId}
            postIndex={originalIndex}
            bookmarkedId={feedId ? isBookmarked(feedId, originalIndex) : null}
            onBookmarkToggle={(p, idx) => feedId && onBookmarkToggle(feedId, idx, p)}
            onClick={() => onPostClick?.(originalIndex)}
            hasUserReply={repliedIndices.has(originalIndex)}
            annotation={feedId ? getAnnotation?.(feedId, originalIndex) ?? null : null}
            onAnnotationSave={onAnnotationSave}
            onAnnotationDelete={onAnnotationDelete}
            onPersonaClick={onPersonaClick}
          />
        )
      })}
      <div className="py-5 text-center">
        <button className="bg-transparent border border-border rounded-[20px] text-gold px-6 py-2.5 cursor-pointer text-[15px] font-semibold hover:bg-gold/5 transition-colors">
          Generate more posts
        </button>
      </div>
    </div>
  )
}
