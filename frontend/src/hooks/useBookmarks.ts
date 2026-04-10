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
    async (feedId: string, postIndex: number, post: FeedPost) => {
      const existing = bookmarks.find(
        (b) => b.feed_id === feedId && b.post_index === postIndex
      )
      if (existing) {
        await deleteBookmarkByPost(feedId, postIndex)
      } else {
        await createBookmark(feedId, postIndex, post as unknown as Record<string, unknown>)
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
        (b) => b.feed_id === feedId && b.post_index === postIndex
      )
      return found?.id ?? null
    },
    [bookmarks]
  )

  return { bookmarks, loading, toggle, remove, isBookmarked, refresh }
}
