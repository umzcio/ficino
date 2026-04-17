import { useState, useEffect, useCallback } from 'react'
import { listAnnotations, upsertAnnotation, deleteAnnotation, type AnnotationItem } from '../lib/api'
import { cacheAnnotations, getCachedAnnotations } from '../lib/offline-cache'

export function useAnnotations() {
  // ReadonlyMap signals to callers that they must NOT mutate this Map directly
  // (React won't re-render on in-place .set / .delete — state must round-trip
  // through setAnnotations with a new Map instance).
  const [annotations, setAnnotations] = useState<ReadonlyMap<string, AnnotationItem>>(new Map())
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await listAnnotations()
      cacheAnnotations(data).catch(() => {})
      const map = new Map<string, AnnotationItem>()
      for (const a of data) map.set(`${a.feed_id}:${a.post_index}`, a)
      setAnnotations(map)
    } catch {
      try {
        const cached = await getCachedAnnotations()
        if (cached.length > 0) {
          const map = new Map<string, AnnotationItem>()
          for (const a of cached) map.set(`${a.feed_id}:${a.post_index}`, a)
          setAnnotations(map)
        }
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const getNote = useCallback(
    (feedId: string, postIndex: number): string | null => {
      return annotations.get(`${feedId}:${postIndex}`)?.body ?? null
    },
    [annotations],
  )

  const save = useCallback(
    async (feedId: string, postIndex: number, body: string) => {
      await upsertAnnotation(feedId, postIndex, body)
      await refresh()
    },
    [refresh],
  )

  const remove = useCallback(
    async (feedId: string, postIndex: number) => {
      await deleteAnnotation(feedId, postIndex)
      await refresh()
    },
    [refresh],
  )

  return { annotations, loading, getNote, save, remove }
}
