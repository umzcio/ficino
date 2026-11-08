// The offline stores (IndexedDB) and the figure cache carry no user id, so
// they must be wiped whenever the signed-in user changes or the session ends
// without an explicit sign-out (an expired basic-auth cookie). The wipe has
// to finish before the new user is adopted, so no data hook renders the
// previous user's cached records.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const events: string[] = []
const clearOfflineData = vi.fn(async () => { events.push('wipe') })
vi.mock('../lib/workspace-download', () => ({ clearOfflineData: () => clearOfflineData() }))

type Responder = (path: string) => unknown
let respond: Responder = () => undefined
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    request: vi.fn(async (path: string) => respond(path)),
    setAuthTokenGetter: vi.fn(),
  }
})

import { ApiError } from '../lib/api'
import { AuthProvider, useAuth } from './AuthContext'

const KEY = 'ficino:lastUserId'
const userA = { id: 'user-a', email: 'a@example.test', display_name: null }
const userB = { id: 'user-b', email: 'b@example.test', display_name: null }

function Probe() {
  const { user, loading } = useAuth()
  if (user) events.push(`render:${user.id}`)
  return <div>{loading ? 'loading' : `user:${user?.id ?? 'none'}`}</div>
}

function basicWith(me: () => unknown): Responder {
  return (path) => {
    if (path === '/auth/provider') return { provider: 'basic' }
    if (path === '/auth/me') return me()
    throw new Error(`unexpected ${path}`)
  }
}

async function mount() {
  render(<AuthProvider><Probe /></AuthProvider>)
  await waitFor(() => expect(screen.queryByText('loading')).toBeNull())
}

describe('AuthProvider offline-data ownership', () => {
  beforeEach(() => {
    events.length = 0
    clearOfflineData.mockClear()
    localStorage.clear()
  })
  afterEach(() => cleanup())

  it('wipes before adopting a different user than the last one', async () => {
    localStorage.setItem(KEY, userA.id)
    respond = basicWith(() => userB)
    await mount()
    expect(screen.getByText('user:user-b')).toBeTruthy()
    expect(clearOfflineData).toHaveBeenCalledTimes(1)
    expect(events.indexOf('wipe')).toBeLessThan(events.indexOf('render:user-b'))
    expect(localStorage.getItem(KEY)).toBe(userB.id)
  })

  it('keeps the data when the same user comes back', async () => {
    localStorage.setItem(KEY, userA.id)
    respond = basicWith(() => userA)
    await mount()
    expect(screen.getByText('user:user-a')).toBeTruthy()
    expect(clearOfflineData).not.toHaveBeenCalled()
  })

  it('does not wipe on a first load with no stored user', async () => {
    respond = basicWith(() => userA)
    await mount()
    expect(clearOfflineData).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBe(userA.id)
  })

  it('wipes when the session has ended (401 from /auth/me)', async () => {
    localStorage.setItem(KEY, userA.id)
    respond = basicWith(() => { throw new ApiError(401, 'Not authenticated') })
    await mount()
    expect(screen.getByText('user:none')).toBeTruthy()
    expect(clearOfflineData).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('does not wipe on a server error from /auth/me', async () => {
    localStorage.setItem(KEY, userA.id)
    respond = basicWith(() => { throw new ApiError(503, 'Unavailable') })
    await mount()
    expect(clearOfflineData).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBe(userA.id)
  })

  it('still adopts the user when localStorage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      respond = basicWith(() => userB)
      await mount()
      expect(screen.getByText('user:user-b')).toBeTruthy()
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })
})
