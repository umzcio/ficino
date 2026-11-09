// One post or one view that throws while rendering must not unmount the app. Before error boundaries existed, a
// render error anywhere (a mistyped post field read from an old feed or the offline cache, a malformed model field
// in a view) left a blank page, with the nav and the delete/regenerate controls needed to recover gone with it.
//
// The data hooks are mocked at the module boundary so the test renders the real AppContent layout (nav, main
// view, feed list, post cards) without a server.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { VirtuosoMockContext } from 'react-virtuoso'
import { Suspense } from 'react'
import type { FeedPost } from './types'

const h = vi.hoisted(() => {
  const never = () => new Promise<never>(() => {})
  const post = (id: number, content: string, extra: Record<string, unknown> = {}) => ({
    id,
    persona: 'skeptic',
    post_type: 'post',
    content,
    paper_ref: null,
    time: '2024-01-01T00:00:00Z',
    likes: 0,
    retweets: 0,
    replies: 0,
    bookmarks: 0,
    ...extra,
  })
  return {
    never,
    posts: [
      post(1, 'first readable post'),
      // An object where a string belongs (rendered as a React child): what a post stored before the server type
      // check, or read back from the offline cache, can look like.
      post(2, 'second post', { replying_to: { x: 1 } }),
      post(3, 'third readable post'),
    ],
    messagesShouldThrow: { value: true },
  }
})

vi.mock('./lib/pwa', () => ({}))
// jsdom has no matchMedia; the install prompts are not what this test is about.
vi.mock('./components/Nav/InstallPrompt', () => ({ InstallButton: () => null, MobileInstallBanner: () => null }))
vi.mock('./lib/api', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(
    Object.entries(real).map(([k, v]) => [k, typeof v === 'function' && k !== 'ApiError' ? vi.fn(h.never) : v]),
  )
})
vi.mock('./lib/offline-cache', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(h.never) : v]))
})
// Bypass the client-side normalisation so the bad post reaches PostCard/Md as stored, the way it did before
// safeFeedPost existed; the boundary must contain whatever slips past it.
vi.mock('./lib/postFields', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/postFields')>()
  return { ...real, safeFeedPost: (p: FeedPost) => p }
})
vi.mock('./auth/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ user: null, loading: false, provider: 'none', passwordRecovery: false }),
}))
vi.mock('./hooks/useFeed', () => ({
  useFeed: () => ({
    posts: h.posts,
    feedId: 'feed-1',
    feedState: 'complete',
    generatingMeta: {},
    error: null,
    generate: vi.fn(),
    loadFeed: vi.fn(),
  }),
}))
vi.mock('./hooks/useCorpus', () => ({
  useCorpus: () => ({
    papers: [], loading: false, uploading: false, error: null, upload: vi.fn(), remove: vi.fn(), refresh: vi.fn(),
  }),
}))
vi.mock('./hooks/useBookmarks', () => ({
  useBookmarks: () => ({
    bookmarks: [], loading: false, toggle: vi.fn(), remove: vi.fn(),
    isBookmarked: () => null, isReplyBookmarked: () => false, refresh: vi.fn(),
  }),
}))
vi.mock('./hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: [], active: null, activeId: 'ws-1', loading: false, showWorkspaceUI: false,
    switchTo: vi.fn(), create: vi.fn(), remove: vi.fn(), rename: vi.fn(), refresh: vi.fn(),
  }),
}))
vi.mock('./hooks/useSettings', () => ({
  useSettings: () => ({ settings: {}, loading: false, update: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('./hooks/useAlerts', () => ({
  useAlerts: () => ({
    alerts: [], unreadCount: 0, loading: false,
    markRead: vi.fn(), markAllRead: vi.fn(), dismiss: vi.fn(), refresh: vi.fn(),
  }),
}))
vi.mock('./hooks/useUserPosts', () => ({
  useUserPosts: () => ({ posts: [], loading: false, refresh: vi.fn() }),
}))
vi.mock('./hooks/useAnnotations', () => ({
  useAnnotations: () => ({ annotations: [], loading: false, getNote: () => null, save: vi.fn(), remove: vi.fn() }),
}))
vi.mock('./hooks/useLikes', () => ({
  useLikes: () => ({ isLiked: () => false, isReplyLiked: () => false, toggle: vi.fn(), toggleReply: vi.fn() }),
}))
vi.mock('./hooks/usePersonas', async (importOriginal) => {
  const real = await importOriginal<typeof import('./hooks/usePersonas')>()
  const personas = { skeptic: { key: 'skeptic', handle: '@skeptic', name: 'The Skeptic', initials: 'SK', color: '#f00' } }
  return { ...real, usePersonasLoader: () => personas, usePersonas: () => personas }
})
vi.mock('./components/Messages/MessagesView', () => ({
  MessagesView: () => {
    if (h.messagesShouldThrow.value) throw new Error('view render failed')
    return <p>messages view</p>
  },
}))

import App from './App'
import { deletePost } from './lib/api'

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  h.messagesShouldThrow.value = true
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  errorSpy.mockRestore()
})

function renderApp() {
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 4000, itemHeight: 200 }}>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </VirtuosoMockContext.Provider>,
  )
}

