import { useState, useEffect, useCallback } from 'react'
import { listUserPosts, type UserPost } from '../lib/api'
import { cacheUserPosts, getCachedUserPosts } from '../lib/offline-cache'
import { usePollTask } from './usePollTask'

export function useUserPosts(workspaceId: string | null) {
  const [posts, setPosts] = useState<UserPost[]>([])
  const [loading, setLoading] = useState(true)
  const poll = usePollTask()

  // Returns the freshly fetched list (or the cache fallback), so the
  // poller below can decide isDone from the actual snapshot rather than
  // the stale `posts` closure — `null` means both the live and cached
  // fetch failed and we genuinely don't know the current state, so the
  // poll should NOT treat that as "no longer pending". Public callers
  // (ComposeBox's onPostCreated, UserPostCard's onDeleted) only ever use
  // this as a `() => void` trigger, so widening the return type is safe.
  const refresh = useCallback(async (): Promise<UserPost[] | null> => {
    try {
      const data = await listUserPosts(workspaceId || undefined)
      cacheUserPosts(data, workspaceId || undefined).catch(() => {})
      setPosts(data)
      return data
    } catch {
      try {
        const cached = await getCachedUserPosts(workspaceId || undefined)
        if (cached.length > 0) {
          setPosts(cached)
          return cached
        }
        return null
      } catch { return null }
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Re-poll if any posts are pending. R10 DUP-11: converted from a bare
  // setInterval(refresh, 3000) to usePollTask — same cadence (first check
  // at 3s, matching setInterval semantics), but a chained setTimeout
  // instead of a free-running interval, and `null` (couldn't determine
  // current state) is treated as not-done so a fetch blip doesn't
  // prematurely stop the poll.
  useEffect(() => {
    const hasPending = posts.some(p => p.status === 'pending')
    if (!hasPending) return
    const controller = poll<UserPost[] | null>({
      fn: refresh,
      isDone: (data) => data !== null && !data.some(p => p.status === 'pending'),
      onDone: () => { /* refresh() already applied setPosts internally */ },
      intervalMs: 3000,
    })
    return () => controller.stop()
  }, [posts, refresh, poll])

  // Refresh when a bulk clear happens from Settings: either the targeted
  // "Clear All Conversations" button or the nuclear "Delete Everything"
  // reset. Both dispatch their own event; listen to both so the view
  // drops its stale list without a hard reload.
  useEffect(() => {
    const onCleared = () => {
      setPosts([])
      refresh()
    }
    window.addEventListener('ficino:user-posts-cleared', onCleared)
    window.addEventListener('ficino:everything-cleared', onCleared)
    return () => {
      window.removeEventListener('ficino:user-posts-cleared', onCleared)
      window.removeEventListener('ficino:everything-cleared', onCleared)
    }
  }, [refresh])

  return { posts, loading, refresh }
}
