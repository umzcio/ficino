// PostDetail looks up the quoted and parent posts among the feed's other posts and renders them; a mistyped stored
// field in any of them must not throw.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { PostDetail } from './PostDetail'
import { PersonasProvider, type PersonaMap } from '../../hooks/usePersonas'
import type { FeedPost } from '../../types'

vi.mock('../../lib/api', () => ({
  sendReply: vi.fn(), sendZap: vi.fn(), getPostReplies: vi.fn(), getCitation: vi.fn(), regeneratePost: vi.fn(),
  deletePost: vi.fn(), updateSettings: vi.fn(), deleteReplyMessage: vi.fn(),
  listLikesForFeed: vi.fn(() => new Promise(() => {})), createLike: vi.fn(), deleteLike: vi.fn(),
}))
vi.mock('../../lib/offline-cache', () => ({
  cachePersonas: vi.fn(), getCachedPersonas: vi.fn(), cacheLikes: vi.fn(), getCachedLikes: vi.fn(() => Promise.resolve(null)),
}))

afterEach(cleanup)

const PERSONAS: PersonaMap = {
  skeptic: { key: 'skeptic', handle: '@skeptic', name: 'The Skeptic', initials: 'SK', color: '#ff0000' },
  gradstudent: { key: 'gradstudent', handle: '@gradstudent', name: 'Grad Student', initials: 'GS', color: '#00ff00' },
}
const post = (over: Record<string, unknown>): FeedPost => ({
  id: 1, persona: 'gradstudent', post_type: 'post', content: 'x', paper_ref: null, time: '2m',
  likes: 0, retweets: 0, replies: 0, bookmarks: 0, ...over,
} as FeedPost)

describe('PostDetail with mistyped stored fields', () => {
  it.each([['an object', { x: 1 }], ['an array', ['a']], ['a number', 5]])(
    'renders a quote whose quoted post and quoting_content are %s', (_l, value) => {
      const posts = [
        post({ content: value }),
        post({ persona: 'skeptic', post_type: 'quote', content: 'hi', quoting_handle: '@gradstudent', quoting_content: value }),
      ]
      const { container } = render(
        <PersonasProvider value={PERSONAS}>
          <PostDetail post={posts[1]} postIndex={1} posts={posts} feedId="feed-1" onBack={() => {}} onNavigateToPost={() => {}}
            isBookmarked={() => null} onBookmarkToggle={() => {}} />
        </PersonasProvider>,
      )
      expect(container.querySelector('article')).toBeTruthy()
    })
})
