import { useState, useCallback, useRef, useEffect } from 'react'
import type { FeedPost } from '../types'
import { generateFeed, getFeedStatus, getFeed, listFeeds } from '../lib/api'

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

  const stopPolling = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  // Load most recent feed on mount or workspace change
  useEffect(() => {
    async function loadLatest() {
      setFeedState('loading')
      try {
        const feeds = await listFeeds(workspaceId)
        if (feeds.length > 0 && feeds[0].posts.length > 0) {
          setPosts(feeds[0].posts as FeedPost[])
          setFeedId(feeds[0].id)
          setFeedState('complete')
        } else {
          setPosts([])
          setFeedId(null)
          setFeedState('idle')
        }
      } catch {
        setFeedState('idle')
      }
    }
    loadLatest()
  }, [workspaceId])

  const pollStatus = useCallback((taskId: string) => {
    // Use setTimeout chain instead of setInterval to avoid stacking
    async function poll() {
      try {
        const status = await getFeedStatus(taskId)

        if (status.status === 'generating' || status.status === 'started') {
          setGeneratingMeta({
            step: status.meta?.step,
            postProgress: status.meta?.post_progress,
          })
          timeoutRef.current = setTimeout(poll, 2000)
        } else if (status.status === 'complete' && status.feed_id) {
          const feed = await getFeed(status.feed_id)
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
        // Keep polling on transient errors
        timeoutRef.current = setTimeout(poll, 3000)
      }
    }

    timeoutRef.current = setTimeout(poll, 1000)
  }, [])

  const generate = useCallback(async (corpusId?: string, tagFilter?: string[], appendToFeedId?: string, tabFocus?: string) => {
    setFeedState('generating')
    setGeneratingMeta({})
    setError(null)
    stopPolling()

    try {
      const { task_id } = await generateFeed(corpusId, tagFilter, appendToFeedId, tabFocus)
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

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  return { posts, feedId, feedState, generatingMeta, error, generate, loadFeed }
}
