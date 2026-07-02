import { useEffect } from 'react'

type AppView = 'feed' | 'listen' | 'messages' | 'search' | 'alerts' | 'bookmarks' | 'reading-lists' | 'profile' | 'settings'

interface KeyboardShortcutsProps {
  onNavigate: (view: AppView) => void
  onGenerate: () => void
  onCloseMobileDrawer: () => void
  onCloseWorkspaceSheet: () => void
  generating: boolean
  // The view currently on screen. While it's 'listen', the Listen page
  // owns single-letter keys itself (e.g. "m" for mute — see
  // ListenView.tsx), so the global nav shortcuts below must stay out of
  // the way or "m" fires both toggleMute() AND onNavigate('messages'),
  // unmounting the page the user is trying to control (FE-3). Escape
  // still closes overlays regardless of view.
  activeView: AppView
}

export function useKeyboardShortcuts({
  onNavigate,
  onGenerate,
  onCloseMobileDrawer,
  onCloseWorkspaceSheet,
  generating,
  activeView,
}: KeyboardShortcutsProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger shortcuts when typing in inputs
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.target as HTMLElement).isContentEditable) return

      // Esc — close any overlay
      if (e.key === 'Escape') {
        onCloseMobileDrawer()
        onCloseWorkspaceSheet()
        return
      }

      // The Listen view owns single-letter keys for its own transport
      // controls (space/arrows/M) — see FE-3. Bail before the nav
      // switch so those keys never double-fire a navigation here.
      if (activeView === 'listen') return

      // Navigation (single key, no modifiers)
      if (e.ctrlKey || e.metaKey || e.altKey) return

      switch (e.key) {
        // Navigation — Twitter/X style
        case 'g':
          // Wait for second key
          break
        case 'h':
          // g then h = home (simplified: just h)
          onNavigate('feed')
          break
        case 'e':
          onNavigate('search') // explore
          break
        case 'm':
          onNavigate('messages')
          break
        case 'b':
          onNavigate('bookmarks')
          break
        case 'n':
          onNavigate('alerts') // notifications
          break

        // Actions
        case '.':
          // Period = generate (like Twitter's "." to load new tweets)
          if (!generating) onGenerate()
          break

        // Question mark = show shortcuts help
        case '?':
          // Could show a help modal later
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onNavigate, onGenerate, onCloseMobileDrawer, onCloseWorkspaceSheet, generating, activeView])
}
