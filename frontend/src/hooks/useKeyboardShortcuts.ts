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
  // ListenView.tsx), so the NAV letters below (h/e/m/b/n) must stay out
  // of the way or "m" fires both toggleMute() AND onNavigate('messages'),
  // unmounting the page the user is trying to control (FE-3). Escape and
  // the non-nav shortcuts ('.' generate, '?' help) don't collide with any
  // Listen-owned key and keep working there.
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

      // Navigation (single key, no modifiers)
      if (e.ctrlKey || e.metaKey || e.altKey) return

      // The Listen view owns single-letter keys for its own transport
      // controls (space/arrows/M — see ListenView.tsx / FE-3), so ONLY
      // the nav letters are suppressed there; '.' (generate) and '?'
      // don't collide with any Listen-owned key and keep working.
      const suppressNav = activeView === 'listen'

      switch (e.key) {
        // Navigation — Twitter/X style
        case 'g':
          // Wait for second key
          break
        case 'h':
          // g then h = home (simplified: just h)
          if (suppressNav) break
          onNavigate('feed')
          break
        case 'e':
          if (suppressNav) break
          onNavigate('search') // explore
          break
        case 'm':
          if (suppressNav) break
          onNavigate('messages')
          break
        case 'b':
          if (suppressNav) break
          onNavigate('bookmarks')
          break
        case 'n':
          if (suppressNav) break
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
