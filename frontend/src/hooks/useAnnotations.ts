import { useState, useEffect, useCallback } from 'react'
import { listAnnotations, upsertAnnotation, deleteAnnotation, type AnnotationItem } from '../lib/api'

export function useAnnotations() {
  const [annotations, setAnnotations] = useState<Map<string, AnnotationItem>>(new Map())
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await listAnnotations()
      const map = new Map<string, AnnotationItem>()
      for (const a of data) map.set(`${a.feed_id}:${a.post_index}`, a)
      setAnnotations(map)
    } catch {
      // ignore
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
