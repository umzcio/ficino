import { useState, useCallback, useRef, useEffect } from 'react'
import type { FeedPost } from '../types'
import { generateFeed, getFeedStatus, getFeed, listFeedSummaries, type FeedStatus } from '../lib/api'
import { cacheFeed, getCachedFeeds } from '../lib/offline-cache'
import { usePollTask, type PollController } from './usePollTask'

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
  const poll = usePollTask()
  const pollControllerRef = useRef<PollController | null>(null)
  // Tracks whether the component is still mounted so polling closures can
  // bail out before calling setState on an unmounted component (avoids the
  // "Can't perform a React state update on an unmounted component" warning).
  // Still needed alongside usePollTask: usePollTask only gates its own
  // isDone/onDone/onError dispatch, not the nested `await getFeed(...)`
  // inside onDone below, which can resolve after unmount.
  const mountedRef = useRef(true)

  const stopPolling = useCallback(() => {
    pollControllerRef.current?.stop()
    pollControllerRef.current = null
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
    // R10 DUP-11: canonical usePollTask chained-setTimeout poller.
    // generatingMeta is a per-tick (non-terminal) side effect, so it's set
    // inside `fn` itself — same mountedRef-gated pattern this file already
    // uses elsewhere — rather than in isDone/onDone, which only fire once.
    pollControllerRef.current = poll<FeedStatus>({
      fn: async () => {
        const status = await getFeedStatus(taskId)
        if (mountedRef.current && (status.status === 'generating' || status.status === 'started')) {
          setGeneratingMeta({
            step: status.meta?.step,
            postProgress: status.meta?.post_progress,
          })
        }
        return status
      },
      isDone: (status) => (status.status === 'complete' && !!status.feed_id) || status.status === 'error',
      onDone: async (status) => {
        if (status.status === 'complete' && status.feed_id) {
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
        }
      },
      onError: (err) => console.warn('Poll error:', err),
      intervalMs: 2000,
      initialDelayMs: 1000,
      // Flat 3s retry on error (not exponential) — matches the original
      // hand-rolled poller's fixed retry delay.
      backoff: () => 3000,
    })
    // Depend on workspaceId so `cacheFeed(feed, workspaceId)` above writes
    // under the current workspace key. With an empty deps array, a late
    // completion after a workspace switch would cache the new feed under
    // the previous workspace — offline reads from the new workspace miss.
  }, [workspaceId, poll])

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
