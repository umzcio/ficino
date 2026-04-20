import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { FeedPost } from '../types'
import {
  listBookmarks,
  createBookmark,
  deleteBookmarkByPost,
  deleteBookmark,
  type BookmarkItem,
} from '../lib/api'
import { cacheBookmarks, getCachedBookmarks } from '../lib/offline-cache'

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [loading, setLoading] = useState(true)
  // Sentinel: keys of in-flight toggle operations. Double-clicks race against
  // refresh() — the second click reads the stale `bookmarks` closure before
  // the first's refresh lands. Drop any toggle whose key is already in flight.
  const inFlight = useRef<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    try {
      const data = await listBookmarks()
      cacheBookmarks(data).catch(() => {})
      setBookmarks(data)
    } catch {
      try {
        const cached = await getCachedBookmarks()
        if (cached.length > 0) setBookmarks(cached)
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = useCallback(
    async (feedId: string, postIndex: number, post: FeedPost, messageIndex: number = -1) => {
      const key = `${feedId}:${postIndex}:${messageIndex}`
      if (inFlight.current.has(key)) return
      inFlight.current.add(key)
      try {
        const existing = bookmarks.find(
          (b) => b.feed_id === feedId && b.post_index === postIndex && (b.message_index ?? -1) === messageIndex
        )
        if (existing) {
          await deleteBookmarkByPost(feedId, postIndex, messageIndex)
        } else {
          await createBookmark(feedId, postIndex, post as unknown as Record<string, unknown>, messageIndex)
        }
        await refresh()
      } finally {
        inFlight.current.delete(key)
      }
    },
    [bookmarks, refresh]
  )

  const remove = useCallback(
    async (bookmarkId: string) => {
      await deleteBookmark(bookmarkId)
      await refresh()
    },
    [refresh]
  )

  // Index bookmarks once per state change into a Map keyed by
  // feedId:postIndex:messageIndex. PostCard calls isBookmarked /
  // isReplyBookmarked during render for every row, so linear scans
  // here produced O(posts × bookmarks) work per feed render. A 20-post
  // feed × 500 bookmarks = 10k comparisons on every re-render.
  const bookmarkIndex = useMemo(() => {
    const map = new Map<string, BookmarkItem>()
    for (const b of bookmarks) {
      const mi = b.message_index ?? -1
      map.set(`${b.feed_id}:${b.post_index}:${mi}`, b)
    }
    return map
  }, [bookmarks])

  const isBookmarked = useCallback(
    (feedId: string, postIndex: number): string | null => {
      return bookmarkIndex.get(`${feedId}:${postIndex}:-1`)?.id ?? null
    },
    [bookmarkIndex]
  )

  const isReplyBookmarked = useCallback(
    (feedId: string, postIndex: number, messageIndex: number): boolean => {
      return bookmarkIndex.has(`${feedId}:${postIndex}:${messageIndex}`)
    },
    [bookmarkIndex]
  )

  return { bookmarks, loading, toggle, remove, isBookmarked, isReplyBookmarked, refresh }
}
