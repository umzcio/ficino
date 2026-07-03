// R10 wave-4 FE-20: WCAG 2.1.4 requires a mechanism to turn off single-
// character shortcuts. The preference is client-only (safeLocal), fails
// open (enabled) on any missing/corrupt value, and only an explicit
// "false" disables. Suite runs with vitest `environment: 'node'` (see
// vitest.config.ts) so localStorage isn't ambient — stub it like
// safeLocal.test.ts does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  areKeyboardShortcutsEnabled,
  setKeyboardShortcutsEnabled,
  KEYBOARD_SHORTCUTS_KEY,
} from './keyboardShortcutsPref'

describe('keyboardShortcutsPref', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to enabled when no value has been set', () => {
    expect(areKeyboardShortcutsEnabled()).toBe(true)
  })

  it('setKeyboardShortcutsEnabled(false) then read reports disabled', () => {
    setKeyboardShortcutsEnabled(false)
    expect(areKeyboardShortcutsEnabled()).toBe(false)
  })

  it('setKeyboardShortcutsEnabled(true) then read reports enabled', () => {
    setKeyboardShortcutsEnabled(false)
    setKeyboardShortcutsEnabled(true)
    expect(areKeyboardShortcutsEnabled()).toBe(true)
  })

  it('fails open (enabled) on a corrupt stored value', () => {
    store.set(KEYBOARD_SHORTCUTS_KEY, 'garbage')
    expect(areKeyboardShortcutsEnabled()).toBe(true)
  })
})
