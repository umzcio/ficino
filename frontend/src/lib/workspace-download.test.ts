// clearOfflineData() must also drop the service worker's user-private
// runtime cache (figure images are served CacheFirst, so a cached copy skips
// the server's owner and token checks). Public caches (the precache, the
// persona avatars and the font caches) are left alone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cleared: string[] = []
const fakeDb = {
  transaction: (name: string) => ({
    store: { clear: async () => { cleared.push(name) } },
    done: Promise.resolve(),
  }),
}
const getDB = vi.fn(async () => fakeDb)
vi.mock('./offline-db', () => ({ getDB: () => getDB() }))

import { clearOfflineData } from './workspace-download'

describe('clearOfflineData', () => {
  beforeEach(() => {
    cleared.length = 0
    getDB.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes the figure-images cache and keeps public caches', async () => {
    const del = vi.fn(async () => true)
    vi.stubGlobal('caches', { delete: del })
    await clearOfflineData()
    const names = del.mock.calls.map(c => (c as unknown[])[0])
    expect(names).toContain('figure-images')
    for (const kept of ['persona-avatars', 'google-fonts-stylesheets', 'google-fonts-webfonts']) {
      expect(names).not.toContain(kept)
    }
    expect(names.some(n => String(n).startsWith('workbox-precache'))).toBe(false)
    expect(cleared).toContain('bookmarks')
    expect(cleared).toContain('feeds')
  })

  it('still clears IndexedDB when Cache Storage is missing or throws', async () => {
    vi.stubGlobal('caches', { delete: vi.fn(async () => { throw new Error('denied') }) })
    await clearOfflineData()
    expect(cleared).toContain('bookmarks')

    cleared.length = 0
    vi.stubGlobal('caches', undefined)
    await clearOfflineData()
    expect(cleared).toContain('bookmarks')
  })

  it('still deletes the figure cache when IndexedDB fails', async () => {
    const del = vi.fn(async () => true)
    vi.stubGlobal('caches', { delete: del })
    getDB.mockRejectedValueOnce(new Error('no indexedDB'))
    await expect(clearOfflineData()).rejects.toThrow('no indexedDB')
    expect(del).toHaveBeenCalledWith('figure-images')
  })
})
