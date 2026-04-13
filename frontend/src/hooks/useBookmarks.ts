import { useState, useEffect, useCallback } from 'react'
import type { FeedPost } from '../types'
import {
  listBookmarks,
  createBookmark,
  deleteBookmarkByPost,
  deleteBookmark,
  type BookmarkItem,
} from '../lib/api'

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await listBookmarks()
      setBookmarks(data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = useCallback(
    async (feedId: string, postIndex: number, post: FeedPost, messageIndex: number = -1) => {
      const existing = bookmarks.find(
        (b) => b.feed_id === feedId && b.post_index === postIndex && (b.message_index ?? -1) === messageIndex
      )
      if (existing) {
        await deleteBookmarkByPost(feedId, postIndex, messageIndex)
      } else {
        await createBookmark(feedId, postIndex, post as unknown as Record<string, unknown>, messageIndex)
      }
      await refresh()
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

  const isBookmarked = useCallback(
    (feedId: string, postIndex: number): string | null => {
      const found = bookmarks.find(
        (b) => b.feed_id === feedId && b.post_index === postIndex && (b.message_index ?? -1) === -1
      )
      return found?.id ?? null
    },
    [bookmarks]
  )

  const isReplyBookmarked = useCallback(
    (feedId: string, postIndex: number, messageIndex: number): boolean => {
      return bookmarks.some(
        (b) => b.feed_id === feedId && b.post_index === postIndex && b.message_index === messageIndex
      )
    },
    [bookmarks]
  )

  return { bookmarks, loading, toggle, remove, isBookmarked, isReplyBookmarked, refresh }
}
