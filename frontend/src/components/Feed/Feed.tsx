import { useState, useEffect, useCallback, forwardRef } from 'react'
import { FileText, Loader2, AlertCircle } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import type { FeedPost } from '../../types'
import { getRepliedPostIndices } from '../../lib/api'
import { useLikes } from '../../hooks/useLikes'
import { PostCard } from './PostCard'

// Preserve the role="feed" semantic by overriding Virtuoso's List element.
// Virtuoso types the List ref as HTMLDivElement; cast through to keep its
// measurement API happy while rendering an <ol> for a11y.
const FeedList = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function FeedList(props, ref) {
    return (
      <ol
        role="feed"
        className="list-none p-0 m-0"
        {...(props as unknown as React.HTMLAttributes<HTMLOListElement>)}
        ref={ref as unknown as React.Ref<HTMLOListElement>}
      />
    )
  },
)

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
  onGenerate?: () => void
  onReplyBookmark?: (feedId: string, postIndex: number, messageIndex: number, snapshot: Record<string, unknown>) => void
  isReplyBookmarked?: (postIndex: number, messageIndex: number) => boolean
}

const STEP_LABELS: Record<string, string> = {
  scoping: 'Finding papers...',
  retrieving: 'Retrieving relevant chunks...',
  classifying: 'Detecting contradictions...',
  generating: 'Generating persona posts...',
}

const TAB_NAMES = ['For You', 'Debates', 'Methods', 'Findings']

// Tab index → category filter
const TAB_CATEGORIES: Record<number, string | null> = {
  0: null,         // For You — show all
  1: 'debates',    // Debates — quotes + replies
  2: 'methods',    // Methods — skeptic + methodologist
  3: 'findings',   // Findings — hype + figure posts
}

export function FeedContent({ posts, feedId, feedState, generatingMeta, error, activeTab, isBookmarked, onBookmarkToggle, getAnnotation, onAnnotationSave, onAnnotationDelete, onPostClick, onPersonaClick, onGenerate, onReplyBookmark, isReplyBookmarked }: FeedProps) {
  const [repliedIndices, setRepliedIndices] = useState<Set<number>>(new Set())
  // Track locally-deleted post indices for optimistic UI (persists until next feed reload)
  const [deletedIndices, setDeletedIndices] = useState<Set<number>>(new Set())
  const { isLiked, isReplyLiked, toggle: toggleLike, toggleReply: toggleReplyLike } = useLikes(feedId)
  const panelProps = {
    role: 'tabpanel' as const,
    id: `feed-panel-${activeTab}`,
    'aria-labelledby': `feed-tab-${activeTab}`,
    tabIndex: 0,
  }

  // Stable handler identities so PostCard's React.memo comparator can
  // actually skip re-renders. Per-post closures (onClick, which captures
  // `originalIndex`) can't be hoisted without changing PostCard's prop
  // shape — those stay inline and rely on the memo's explicit prop check.
  const handleBookmarkToggle = useCallback(
    (p: FeedPost, idx: number) => {
      if (feedId) onBookmarkToggle(feedId, idx, p)
    },
    [feedId, onBookmarkToggle],
  )
  const handlePostDeleted = useCallback(
    (idx: number) => setDeletedIndices((prev) => new Set(prev).add(idx)),
    [],
  )

  useEffect(() => {
    if (feedId && feedState === 'complete') {
      getRepliedPostIndices(feedId).then((indices) => setRepliedIndices(new Set(indices))).catch(() => {})
    } else {
      setRepliedIndices(new Set())
    }
  }, [feedId, feedState])
  // If generating with no existing posts, show full-screen spinner
  if (feedState === 'generating' && posts.length === 0) {
    const stepLabel = STEP_LABELS[generatingMeta.step || ''] || 'Starting...'
    return (
      <div {...panelProps} className="flex flex-col items-center justify-center py-20">
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
      <div {...panelProps} className="flex flex-col items-center justify-center py-20 text-persona-skeptic">
        <AlertCircle size={32} className="mb-4" />
        <p className="text-sm font-medium mb-1">Generation failed</p>
        <p className="text-xs text-text-muted max-w-[300px] text-center">{error}</p>
      </div>
    )
  }

  if (posts.length === 0) {
    return (
      <div {...panelProps} className="flex flex-col items-center justify-center py-20 text-text-muted">
        <FileText size={48} strokeWidth={1} className="mb-4 text-gold/30" />
        <p className="text-lg font-semibold text-text-mid mb-2">No posts yet</p>
        <p className="text-sm">Upload papers and click Generate to create your feed</p>
      </div>
    )
  }

  // Filter soft-deleted posts (server-side flag or optimistic local set) and apply tab filter.
  // Precompute originalIndex in a single pass so the render loop stays O(N)
  // instead of calling posts.indexOf(post) for every item (was O(N^2)).
  const categoryFilter = TAB_CATEGORIES[activeTab] ?? null
  const filtered = posts
    .map((post, originalIndex) => ({ post, originalIndex }))
    .filter(({ post, originalIndex }) => !post.deleted && !deletedIndices.has(originalIndex))
    .filter(({ post }) => !categoryFilter || post.category === categoryFilter)

  if (filtered.length === 0 && posts.length > 0) {
    const tabNames = TAB_NAMES
    return (
      <div {...panelProps} className="flex flex-col items-center justify-center py-20 text-text-muted">
        <p className="text-sm">No {tabNames[activeTab]?.toLowerCase()} posts in this feed.</p>
        <p className="text-xs mt-1 text-text-subtle">Try generating again for more variety.</p>
      </div>
    )
  }

  return (
    <div {...panelProps}>
      <Virtuoso
        data={filtered}
        useWindowScroll
        components={{ List: FeedList }}
        computeItemKey={(_, { post, originalIndex }) => post.id ?? `post-${originalIndex}`}
        itemContent={(_, { post, originalIndex }) => (
          <li className="list-none">
            <PostCard
              post={post}
              feedId={feedId}
              postIndex={originalIndex}
              bookmarkedId={feedId ? isBookmarked(feedId, originalIndex) : null}
              onBookmarkToggle={handleBookmarkToggle}
              onClick={() => onPostClick?.(originalIndex)}
              hasUserReply={repliedIndices.has(originalIndex)}
              annotation={feedId ? getAnnotation?.(feedId, originalIndex) ?? null : null}
              onAnnotationSave={onAnnotationSave}
              onAnnotationDelete={onAnnotationDelete}
              onPersonaClick={onPersonaClick}
              liked={isLiked(originalIndex)}
              onLikeToggle={toggleLike}
              isReplyLiked={isReplyLiked}
              onReplyLikeToggle={toggleReplyLike}
              onReplyBookmark={onReplyBookmark}
              isReplyBookmarked={isReplyBookmarked}
              onPostDeleted={handlePostDeleted}
            />
          </li>
        )}
      />
      <div className="py-5 text-center">
        {feedState === 'generating' ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <Loader2 size={24} className="text-gold animate-spin" />
            <p className="text-sm text-text-muted">
              {STEP_LABELS[generatingMeta.step || ''] || 'Generating more posts...'}
              {generatingMeta.postProgress && ` (${generatingMeta.postProgress})`}
            </p>
          </div>
        ) : (
          <button
            onClick={onGenerate}
            className="bg-transparent border border-border rounded-[20px] text-gold px-6 py-2.5 cursor-pointer text-[15px] font-semibold hover:bg-gold/5 transition-colors"
          >
            {activeTab === 0 ? 'Generate more posts' : `Generate more ${TAB_NAMES[activeTab]?.toLowerCase()} posts`}
          </button>
        )}
      </div>
    </div>
  )
}
