import { useState, useEffect, useCallback, useRef } from 'react'
import type { Paper } from '../types'
import { listPapers, uploadPaper, deletePaper } from '../lib/api'
import { cachePapers, getCachedPapers } from '../lib/offline-cache'

export function useCorpus(workspaceId?: string) {
  const [papers, setPapers] = useState<Paper[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const extraPollsRef = useRef(0)

  const stopPolling = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    extraPollsRef.current = 0
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await listPapers(workspaceId)
      cachePapers(data, workspaceId).catch(() => {})
      setPapers(data)
      setError(null)
      return data
    } catch (err) {
      // Offline fallback
      try {
        const cached = await getCachedPapers(workspaceId)
        if (cached.length > 0) {
          setPapers(cached)
          setError(null)
          return cached
        }
      } catch { /* ignore */ }
      setError(err instanceof Error ? err.message : 'Failed to load papers')
      return null
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  // Polling with setTimeout (avoids overlapping requests)
  const schedulePoll = useCallback(() => {
    if (timeoutRef.current) return // already scheduled

    timeoutRef.current = setTimeout(async () => {
      timeoutRef.current = null
      const data = await refresh()
      if (!data) {
        schedulePoll() // retry on error
        return
      }

      const hasProcessing = data.some(
        (p) => !['complete', 'error'].includes(p.status)
      )

      if (hasProcessing) {
        extraPollsRef.current = 3 // reset extra polls
        schedulePoll()
      } else if (extraPollsRef.current > 0) {
        // Poll a few more times to catch late transitions
        extraPollsRef.current--
        schedulePoll()
      }
    }, 2000)
  }, [refresh])

  // Initial load
  useEffect(() => {
    refresh()
  }, [refresh])

  // Start/stop polling based on paper states
  useEffect(() => {
    const hasProcessing = papers.some(
      (p) => !['complete', 'error'].includes(p.status)
    )

    if (hasProcessing) {
      extraPollsRef.current = 3
      schedulePoll()
    }

    return () => stopPolling()
  }, [papers, schedulePoll, stopPolling])

  const upload = useCallback(async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      await uploadPaper(file, workspaceId)
      // Immediately refresh and start polling
      const data = await refresh()
      if (data) {
        extraPollsRef.current = 3
        schedulePoll()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [workspaceId, refresh, schedulePoll])

  const remove = useCallback(async (paperId: string) => {
    try {
      await deletePaper(paperId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }, [refresh])

  return { papers, loading, uploading, error, upload, remove, refresh }
}
