import { Bookmark, Loader2 } from 'lucide-react'
import type { FeedPost } from '../../types'
import { PostCard } from '../Feed/PostCard'
import type { BookmarkItem } from '../../lib/api'

interface BookmarksViewProps {
  bookmarks: BookmarkItem[]
  loading: boolean
  onRemove: (bookmarkId: string) => void
  getAnnotation?: (feedId: string, postIndex: number) => string | null
  onAnnotationSave?: (feedId: string, postIndex: number, body: string) => void
  onAnnotationDelete?: (feedId: string, postIndex: number) => void
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function BookmarksView({ bookmarks, loading, onRemove, getAnnotation, onAnnotationSave, onAnnotationDelete }: BookmarksViewProps) {
  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5">
        <h1 className="text-xl font-bold text-text">Bookmarks</h1>
        <p className="text-xs text-text-muted mt-0.5">
          {bookmarks.length} saved post{bookmarks.length !== 1 ? 's' : ''}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="text-gold animate-spin" />
        </div>
      ) : bookmarks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <Bookmark size={48} strokeWidth={1} className="mb-4 text-gold/30" />
          <p className="text-lg font-semibold text-text-mid mb-2">No bookmarks yet</p>
          <p className="text-sm">Tap the bookmark icon on any post to save it here</p>
        </div>
      ) : (
        <div>
          {bookmarks.map((bm) => (
            <div key={bm.id} className="relative">
              <PostCard
                post={bm.post as unknown as FeedPost}
                feedId={bm.feed_id}
                postIndex={bm.post_index}
                bookmarkedId={bm.id}
                onBookmarkToggle={() => onRemove(bm.id)}
                annotation={getAnnotation?.(bm.feed_id, bm.post_index) ?? null}
                onAnnotationSave={onAnnotationSave}
                onAnnotationDelete={onAnnotationDelete}
              />
              <div className="absolute top-3 right-12 text-[10px] text-text-muted/50">
                Saved {timeAgo(bm.bookmarked_at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
