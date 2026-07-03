// R10 wave-4 FE-8: shared-origin storage guard. The umzcaio deployment puts
// every subpath app on one origin sharing one ~5MB localStorage bucket — a
// full bucket makes even a tiny setItem in an unrelated app throw
// QuotaExceededError. safeLocal must swallow get/set/remove failures instead
// of letting them propagate into click handlers / state initializers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { safeLocal } from './safeLocal'

function stubLocalStorage(impl: Partial<Storage>) {
  vi.stubGlobal('localStorage', impl)
}

describe('safeLocal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('happy path (real-ish localStorage)', () => {
    beforeEach(() => {
      const store = new Map<string, string>()
      stubLocalStorage({
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v) },
        removeItem: (k: string) => { store.delete(k) },
      })
    })

    it('get returns null for a missing key', () => {
      expect(safeLocal.get('missing')).toBeNull()
    })

    it('set then get round-trips the value', () => {
      expect(safeLocal.set('k', 'v')).toBe(true)
      expect(safeLocal.get('k')).toBe('v')
    })

    it('remove clears a previously set key', () => {
      safeLocal.set('k', 'v')
      safeLocal.remove('k')
      expect(safeLocal.get('k')).toBeNull()
    })
  })

  describe('quota-exceeded / private-browsing failures', () => {
    beforeEach(() => {
      stubLocalStorage({
        getItem: () => { throw new DOMException('blocked', 'SecurityError') },
        setItem: () => { throw new DOMException('exceeded', 'QuotaExceededError') },
        removeItem: () => { throw new DOMException('blocked', 'SecurityError') },
      })
    })

    it('get swallows the throw and returns null', () => {
      expect(() => safeLocal.get('k')).not.toThrow()
      expect(safeLocal.get('k')).toBeNull()
    })

    it('set swallows the throw and returns false', () => {
      expect(() => safeLocal.set('k', 'v')).not.toThrow()
      expect(safeLocal.set('k', 'v')).toBe(false)
    })

    it('remove swallows the throw', () => {
      expect(() => safeLocal.remove('k')).not.toThrow()
    })
  })
})
