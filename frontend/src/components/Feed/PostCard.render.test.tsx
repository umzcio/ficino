// Render tests for PostCard's five post-type branches (the characterization
// layer for the repo's highest-churn component). Fixture shapes mirror
// PostCard.compare.test.ts. PostCard pulls personas from context
// (usePersonas) and network/storage modules at the boundary — both are
// mocked/provided here rather than hitting fetch or IndexedDB.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { vi } from 'vitest'
import { PostCard, type PostCardProps } from './PostCard'
import { PersonasProvider } from '../../hooks/usePersonas'
import type { PersonaMap } from '../../hooks/usePersonas'
import type { FeedPost } from '../../types'

vi.mock('../../lib/api', () => ({
  sendReply: vi.fn(),
  sendZap: vi.fn(),
  getPostReplies: vi.fn(),
  getCitation: vi.fn(),
  regeneratePost: vi.fn(),
  deletePost: vi.fn(),
  updateSettings: vi.fn(),
  deleteReplyMessage: vi.fn(),
}))
vi.mock('../../lib/offline-cache', () => ({
  cachePersonas: vi.fn(),
  getCachedPersonas: vi.fn(),
}))

afterEach(cleanup)

const PERSONAS: PersonaMap = {
  skeptic: {
    key: 'skeptic',
    handle: '@skeptic',
    name: 'The Skeptic',
    initials: 'SK',
    color: '#ff0000',
  },
  gradstudent: {
    key: 'gradstudent',
    handle: '@gradstudent',
    name: 'Grad Student',
    initials: 'GS',
    color: '#00ff00',
  },
}

function basePost(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id: 1,
    persona: 'skeptic',
    post_type: 'post',
    content: 'x',
    paper_ref: null,
    time: '2024-01-01T00:00:00Z',
    likes: 0,
    retweets: 0,
    replies: 0,
    bookmarks: 0,
    ...overrides,
  }
}

function renderCard(post: FeedPost, props: Partial<PostCardProps> = {}) {
  return render(
    <PersonasProvider value={PERSONAS}>
      <PostCard post={post} feedId="feed-1" postIndex={0} {...props} />
    </PersonasProvider>,
  )
}

describe('PostCard render', () => {
  it('standalone post renders persona name/handle and content', () => {
    renderCard(basePost({ content: 'a standalone observation' }))
    expect(screen.getByText('The Skeptic')).toBeTruthy()
    expect(screen.getByText('@skeptic')).toBeTruthy()
    expect(screen.getByText('a standalone observation')).toBeTruthy()
  })

  it('thread post renders the thread expand affordance', () => {
    renderCard(basePost({
      post_type: 'thread',
      thread_count: 2,
      thread_posts: ['thread opener text', 'second post text'],
    }))
    expect(screen.getByText('thread opener text')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show thread (2 posts)' })).toBeTruthy()
    // Collapsed by default: later posts are not rendered.
    expect(screen.queryByText('second post text')).toBeNull()
  })

  it('quote post renders the nested quoted card', () => {
    renderCard(basePost({
      post_type: 'quote',
      content: 'worth quoting',
      quoting_handle: '@gradstudent',
      quoting_content: 'the original claim',
    }))
    expect(screen.getByText('worth quoting')).toBeTruthy()
    expect(screen.getByText('Grad Student')).toBeTruthy()
    expect(screen.getByText('@gradstudent')).toBeTruthy()
    expect(screen.getByText('the original claim')).toBeTruthy()
  })

  it('reply post renders the replying-to context', () => {
    renderCard(basePost({
      post_type: 'reply',
      replying_to: '@gradstudent',
      content: 'a reply',
    }))
    expect(screen.getByText('Replying to')).toBeTruthy()
    expect(screen.getByText('@gradstudent')).toBeTruthy()
  })

  it('figure post renders the figure image and caption', () => {
    renderCard(basePost({
      post_type: 'figure',
      content: 'see the figure',
      figure_url: '/figures/fig1.png?token=t',
      figure_caption: 'Figure 1: accuracy over epochs',
    }))
    const img = screen.getByRole('img', { name: 'Figure 1: accuracy over epochs' }) as HTMLImageElement
    expect(img.src).toContain('/ficino/api/figures/fig1.png')
    expect(screen.getByText('EXTRACTED FIGURE')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zoom figure: Figure 1: accuracy over epochs' })).toBeTruthy()
  })

  // A post stored before the server type-checked model fields (or read from the offline cache) can carry any JSON
  // type; one bad post must not unmount the app.
  describe('mistyped stored fields', () => {
    const bad = (over: Record<string, unknown>) => basePost(over as Partial<FeedPost>)
    const VALUES: [string, unknown][] = [['an object', { x: 1 }], ['an array', ['a', { x: 1 }]], ['a number', 5], ['null', null]]
    for (const field of ['content', 'paper_ref', 'replying_to', 'quoting_handle', 'quoting_content', 'thread_count', 'thread_posts', 'post_type']) {
      it.each(VALUES)(`renders with ${field} as %s`, (_l, value) => {
        const types = field === 'post_type' ? ['post'] : ['post', 'thread', 'quote', 'reply']
        for (const post_type of types) {
          const extra = post_type === 'thread' && field !== 'thread_posts' ? { thread_posts: ['opener'] } : {}
          const { container, unmount } = renderCard(bad({ post_type, ...extra, [field]: value }))
          expect(container.querySelector('article')).toBeTruthy()
          unmount()
        }
      })
    }

    it('renders a numeric content as text', () => {
      renderCard(bad({ content: 42 }))
      expect(screen.getByText('42')).toBeTruthy()
    })
  })

  it('renders without throwing with only the minimal required fields', () => {
    const { container } = renderCard(basePost())
    expect(container.querySelector('article')).toBeTruthy()
  })
})
