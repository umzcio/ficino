import { safeLocal } from './safeLocal'

// R10 FE-20 (WCAG 2.1.4 Character Key Shortcuts): the single-character nav
// shortcuts (h/e/m/b/n/.) need a way to be turned off. This is a client-only
// accessibility preference — no server round trip, no settings_schema.py
// entry — so it lives in safeLocal rather than the server settings object.
export const KEYBOARD_SHORTCUTS_KEY = 'ficino.keyboardShortcuts'

// Default enabled: only an explicit "false" turns the shortcuts off. Any
// other value (missing key, corrupt value, quota-evicted) fails open to the
// pre-existing behavior rather than silently disabling navigation.
export function areKeyboardShortcutsEnabled(): boolean {
  return safeLocal.get(KEYBOARD_SHORTCUTS_KEY) !== 'false'
}

export function setKeyboardShortcutsEnabled(enabled: boolean): void {
  safeLocal.set(KEYBOARD_SHORTCUTS_KEY, enabled ? 'true' : 'false')
}
