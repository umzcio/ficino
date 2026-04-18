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
  // Gate setState calls in async paths so a refresh() resolving after
  // unmount doesn't update a dead component.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    extraPollsRef.current = 0
  }, [])

  // Track the workspaceId a fetch was issued for, so a slow response for an
  // older workspace can be discarded rather than clobbering the UI after
  // the user has switched workspaces.
  const workspaceForFetchRef = useRef<string | undefined>(workspaceId)
  useEffect(() => {
    workspaceForFetchRef.current = workspaceId
  }, [workspaceId])

  const refresh = useCallback(async () => {
    const issuedFor = workspaceId
    try {
      const data = await listPapers(workspaceId)
      if (!mountedRef.current || workspaceForFetchRef.current !== issuedFor) return null
      cachePapers(data, workspaceId).catch(() => {})
      setPapers(data)
      setError(null)
      return data
    } catch (err) {
      // Offline fallback
      try {
        const cached = await getCachedPapers(workspaceId)
        if (!mountedRef.current || workspaceForFetchRef.current !== issuedFor) return null
        if (cached.length > 0) {
          setPapers(cached)
          setError(null)
          return cached
        }
      } catch { /* ignore */ }
      if (mountedRef.current && workspaceForFetchRef.current === issuedFor) {
        setError(err instanceof Error ? err.message : 'Failed to load papers')
      }
      return null
    } finally {
      if (mountedRef.current && workspaceForFetchRef.current === issuedFor) setLoading(false)
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
        (p) => p.status && !['complete', 'error'].includes(p.status),
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

  // Start polling when papers go into a processing state. Separate from
  // the unmount cleanup — otherwise every setPapers() fires the cleanup
  // + restart cycle, which can drop a poll tick mid-flight. schedulePoll
  // already guards against double-scheduling via timeoutRef.
  useEffect(() => {
    const hasProcessing = papers.some(
      (p) => p.status && !['complete', 'error'].includes(p.status),
    )
    if (hasProcessing) {
      extraPollsRef.current = 3
      schedulePoll()
    }
  }, [papers, schedulePoll])

  // Dedicated cleanup effect: only clears the pending timeout on unmount.
  useEffect(() => () => stopPolling(), [stopPolling])

  // Refresh when a bulk "Delete All Papers" OR "Delete Everything" happens
  // from Settings. Both wipe the IDB store and dispatch; the corpus view
  // drops its stale list without a hard reload.
  useEffect(() => {
    const onCleared = () => {
      stopPolling()
      setPapers([])
      refresh()
    }
    window.addEventListener('ficino:papers-cleared', onCleared)
    window.addEventListener('ficino:everything-cleared', onCleared)
    return () => {
      window.removeEventListener('ficino:papers-cleared', onCleared)
      window.removeEventListener('ficino:everything-cleared', onCleared)
    }
  }, [refresh, stopPolling])

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
