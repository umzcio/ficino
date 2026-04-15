import { useState, useEffect, useCallback } from 'react'
import { listLikesForFeed, createLike, deleteLike } from '../lib/api'
import { cacheLikes, getCachedLikes } from '../lib/offline-cache'

export function useLikes(feedId: string | null) {
  const [likedPosts, setLikedPosts] = useState<Set<number>>(new Set())
  const [likedReplies, setLikedReplies] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!feedId) return
    listLikesForFeed(feedId)
      .then((data) => {
        cacheLikes(feedId, data).catch(() => {})
        setLikedPosts(new Set(data.posts))
        setLikedReplies(new Set(Object.keys(data.replies)))
      })
      .catch(async () => {
        try {
          const cached = await getCachedLikes(feedId)
          if (cached) {
            setLikedPosts(new Set(cached.posts))
            setLikedReplies(new Set(Object.keys(cached.replies)))
          }
        } catch { /* ignore */ }
      })
  }, [feedId])

  const isLiked = useCallback(
    (postIndex: number) => likedPosts.has(postIndex),
    [likedPosts],
  )

  const isReplyLiked = useCallback(
    (postIndex: number, messageIndex: number) => likedReplies.has(`${postIndex}:${messageIndex}`),
    [likedReplies],
  )

  const toggle = useCallback(
    async (postIndex: number, personaKey?: string, postType?: string, category?: string) => {
      if (!feedId) return
      const wasLiked = likedPosts.has(postIndex)

      setLikedPosts((prev) => {
        const next = new Set(prev)
        if (wasLiked) next.delete(postIndex)
        else next.add(postIndex)
        return next
      })

      try {
        if (wasLiked) await deleteLike(feedId, postIndex)
        else await createLike(feedId, postIndex, -1, personaKey, postType, category)
      } catch {
        setLikedPosts((prev) => {
          const reverted = new Set(prev)
          if (wasLiked) reverted.add(postIndex)
          else reverted.delete(postIndex)
          return reverted
        })
      }
    },
    [feedId, likedPosts],
  )

  const toggleReply = useCallback(
    async (postIndex: number, messageIndex: number, personaKey?: string) => {
      if (!feedId) return
      const key = `${postIndex}:${messageIndex}`
      const wasLiked = likedReplies.has(key)

      setLikedReplies((prev) => {
        const next = new Set(prev)
        if (wasLiked) next.delete(key)
        else next.add(key)
        return next
      })

      try {
        if (wasLiked) await deleteLike(feedId, postIndex, messageIndex)
        else await createLike(feedId, postIndex, messageIndex, personaKey)
      } catch {
        setLikedReplies((prev) => {
          const reverted = new Set(prev)
          if (wasLiked) reverted.add(key)
          else reverted.delete(key)
          return reverted
        })
      }
    },
    [feedId, likedReplies],
  )

  return { isLiked, isReplyLiked, toggle, toggleReply }
}
