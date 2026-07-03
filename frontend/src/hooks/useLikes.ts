import { useState, useEffect, useCallback } from 'react'
import { listLikesForFeed, createLike, deleteLike } from '../lib/api'
import { cacheLikes, getCachedLikes } from '../lib/offline-cache'

export function useLikes(feedId: string | null) {
  const [likedPosts, setLikedPosts] = useState<Set<number>>(new Set())
  const [likedReplies, setLikedReplies] = useState<Set<string>>(new Set())

  useEffect(() => {
    // R10 FE-16: reset before the feedId guard so a feed switch (or the feed
    // being cleared to null) never leaves the previous feed's like state
    // showing against the new feed's post indices — likes are index-keyed,
    // so a stale carryover lights hearts on arbitrary posts until (unless)
    // the new fetch resolves.
    const reset = () => {
      setLikedPosts(new Set())
      setLikedReplies(new Set())
    }
    reset()
    if (!feedId) return
    // Without this sentinel, switching from a slow-responding feed A to
    // a fast-responding feed B would let A's late response overwrite
    // B's already-rendered likes state (Round 9 #15).
    let active = true
    listLikesForFeed(feedId)
      .then((data) => {
        if (!active) return
        cacheLikes(feedId, data).catch(() => {})
        setLikedPosts(new Set(data.posts))
        setLikedReplies(new Set(Object.keys(data.replies)))
      })
      .catch(async () => {
        try {
          const cached = await getCachedLikes(feedId)
          if (!active) return
          if (cached) {
            setLikedPosts(new Set(cached.posts))
            setLikedReplies(new Set(Object.keys(cached.replies)))
          }
        } catch { /* ignore */ }
      })
    return () => { active = false }
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