const mainNav = () => screen.getByRole('navigation', { name: 'Main navigation' })

describe('App error boundaries', () => {
  it('a post that throws while rendering shows a placeholder; the nav and the other posts stay', async () => {
    renderApp()
    expect(await screen.findByText('first readable post')).toBeTruthy()
    expect(screen.getByText('third readable post')).toBeTruthy()
    const feed = screen.getByRole('feed')
    const alert = within(feed).getByRole('alert')
    expect(alert.textContent).toMatch(/post couldn.t be displayed/i)
    expect(within(mainNav()).getByRole('button', { name: 'Home' })).toBeTruthy()
    // The feed's own controls are still there for the other posts.
    expect(screen.getByRole('button', { name: /generate more posts/i })).toBeTruthy()
  })

  it('the placeholder of a failing post can delete that post', async () => {
    vi.mocked(deletePost).mockClear()
    vi.mocked(deletePost).mockResolvedValueOnce(undefined)
    renderApp()
    await screen.findByText('first readable post')
    const alert = within(screen.getByRole('feed')).getByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: 'Delete post' }))
    expect(deletePost).not.toHaveBeenCalled()
    fireEvent.click(within(alert).getByRole('button', { name: /confirm/i }))
    expect(deletePost).toHaveBeenCalledWith('feed-1', 1)
    await waitFor(() => expect(within(screen.getByRole('feed')).queryByRole('alert')).toBeNull())
    expect(screen.getByText('first readable post')).toBeTruthy()
    expect(screen.getByText('third readable post')).toBeTruthy()
  })

  it('a view that throws leaves the nav working, and navigating away recovers', async () => {
    renderApp()
    await screen.findByText('first readable post')
    fireEvent.click(within(mainNav()).getByRole('button', { name: 'Messages' }))
    const main = screen.getByRole('main')
    expect((await within(main).findByRole('alert')).textContent).toMatch(/couldn.t be displayed/i)
    expect(within(mainNav()).getByRole('button', { name: 'Messages' })).toBeTruthy()

    fireEvent.click(within(mainNav()).getByRole('button', { name: 'Home' }))
    expect(await screen.findByText('first readable post')).toBeTruthy()
    expect(within(main).queryByText(/view couldn.t be displayed/i)).toBeNull()
  })

  it('"Try again" re-renders a view once it stops throwing', async () => {
    renderApp()
    await screen.findByText('first readable post')
    fireEvent.click(within(mainNav()).getByRole('button', { name: 'Messages' }))
    const main = screen.getByRole('main')
    await within(main).findByRole('alert')
    h.messagesShouldThrow.value = false
    fireEvent.click(within(main).getByRole('button', { name: /try again/i }))
    expect(await within(main).findByText('messages view')).toBeTruthy()
  })
})
