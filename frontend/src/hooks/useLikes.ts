import { useState, useEffect, useCallback } from 'react'
import { listLikesForFeed, createLike, deleteLike } from '../lib/api'

export function useLikes(feedId: string | null) {
  const [likedIndices, setLikedIndices] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!feedId) return
    listLikesForFeed(feedId)
      .then((indices) => setLikedIndices(new Set(indices)))
      .catch(() => {/* ignore */})
  }, [feedId])

  const isLiked = useCallback(
    (postIndex: number) => likedIndices.has(postIndex),
    [likedIndices],
  )

  const toggle = useCallback(
    async (postIndex: number, personaKey?: string, postType?: string, category?: string) => {
      if (!feedId) return
      const wasLiked = likedIndices.has(postIndex)

      // Optimistic update
      setLikedIndices((prev) => {
        const next = new Set(prev)
        if (wasLiked) {
          next.delete(postIndex)
        } else {
          next.add(postIndex)
        }
        return next
      })

      try {
        if (wasLiked) {
          await deleteLike(feedId, postIndex)
        } else {
          await createLike(feedId, postIndex, personaKey, postType, category)
        }
      } catch {
        // Revert on failure
        setLikedIndices((prev) => {
          const reverted = new Set(prev)
          if (wasLiked) {
            reverted.add(postIndex)
          } else {
            reverted.delete(postIndex)
          }
          return reverted
        })
      }
    },
    [feedId, likedIndices],
  )

  return { isLiked, toggle }
}
