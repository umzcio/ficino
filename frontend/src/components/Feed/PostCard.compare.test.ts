// R10 FE-1: the memo comparator omitted isReplyLiked/isReplyBookmarked.
// Those are data-keyed render inputs (useCallback keyed on likedReplies /
// bookmark state) — when a reply is liked, their identity changes but the
// comparator said "equal", so the heart never repainted.
import { describe, it, expect } from 'vitest'
import { arePostsEqual } from './PostCard'

function baseProps() {
  const post = { id: 1, persona: 'skeptic', post_type: 'post', content: 'x' }
  return {
    post,
    feedId: 'feed-1',
    postIndex: 0,
    liked: false,
    bookmarkedId: null,
    hasUserReply: false,
    annotation: null,
    autoOpenReply: false,
    isReplyLiked: () => false,
    isReplyBookmarked: () => false,
  } as any
}

describe('arePostsEqual', () => {
  it('re-renders when isReplyLiked identity changes (reply was liked)', () => {
    const prev = baseProps()
    const next = { ...prev, isReplyLiked: () => true }
    expect(arePostsEqual(prev, next)).toBe(false)
  })

  it('re-renders when isReplyBookmarked identity changes', () => {
    const prev = baseProps()
    const next = { ...prev, isReplyBookmarked: () => true }
    expect(arePostsEqual(prev, next)).toBe(false)
  })

  it('still skips re-render when nothing changed', () => {
    const prev = baseProps()
    expect(arePostsEqual(prev, { ...prev })).toBe(true)
  })
})
