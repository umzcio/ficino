import { useState, useCallback, useRef, useEffect } from 'react'
import type { FeedPost } from '../types'
import { generateFeed, getFeedStatus, getFeed, listFeedSummaries } from '../lib/api'
import { cacheFeed, getCachedFeeds } from '../lib/offline-cache'

type FeedState = 'idle' | 'loading' | 'generating' | 'complete' | 'error'

interface GeneratingMeta {
  step?: string
  postProgress?: string
}

export function useFeed(workspaceId?: string) {
  const [posts, setPosts] = useState<FeedPost[]>([])
  const [feedId, setFeedId] = useState<string | null>(null)
  const [feedState, setFeedState] = useState<FeedState>('loading')
  const [generatingMeta, setGeneratingMeta] = useState<GeneratingMeta>({})
  const [error, setError] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks whether the component is still mounted so polling closures can
  // bail out before calling setState on an unmounted component (avoids the
  // "Can't perform a React state update on an unmounted component" warning).
  const mountedRef = useRef(true)

  const stopPolling = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  // Load most recent feed on mount or workspace change. Every setState is
  // gated on mountedRef AND a per-effect `active` sentinel so that:
  //   (a) a late-resolving fetch from an unmounted component is a no-op,
  //   (b) a fetch started for workspace A doesn't overwrite the UI after
  //       the user has already switched to workspace B (the old fetch
  //       resolving late would otherwise show A's feed under B's header).
  useEffect(() => {
    let active = true
    async function loadLatest() {
      if (!mountedRef.current) return
      setFeedState('loading')
      try {
        // Metadata-only list so a workspace switch doesn't stream
        // ~10 MB of JSONB the user will never read. Hydrate the latest
        // feed's full posts with a second request when we actually need
        // them. Past feeds only get hydrated when the user clicks one
        // in FeedHistory.
        const summaries = await listFeedSummaries(workspaceId)
        if (!active || !mountedRef.current) return
        const latest = summaries[0]
        if (latest && (latest.post_count ?? 0) > 0) {
          const full = await getFeed(latest.id)
          if (!active || !mountedRef.current) return
          cacheFeed(full, workspaceId).catch(() => {})
          setPosts(full.posts as FeedPost[])
          setFeedId(full.id)
          setFeedState('complete')
        } else {
          setPosts([])
          setFeedId(null)
          setFeedState('idle')
        }
      } catch {
        // Offline fallback: try IndexedDB
        try {
          const cached = await getCachedFeeds(workspaceId)
          if (!active || !mountedRef.current) return
          if (cached.length > 0 && cached[0].posts.length > 0) {
            setPosts(cached[0].posts as FeedPost[])
            setFeedId(cached[0].id)
            setFeedState('complete')
            return
          }
        } catch { /* ignore */ }
        if (active && mountedRef.current) setFeedState('idle')
      }
    }
    loadLatest()
    return () => {
      active = false
    }
  }, [workspaceId])

  const pollStatus = useCallback((taskId: string) => {
    // Use setTimeout chain instead of setInterval to avoid stacking.
    // Every setState is gated on `mountedRef.current` so a completion arriving
    // after unmount doesn't fire a state update warning.
    async function poll() {
      if (!mountedRef.current) return
      try {
        const status = await getFeedStatus(taskId)
        if (!mountedRef.current) return

        if (status.status === 'generating' || status.status === 'started') {
          setGeneratingMeta({
            step: status.meta?.step,
            postProgress: status.meta?.post_progress,
          })
          timeoutRef.current = setTimeout(poll, 2000)
        } else if (status.status === 'complete' && status.feed_id) {
          const feed = await getFeed(status.feed_id)
          if (!mountedRef.current) return
          // Pass workspaceId so getCachedFeeds(workspaceId) — which queries
          // the by-workspace IDB index — returns this feed offline.
          cacheFeed(feed, workspaceId).catch(() => {})
          setPosts(feed.posts as FeedPost[])
          setFeedId(status.feed_id)
          setFeedState('complete')
          setGeneratingMeta({})
        } else if (status.status === 'error') {
          setError(status.error || 'Feed generation failed')
          setFeedState('error')
        } else {
          // Still pending or unknown state — keep polling
          timeoutRef.current = setTimeout(poll, 2000)
        }
      } catch (err) {
        console.warn('Poll error:', err)
        if (mountedRef.current) {
          // Keep polling on transient errors
          timeoutRef.current = setTimeout(poll, 3000)
        }
      }
    }

    timeoutRef.current = setTimeout(poll, 1000)
    // Depend on workspaceId so `cacheFeed(feed, workspaceId)` above writes
    // under the current workspace key. With an empty deps array, a late
    // completion after a workspace switch would cache the new feed under
    // the previous workspace — offline reads from the new workspace miss.
  }, [workspaceId])

  const generate = useCallback(async (corpusId?: string, tagFilter?: string[], appendToFeedId?: string, tabFocus?: string, personaKey?: string, numPosts?: number) => {
    setFeedState('generating')
    setGeneratingMeta({})
    setError(null)
    stopPolling()

    try {
      const { task_id } = await generateFeed(corpusId, tagFilter, appendToFeedId, tabFocus, personaKey, numPosts)
      pollStatus(task_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start generation')
      setFeedState('error')
    }
  }, [stopPolling, pollStatus])

  const loadFeed = useCallback((feed: { id: string; posts: unknown[] }) => {
    stopPolling()
    setPosts(feed.posts as FeedPost[])
    setFeedId(feed.id)
    setFeedState('complete')
    setError(null)
  }, [stopPolling])

  // Cleanup on unmount — clear the pending timeout AND flip the mounted ref
  // so any in-flight fetch resolving after unmount short-circuits before
  // calling setState.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopPolling()
    }
  }, [stopPolling])

  // "Delete All Papers" and "Delete Everything" both wipe feeds on the
  // server. Reset the feed view the moment either bulk delete completes.
  useEffect(() => {
    const onCleared = () => {
      stopPolling()
      setPosts([])
      setFeedId(null)
      setFeedState('idle')
      setError(null)
    }
    window.addEventListener('ficino:papers-cleared', onCleared)
    window.addEventListener('ficino:everything-cleared', onCleared)
    return () => {
      window.removeEventListener('ficino:papers-cleared', onCleared)
      window.removeEventListener('ficino:everything-cleared', onCleared)
    }
  }, [stopPolling])

  return { posts, feedId, feedState, generatingMeta, error, generate, loadFeed }
}
