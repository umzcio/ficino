import { useState, useEffect, useCallback } from 'react'
import { listUserPosts, type UserPost } from '../lib/api'
import { cacheUserPosts, getCachedUserPosts } from '../lib/offline-cache'

export function useUserPosts(workspaceId: string | null) {
  const [posts, setPosts] = useState<UserPost[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await listUserPosts(workspaceId || undefined)
      cacheUserPosts(data, workspaceId || undefined).catch(() => {})
      setPosts(data)
    } catch {
      try {
        const cached = await getCachedUserPosts(workspaceId || undefined)
        if (cached.length > 0) setPosts(cached)
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Re-poll if any posts are pending
  useEffect(() => {
    const hasPending = posts.some(p => p.status === 'pending')
    if (!hasPending) return
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [posts, refresh])

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
