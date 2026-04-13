import { ArrowLeft } from 'lucide-react'
import type { FeedPost } from '../../types'
import { usePersonas, type PersonaMap } from '../../hooks/usePersonas'
import { useLikes } from '../../hooks/useLikes'
import { PostCard, InlineMd } from './PostCard'

interface PostDetailProps {
  post: FeedPost
  postIndex: number
  posts: FeedPost[]
  feedId: string | null
  onBack: () => void
  onNavigateToPost: (index: number) => void
  isBookmarked: (feedId: string, postIndex: number) => string | null
  onBookmarkToggle: (feedId: string, postIndex: number, post: FeedPost) => void
  getAnnotation?: (feedId: string, postIndex: number) => string | null
  onAnnotationSave?: (feedId: string, postIndex: number, body: string) => void
  onAnnotationDelete?: (feedId: string, postIndex: number) => void
  autoOpenReply?: boolean
}

function findParentPost(
  posts: FeedPost[],
  currentIndex: number,
  handle: string,
  personas: PersonaMap,
): { post: FeedPost; index: number } | null {
  const handleToKey: Record<string, string> = {}
  for (const [key, p] of Object.entries(personas)) {
    handleToKey[p.handle] = key
  }
  const targetKey = handleToKey[handle]
  if (!targetKey) return null

  for (let i = currentIndex - 1; i >= 0; i--) {
    if (posts[i].persona === targetKey) {
      return { post: posts[i], index: i }
    }
  }
  return null
}

function findQuotedPost(
  posts: FeedPost[],
  currentIndex: number,
  quotingHandle: string,
  quotingContent: string,
  personas: PersonaMap,
): { post: FeedPost; index: number } | null {
  const handleToKey: Record<string, string> = {}
  for (const [key, p] of Object.entries(personas)) {
    handleToKey[p.handle] = key
  }
  const targetKey = handleToKey[quotingHandle]
  if (!targetKey) return null

  for (let i = currentIndex - 1; i >= 0; i--) {
    if (posts[i].persona === targetKey && posts[i].content?.includes(quotingContent.slice(0, 50))) {
      return { post: posts[i], index: i }
    }
  }
  // Fallback: just find the most recent post by that persona
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (posts[i].persona === targetKey) {
      return { post: posts[i], index: i }
    }
  }
  return null
}

function ParentPostCard({ post, personas, onClick }: { post: FeedPost; personas: PersonaMap; onClick: () => void }) {
  const p = personas[post.persona]
  if (!p) return null

  return (
    <div
      className="px-4 py-3 flex gap-3 border-b border-border hover:bg-bg-hover cursor-pointer transition-colors"
      onClick={onClick}
    >
      <div className="flex flex-col items-center">
        {p.avatar_url ? (
          <img src={p.avatar_url} alt={p.name} className="w-[42px] h-[42px] rounded-full shrink-0 object-cover" style={{ border: `2px solid ${p.color}50` }} />
        ) : (
          <div
            className="w-[42px] h-[42px] rounded-full shrink-0 flex items-center justify-center text-[13px] font-bold tracking-tight"
            style={{ backgroundColor: p.color + '28', border: `2px solid ${p.color}50`, color: p.color }}
          >
            {p.initials}
          </div>
        )}
        <div className="w-0.5 flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="font-bold text-[15px] text-text">{p.name}</span>
          <span className="text-sm text-text-muted">{p.handle}</span>
          <span className="text-sm text-text-muted">· {post.time}</span>
        </div>
        <p className="text-[15px] text-text leading-relaxed whitespace-pre-wrap break-words">
          <InlineMd text={post.content} />
        </p>
      </div>
    </div>
  )
}

export function PostDetail({
  post, postIndex, posts, feedId,
  onBack, onNavigateToPost,
  isBookmarked, onBookmarkToggle,
  getAnnotation, onAnnotationSave, onAnnotationDelete,
  autoOpenReply,
}: PostDetailProps) {
  const personas = usePersonas()
  const { isLiked, isReplyLiked, toggle: toggleLike, toggleReply: toggleReplyLike } = useLikes(feedId)

  // Find parent post for replies
  const parent = post.replying_to
    ? findParentPost(posts, postIndex, post.replying_to, personas)
    : null

  // Find quoted post
  const quoted = (post.post_type === 'quote' && post.quoting_handle && post.quoting_content)
    ? findQuotedPost(posts, postIndex, post.quoting_handle, post.quoting_content, personas)
    : null

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3 flex items-center gap-4">
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors"
          aria-label="Back to feed"
        >
          <ArrowLeft size={18} className="text-text" />
        </button>
        <span className="text-lg font-bold text-text">Post</span>
      </div>

      {/* Parent post (if reply) */}
      {parent && (
        <ParentPostCard
          post={parent.post}
          personas={personas}
          onClick={() => onNavigateToPost(parent.index)}
        />
      )}

      {/* The focused post — full size, reply open by default */}
      <PostCard
        post={post}
        feedId={feedId}
        postIndex={postIndex}
        bookmarkedId={feedId ? isBookmarked(feedId, postIndex) : null}
        onBookmarkToggle={(p, idx) => feedId && onBookmarkToggle(feedId, idx, p)}
        annotation={feedId ? getAnnotation?.(feedId, postIndex) ?? null : null}
        onAnnotationSave={onAnnotationSave}
        onAnnotationDelete={onAnnotationDelete}
        autoOpenReply={autoOpenReply}
        liked={isLiked(postIndex)}
        onLikeToggle={toggleLike}
        isReplyLiked={isReplyLiked}
        onReplyLikeToggle={toggleReplyLike}
      />

      {/* If quote post, make the quoted block navigable */}
      {quoted && (
        <div className="px-4 py-3 border-b border-border">
          <div className="text-[11px] text-text-muted uppercase tracking-wider font-bold mb-2">Original post</div>
          <ParentPostCard
            post={quoted.post}
            personas={personas}
            onClick={() => onNavigateToPost(quoted.index)}
          />
        </div>
      )}

      {/* Posts that reply to or quote this post (downstream) */}
      {(() => {
        const p = personas[post.persona]
        if (!p) return null
        const downstream = posts
          .map((dp, di) => ({ dp, di }))
          .filter(({ dp, di }) =>
            di > postIndex && (
              dp.replying_to === p.handle ||
              (dp.post_type === 'quote' && dp.quoting_handle === p.handle)
            )
          )
        if (downstream.length === 0) return null
        return (
          <div>
            <div className="px-4 py-2 text-[11px] text-text-muted uppercase tracking-wider font-bold border-b border-border">
              Responses
            </div>
            {downstream.map(({ dp, di }) => (
              <PostCard
                key={di}
                post={dp}
                feedId={feedId}
                postIndex={di}
                bookmarkedId={feedId ? isBookmarked(feedId, di) : null}
                onBookmarkToggle={(p2, idx) => feedId && onBookmarkToggle(feedId, idx, p2)}
                annotation={feedId ? getAnnotation?.(feedId, di) ?? null : null}
                onAnnotationSave={onAnnotationSave}
                onAnnotationDelete={onAnnotationDelete}
                onClick={() => onNavigateToPost(di)}
                liked={isLiked(di)}
                onLikeToggle={toggleLike}
                isReplyLiked={isReplyLiked}
                onReplyLikeToggle={toggleReplyLike}
              />
            ))}
          </div>
        )
      })()}
    </div>
  )
}
