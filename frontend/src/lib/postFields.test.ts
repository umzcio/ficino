// A stored feed post can predate the server's type check on model fields (or come from the offline cache), so the
// card normalises the fields it renders as text before use.
import { describe, it, expect } from 'vitest'
import { asText, safeFeedPost } from './postFields'
import type { FeedPost } from '../types'

const post = (over: Record<string, unknown>): FeedPost => ({
  id: 1, persona: 'skeptic', post_type: 'post', content: 'x', paper_ref: null, time: '2m',
  likes: 0, retweets: 0, replies: 0, bookmarks: 0, ...over,
} as FeedPost)

describe('asText', () => {
  it('keeps strings, stringifies numbers and booleans, blanks everything else', () => {
    expect(asText('a')).toBe('a')
    expect(asText(5)).toBe('5')
    expect(asText(true)).toBe('true')
    expect(asText(Number.NaN)).toBe('')
    for (const v of [null, undefined, { x: 1 }, ['a'], () => 1]) expect(asText(v)).toBe('')
  })
})

describe('safeFeedPost', () => {
  it('returns a well-typed post unchanged (same object)', () => {
    const p = post({ post_type: 'thread', thread_posts: ['a', 'b'], thread_count: 2, quoting_handle: '@a' })
    expect(safeFeedPost(p)).toBe(p)
  })

  const TEXT = ['content', 'paper_ref', 'quoting_handle', 'quoting_content', 'replying_to', 'post_type'] as const
  for (const field of TEXT) {
    it.each([
      ['an object', { x: 1 }, ''],
      ['an array', ['a'], ''],
      ['a number', 5, '5'],
    ])(`${field} as %s becomes text`, (_l, value, expected) => {
      const out = safeFeedPost(post({ [field]: value })) as unknown as Record<string, unknown>
      expect(out[field]).toBe(expected)
    })
    it(`${field} null stays null`, () => {
      const out = safeFeedPost(post({ [field]: null })) as unknown as Record<string, unknown>
      expect(out[field]).toBeNull()
    })
  }

  it('thread_posts keeps only text parts; a non-array is dropped', () => {
    expect(safeFeedPost(post({ thread_posts: ['a', { x: 1 }, 5, null] })).thread_posts).toEqual(['a', '5'])
    for (const v of [{ x: 1 }, 'a', 5, null]) expect(safeFeedPost(post({ thread_posts: v })).thread_posts).toBeUndefined()
  })

  it('thread_count must be a finite number', () => {
    for (const v of [{}, ['2'], '2', null, Number.NaN]) expect(safeFeedPost(post({ thread_count: v })).thread_count).toBeUndefined()
    expect(safeFeedPost(post({ thread_count: 3 })).thread_count).toBe(3)
  })
})
