import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react'
import {
  Home, Search, Bell, Mail, Bookmark, Settings,
  Zap, Loader2, BookOpen, User, Headphones
} from 'lucide-react'
import type { FeedPost } from './types'
import { useCorpus } from './hooks/useCorpus'
import { useFeed } from './hooks/useFeed'
import { useBookmarks } from './hooks/useBookmarks'
import { useWorkspaces } from './hooks/useWorkspaces'
import { PaperUpload } from './components/Upload/PaperUpload'
import { CorpusPanel } from './components/Sidebar/CorpusPanel'
import { PersonaPanel } from './components/Sidebar/PersonaPanel'
import { FeedContent } from './components/Feed/Feed'
const ListenView = lazy(() =>
  import('./components/Listen/ListenView').then((m) => ({ default: m.ListenView })),
)
import { SwipeableTabs } from './components/_shared/SwipeableTabs'
import { PullToRefresh } from './components/_shared/PullToRefresh'
import { FeedHistory } from './components/Feed/FeedHistory'
// Route-level views are code-split via lazy() so Rollup does NOT emit
// <link rel="modulepreload"> for them on first paint. Each view loads on
// demand when the user navigates to it.
const MessagesView = lazy(() =>
  import('./components/Messages/MessagesView').then((m) => ({ default: m.MessagesView })),
)
const BookmarksView = lazy(() =>
  import('./components/Bookmarks/BookmarksView').then((m) => ({ default: m.BookmarksView })),
)
const ExploreView = lazy(() =>
  import('./components/Explore/ExploreView').then((m) => ({ default: m.ExploreView })),
)
const SettingsView = lazy(() =>
  import('./components/Settings/SettingsView').then((m) => ({ default: m.SettingsView })),
)
const AlertsView = lazy(() =>
  import('./components/Alerts/AlertsView').then((m) => ({ default: m.AlertsView })),
)
const ReadingListsView = lazy(() =>
  import('./components/ReadingLists/ReadingListsView').then((m) => ({ default: m.ReadingListsView })),
)
const PersonaProfile = lazy(() =>
  import('./components/Personas/PersonaProfile').then((m) => ({ default: m.PersonaProfile })),
)
import { useSettings } from './hooks/useSettings'
import { useAlerts } from './hooks/useAlerts'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { WorkspaceDropdown } from './components/Nav/WorkspaceDropdown'
import { WorkspaceBottomSheet } from './components/Nav/WorkspaceBottomSheet'
import { MobileDrawer } from './components/Nav/MobileDrawer'
import { PostDetail } from './components/Feed/PostDetail'
import { ComposeBox } from './components/Feed/ComposeBox'
import { UserProfile } from './components/Personas/UserProfile'
import { usePersonasLoader, PersonasProvider } from './hooks/usePersonas'
import { useUserPosts } from './hooks/useUserPosts'
import { getFeed, getPaperTldrs } from './lib/api'
import { useAnnotations } from './hooks/useAnnotations'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { LoginPage } from './auth/LoginPage'
import { InstallButton, MobileInstallBanner } from './components/Nav/InstallPrompt'
import { OnlineProvider, useIsOnline } from './lib/online-context'
import { OfflineBanner } from './components/Nav/OfflineBanner'
import { DownloadProgress } from './components/Nav/DownloadProgress'
import { downloadWorkspace, type DownloadProgress as DlProgress } from './lib/workspace-download'

type AppView = 'feed' | 'listen' | 'messages' | 'search' | 'alerts' | 'bookmarks' | 'reading-lists' | 'profile' | 'settings'

// Module-level (not component state) — it's a fixed tab→focus-tag map that
// never changes across renders, so it doesn't belong in any hook's deps
// array. Previously declared mid-component *after* the useCallback that
// referenced it, which the TDZ made a live bug: on first render the
// callback closed over `undefined` until the component body finished
// executing once.
const TAB_FOCUS: Record<number, string | undefined> = { 0: undefined, 1: 'debates', 2: 'methods', 3: 'findings' }

const NAV_ITEMS: { icon: typeof Home; view: AppView; label: string }[] = [
  { icon: Home, view: 'feed', label: 'Home' },
  { icon: Headphones, view: 'listen', label: 'Listen' },
  { icon: Search, view: 'search', label: 'Search' },
  { icon: Bell, view: 'alerts', label: 'Alerts' },
  { icon: Mail, view: 'messages', label: 'Messages' },
  { icon: BookOpen, view: 'reading-lists', label: 'Reading Lists' },
  { icon: Bookmark, view: 'bookmarks', label: 'Saved' },
  { icon: User, view: 'profile', label: 'Profile' },
  { icon: Settings, view: 'settings', label: 'Settings' },
]

function LeftNav({ active, onNavigate, alertCount }: { active: AppView; onNavigate: (v: AppView) => void; alertCount: number }) {
  return (
    <nav aria-label="Main navigation" className="w-16 shrink-0 flex-col items-center pt-5 gap-0.5 border-r border-border hidden md:flex">
      <div className="mb-5">
        {/* alt="" — the brand text "ficino" is already rendered as visible
            text in FeedHeader, so SR users shouldn't hear it twice. */}
        <img
          src={`${import.meta.env.BASE_URL}ficino-favicon-light.png`}
          alt=""
          className="w-9 h-9 rounded-[10px] app-logo"
        />
      </div>
      {NAV_ITEMS.map(({ icon: Icon, view, label }) => {
        // Fold the unread count into the aria-label so SR users aren't told
        // just "Alerts" — they also learn how many are waiting.
        const ariaLabel =
          view === 'alerts' && alertCount > 0
            ? `${label}, ${alertCount} unread`
            : label
        return (
        <button
          key={view}
          onClick={() => onNavigate(view)}
          aria-label={ariaLabel}
          aria-current={active === view ? 'page' : undefined}
          className="w-[46px] h-[46px] rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-100 hover:bg-gold/10 hover:text-gold relative"
          style={{
            color: active === view ? 'var(--color-nav-active)' : 'var(--color-nav-inactive)',
            backgroundColor: active === view ? 'color-mix(in srgb, var(--color-gold) 8%, transparent)' : 'transparent',
          }}
        >
          <Icon size={20} strokeWidth={active === view ? 2.25 : 1.75} />
          {view === 'alerts' && alertCount > 0 && (
            <span aria-hidden="true" className="absolute top-1.5 right-1.5 min-w-[16px] h-4 rounded-full bg-persona-skeptic text-white text-[10px] font-bold flex items-center justify-center px-1">
              {alertCount > 9 ? '9+' : alertCount}
            </span>
          )}
        </button>
      )})}
      <div className="mt-auto mb-4">
        <InstallButton />
      </div>
    </nav>
  )
}

function MobileBottomNav({ active, onNavigate, onLongPressHome }: {
  active: AppView
  onNavigate: (v: AppView) => void
  onLongPressHome: () => void
}) {
  const items: { icon: typeof Home; view: AppView; label: string }[] = [
    { icon: Home, view: 'feed', label: 'Home' },
    { icon: Headphones, view: 'listen', label: 'Listen' },
    { icon: Search, view: 'search', label: 'Explore' },
    { icon: Mail, view: 'messages', label: 'Messages' },
    { icon: Bookmark, view: 'bookmarks', label: 'Saved' },
    { icon: User, view: 'profile', label: 'Profile' },
  ]
  // R10 FE-15: a plain render-scoped local is re-initialized to null on every
  // render, so a re-render between touchstart and touchend (corpus polling,
  // alerts polling, feed generation all flow new props through while a user
  // is mid-press) orphans the timer set by the prior render — touchend reads
  // its own fresh `null` and never clears it, so a quick tap still fires the
  // long-press callback ~500ms later. A ref survives across renders.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  return (
    <nav aria-label="Mobile navigation" className="fixed bottom-0 left-0 right-0 bg-bg/95 backdrop-blur-md border-t border-border flex md:hidden z-50 pb-[env(safe-area-inset-bottom)]">
      {items.map(({ icon: Icon, view, label }) => (
        <button
          key={view}
          onClick={() => onNavigate(view)}
          onTouchStart={view === 'feed' ? () => {
            longPressTimerRef.current = setTimeout(onLongPressHome, 500)
          } : undefined}
          onTouchEnd={view === 'feed' ? () => {
            if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
          } : undefined}
          onTouchCancel={view === 'feed' ? () => {
            if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
          } : undefined}
          aria-label={label}
          aria-current={active === view ? 'page' : undefined}
          className="flex-1 flex flex-col items-center py-3 gap-0.5 bg-transparent border-none transition-colors min-h-[48px]"
          style={{ color: active === view ? 'var(--color-gold)' : 'var(--color-nav-inactive)' }}
        >
          <Icon size={22} strokeWidth={active === view ? 2.25 : 1.75} />
          <span className="text-[10px]">{label}</span>
        </button>
      ))}
    </nav>
  )
}

function FeedHeader({
  paperCount,
  onGenerate,
  generating,
  onMobileLogoTap,
  isOnline,
  workspaceProps,
}: {
  paperCount: number
  onGenerate: () => void
  generating: boolean
  onMobileLogoTap?: () => void
  isOnline?: boolean
  workspaceProps?: {
    workspaces: import('./types').Workspace[]
    active: import('./types').Workspace | null
    showUI: boolean
    onSwitch: (id: string) => void
    onCreate: (name: string) => void
    onDelete: (id: string) => void
    onRename: (id: string, name: string) => void
    onDownload?: (id: string) => void
  }
}) {
  return (
    <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5 pt-[calc(0.875rem+env(safe-area-inset-top))] flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Open menu"
            onClick={onMobileLogoTap}
            className="bg-transparent border-none p-0 cursor-pointer md:hidden"
          >
            <img
              src={`${import.meta.env.BASE_URL}ficino-favicon-light.png`}
              alt=""
              className="w-7 h-7 rounded-lg app-logo"
            />
          </button>
          <span className="text-[22px] font-semibold text-text tracking-[0.015em]" style={{ fontFamily: "'Cormorant Garamond', serif", fontKerning: 'normal' }}>ficino</span>
          <span className="text-[11px] text-gold bg-gold/10 border border-gold/20 rounded px-1.5 py-0.5 font-semibold tracking-wider">
            BETA
          </span>
        </div>
        {workspaceProps?.showUI && workspaceProps.active && (
          <div className="flex items-center gap-1 text-xs text-text-muted mt-0.5">
            <WorkspaceDropdown
              workspaces={workspaceProps.workspaces}
              active={workspaceProps.active}
              onSwitch={workspaceProps.onSwitch}
              onCreate={workspaceProps.onCreate}
              onDelete={workspaceProps.onDelete}
              onRename={workspaceProps.onRename}
              onDownload={workspaceProps.onDownload}
            />
          </div>
        )}
      </div>
      <button
        onClick={onGenerate}
        disabled={generating || paperCount === 0 || isOnline === false}
        className="border-none rounded-[20px] text-bg px-3.5 py-2 cursor-pointer text-sm font-bold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: 'linear-gradient(135deg, var(--color-gold), var(--color-gold-dark))' }}
      >
        {generating ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Zap size={14} />
        )}
        <span className="hidden sm:inline">{generating ? 'Generating...' : 'Generate'}</span>
      </button>
    </div>
  )
}

function FeedTabs({ active, onSelect }: { active: number; onSelect: (i: number) => void }) {
  const tabs = ['For You', 'Debates', 'Methods', 'Findings']
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    let next = active
    if (e.key === 'ArrowRight') next = (active + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (active - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    onSelect(next)
    tabRefs.current[next]?.focus()
  }
  return (
    <div className="flex border-b border-border" role="tablist" aria-label="Feed filters">
      {tabs.map((tab, i) => (
        <button
          key={i}
          ref={(el) => { tabRefs.current[i] = el }}
          role="tab"
          id={`feed-tab-${i}`}
          aria-selected={active === i}
          aria-controls={`feed-panel-${i}`}
          tabIndex={active === i ? 0 : -1}
          onClick={() => onSelect(i)}
          onKeyDown={handleKeyDown}
          className="flex-1 py-3.5 border-none bg-transparent cursor-pointer text-[15px] transition-all duration-150"
          style={{
            color: active === i ? 'var(--color-tab-active)' : 'var(--color-tab-inactive)',
            fontWeight: active === i ? 700 : 400,
            borderBottom: active === i ? '2px solid var(--color-gold)' : '2px solid transparent',
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}

function Sidebar({ corpus, activeTag, onTagFilter, enabledPersonas, onSearchClick, paperSummaries, onPaperClick, onPersonaClick }: {
  corpus: ReturnType<typeof useCorpus>
  activeTag: string | null
  onTagFilter: (tag: string | null) => void
  enabledPersonas: Record<string, boolean>
  onSearchClick: () => void
  paperSummaries?: Map<string, string>
  onPaperClick?: (paperId: string) => void
  onPersonaClick?: (key: string) => void
}) {
  return (
    <aside className="w-[260px] shrink-0 pt-3 pl-5 flex-col gap-3.5 hidden lg:flex">
      <button
        onClick={onSearchClick}
        className="bg-bg-hover border border-border rounded-3xl px-4 py-2.5 flex items-center gap-2.5 cursor-pointer hover:border-gold/30 transition-colors w-full text-left"
      >
        <Search size={16} className="text-text-muted" />
        <span className="text-text-muted text-[15px]">Search corpus...</span>
      </button>

      <PaperUpload onUpload={corpus.upload} uploading={corpus.uploading} error={corpus.error} />

      <CorpusPanel
        papers={corpus.papers}
        loading={corpus.loading}
        onDelete={corpus.remove}
        onRefresh={corpus.refresh}
        activeTag={activeTag}
        onTagFilter={onTagFilter}
        paperSummaries={paperSummaries}
        onPaperClick={onPaperClick}
      />

      <PersonaPanel enabledPersonas={enabledPersonas} onPersonaClick={onPersonaClick} />
    </aside>
  )
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, provider, passwordRecovery } = useAuth()
  // URL-based recovery detection. Supabase's PKCE flow sometimes emits
  // SIGNED_IN instead of PASSWORD_RECOVERY after an email link lands, so
  // we key off the pathname the reset link targets. sendPasswordReset
  // pins the Supabase redirectTo to /auth/reset, so whenever the user
  // is on that path we force the LoginPage — even if Supabase has
  // already "logged them in" via the code exchange.
  const onResetPath = typeof window !== 'undefined' && window.location.pathname === '/auth/reset'
  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Loader2 size={32} className="text-gold animate-spin" />
      </div>
    )
  }
  if (passwordRecovery || onResetPath) return <LoginPage />
  if (!user && provider !== 'none') return <LoginPage />
  return <>{children}</>
}

export default function App() {
  return (
    <OnlineProvider>
      <AuthProvider>
        <AuthGate>
          <AppContent />
        </AuthGate>
      </AuthProvider>
    </OnlineProvider>
  )
}

function AppContent() {
  const [activeView, setActiveViewRaw] = useState<AppView>('feed')
  const [activeTab, setActiveTab] = useState(0)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [showWorkspaceSheet, setShowWorkspaceSheet] = useState(false)
  const [showMobileDrawer, setShowMobileDrawer] = useState(false)
  const [selectedPostIndex, setSelectedPostIndex] = useState<number | null>(null)
  const [autoOpenReply, setAutoOpenReply] = useState(false)
  const [selectedPersona, setSelectedPersona] = useState<string | null>(null)
  const [pendingPaperId, setPendingPaperId] = useState<string | null>(null)
  const setActiveView = (v: AppView) => {
    setSelectedPostIndex(null)
    setSelectedPersona(null)
    setAutoOpenReply(false)
    setActiveViewRaw(v)
  }
  const feedScrollRef = useRef(0)
  const isOnline = useIsOnline()
  const personas = usePersonasLoader()
  const ws = useWorkspaces()
  const corpus = useCorpus(ws.activeId)
  const feed = useFeed(ws.activeId)
  const bm = useBookmarks()
  const notes = useAnnotations()
  const userPosts = useUserPosts(ws.activeId)
  const appSettings = useSettings()
  const alertsHook = useAlerts()

  const [paperTldrs, setPaperTldrs] = useState<Map<string, string>>(new Map())

  // Workspace download state
  const [dlProgress, setDlProgress] = useState<DlProgress | null>(null)
  const [dlWorkspaceName, setDlWorkspaceName] = useState('')
  const dlAbortRef = useRef<AbortController | null>(null)

  const handleDownloadWorkspace = useCallback((workspaceId: string) => {
    const wsName = ws.workspaces.find(w => w.id === workspaceId)?.name ?? 'Workspace'
    setDlWorkspaceName(wsName)
    const abort = new AbortController()
    dlAbortRef.current = abort
    setDlProgress({ step: 'Starting', current: 0, total: 1, done: false })
    downloadWorkspace(workspaceId, setDlProgress, abort.signal)
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('Download failed:', err)
        setDlProgress(null)
      })
  }, [ws.workspaces])

  // Stable callbacks for FeedContent props. Without these every
  // AppContent render (any keystroke in compose input, every
  // paperTldr refresh, every scroll state flicker) produced fresh
  // callback identities, invalidating FeedContent's inner useCallbacks
  // and defeating PostCard's React.memo. Each depends on exactly the
  // *function* it reads off `bm` (bm.toggle / bm.isReplyBookmarked),
  // not the `bm` object itself — `useBookmarks` returns a fresh object
  // literal every render, so depending on `bm` directly (the previous,
  // inaccurate state of this comment implied both) would recompute
  // these callbacks on every AppContent render regardless, defeating
  // the whole point. eslint's exhaustive-deps rule can't see into
  // useBookmarks to confirm that narrowing is safe, so it asks for the
  // whole `bm` object; disabled below with that reasoning.
  const handleBookmarkToggleOuter = useCallback(
    (fid: string, idx: number, post: FeedPost) => bm.toggle(fid, idx, post),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally narrowed to bm.toggle; see comment above.
    [bm.toggle],
  )
  const handleReplyBookmark = useCallback(
    (fid: string, postIdx: number, msgIdx: number, snapshot: unknown) =>
      bm.toggle(fid, postIdx, snapshot as unknown as FeedPost, msgIdx),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally narrowed to bm.toggle; see comment above.
    [bm.toggle],
  )
  const handleIsReplyBookmarked = useCallback(
    (postIdx: number, msgIdx: number) =>
      feed.feedId ? bm.isReplyBookmarked(feed.feedId, postIdx, msgIdx) : false,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally narrowed to bm.isReplyBookmarked; see comment above.
    [feed.feedId, bm.isReplyBookmarked],
  )
  const handlePostClick = useCallback((idx: number) => {
    feedScrollRef.current = document.querySelector('main')?.scrollTop ?? 0
    setSelectedPostIndex(idx)
    document.querySelector('main')?.scrollTo(0, 0)
  }, [])
  // Distinct from the keyboard-shortcut `handleGenerate` below: this
  // one appends to the active feed if one exists (driven from
  // FeedContent's in-view "Generate more" button), whereas the
  // shortcut handler always creates a fresh feed.
  const handleGenerateMore = useCallback(() => {
    feed.generate(ws.activeId, activeTag ? [activeTag] : undefined, feed.feedId || undefined, TAB_FOCUS[activeTab])
  }, [feed, ws.activeId, activeTag, activeTab])
  const handlePullToRefresh = useCallback(async () => {
    if (!feed.feedId) return
    const fresh = await getFeed(feed.feedId)
    feed.loadFeed(fresh as unknown as { id: string; posts: unknown[] })
  }, [feed])

  const handleCancelDownload = useCallback(() => {
    dlAbortRef.current?.abort()
    dlAbortRef.current = null
    setDlProgress(null)
  }, [])

  // Depend on a stable key derived from which papers have completed, not the
  // array identity. `useCorpus.refresh` returns a fresh array on every 2s
  // poll while any upload is processing, which previously caused
  // `getPaperTldrs` to refetch every 2s through the whole ingestion window.
  const completePaperIdsKey = useMemo(
    () =>
      corpus.papers
        .filter((p) => p.status === 'complete')
        .map((p) => p.id)
        .sort()
        .join(','),
    [corpus.papers],
  )
  useEffect(() => {
    getPaperTldrs().then((data) => setPaperTldrs(new Map(Object.entries(data)))).catch(() => {})
  }, [completePaperIdsKey])

  // Apply theme + display settings
  useEffect(() => {
    const theme = appSettings.settings.theme as string || 'dark'
    document.documentElement.setAttribute('data-theme', theme)
    const fontSize = appSettings.settings.font_size as string || 'normal'
    document.documentElement.setAttribute('data-font-size', fontSize)
    const spacing = appSettings.settings.post_spacing as string || 'comfortable'
    document.documentElement.setAttribute('data-spacing', spacing)
  }, [appSettings.settings.theme, appSettings.settings.font_size, appSettings.settings.post_spacing])

  const completePapers = corpus.papers.filter((p) => p.status === 'complete')
  const enabledPersonas = (appSettings.settings.personas_enabled || {}) as Record<string, boolean>

  const filteredPaperCount = activeTag
    ? completePapers.filter((p) => p.tags?.some((t) => t.name === activeTag)).length
    : completePapers.length

  const handleGenerate = () => {
    setSelectedPostIndex(null)
    feed.generate(ws.activeId, activeTag ? [activeTag] : undefined, undefined, TAB_FOCUS[activeTab])
  }

  useKeyboardShortcuts({
    onNavigate: setActiveView,
    onGenerate: handleGenerate,
    onCloseMobileDrawer: () => setShowMobileDrawer(false),
    onCloseWorkspaceSheet: () => setShowWorkspaceSheet(false),
    generating: feed.feedState === 'generating',
    activeView,
  })

  const renderMainContent = () => {
    switch (activeView) {
      case 'listen':
        return (
          <Suspense fallback={<div className="py-10 text-center text-text-muted text-sm">Loading…</div>}>
            <ListenView feedId={feed.feedId} posts={feed.posts} />
          </Suspense>
        )
      case 'messages':
        return (
          <MessagesView
            workspaceId={ws.activeId}
            initialPaperId={pendingPaperId}
            onInitialPaperConsumed={() => setPendingPaperId(null)}
            onOpenThread={async (feedId, postIndex) => {
              try {
                const feedData = await getFeed(feedId)
                feed.loadFeed(feedData)
                setSelectedPostIndex(postIndex)
                setAutoOpenReply(true)
                setSelectedPersona(null)
                setActiveViewRaw('feed')
              } catch {
                // Feed may have been deleted
              }
            }}
          />
        )
      case 'search':
        return (
          <ExploreView
            workspaces={ws.workspaces}
            activeId={ws.activeId}
            onSwitch={ws.switchTo}
            onCreate={(name) => ws.create(name)}
            onDelete={ws.remove}
            onRename={ws.rename}
            papers={corpus.papers.map(p => ({ id: p.id, title: p.title, status: p.status }))}
            paperSummaries={paperTldrs}
            onPaperClick={(paperId) => {
              setPendingPaperId(paperId)
              setActiveView('messages')
            }}
          />
        )
      case 'alerts':
        return (
          <AlertsView
            alerts={alertsHook.alerts}
            loading={alertsHook.loading}
            onMarkRead={alertsHook.markRead}
            onMarkAllRead={alertsHook.markAllRead}
            onDismiss={alertsHook.dismiss}
            onNavigate={(v) => setActiveView(v as AppView)}
          />
        )
      case 'bookmarks':
        return <BookmarksView bookmarks={bm.bookmarks} loading={bm.loading} onRemove={bm.remove} getAnnotation={notes.getNote} onAnnotationSave={notes.save} onAnnotationDelete={notes.remove} />
      case 'reading-lists':
        return <ReadingListsView workspaceId={ws.activeId} />
      case 'settings':
        return (
          <SettingsView
            settings={appSettings.settings}
            loading={appSettings.loading}
            onUpdate={appSettings.update}
            workspaces={ws.workspaces}
            onDownloadWorkspace={handleDownloadWorkspace}
          />
        )
      case 'profile':
        // If the user clicked a persona avatar while viewing their own
        // profile, render that persona's profile — same branch pattern as
        // the `default` case. Without this, setSelectedPersona fires but
        // the view stays on UserProfile and the click looks broken.
        if (selectedPersona) {
          return (
            <PersonaProfile
              key={selectedPersona}
              personaKey={selectedPersona}
              onBack={() => setSelectedPersona(null)}
              posts={feed.posts}
              feedId={feed.feedId}
              onGenerateTake={(personaKey) => feed.generate(ws.activeId, undefined, feed.feedId || undefined, undefined, personaKey, 3)}
              generating={feed.feedState === 'generating'}
              canGenerate={corpus.papers.length > 0 && isOnline}
            />
          )
        }
        return (
          <UserProfile
            workspaceId={ws.activeId}
            displayName={appSettings.settings?.user_display_name as string || 'You'}
            handle={appSettings.settings?.user_handle as string || '@you'}
            onBack={() => setActiveView('feed')}
            onPersonaClick={setSelectedPersona}
          />
        )
      default:
        if (selectedPersona) {
          return (
            // `key={selectedPersona}` forces React to treat every persona
            // switch as a full remount, so *all* local state inside
            // PersonaProfile (reply/dm load flags, drafts, scroll, etc.)
            // resets automatically. Without this, flags like repliesLoaded
            // carry over from the previous persona and silently skip
            // refetches — the correct structural fix instead of
            // remembering to reset each flag in its own effect.
            <PersonaProfile
              key={selectedPersona}
              personaKey={selectedPersona}
              onBack={() => setSelectedPersona(null)}
              posts={feed.posts}
              feedId={feed.feedId}
              onGenerateTake={(personaKey) => feed.generate(ws.activeId, undefined, feed.feedId || undefined, undefined, personaKey, 3)}
              generating={feed.feedState === 'generating'}
              canGenerate={corpus.papers.length > 0 && isOnline}
            />
          )
        }
        if (selectedPostIndex !== null && feed.posts[selectedPostIndex]) {
          return (
            // Same remount-on-identity-change pattern as PersonaProfile —
            // PostDetail owns local state (replyOpen, repliesLoaded, menu
            // flags, etc.) through its inner PostCard. Navigating from one
            // post to another without a key would reuse that state and
            // silently show stale replies for the previous post.
            <PostDetail
              key={selectedPostIndex}
              post={feed.posts[selectedPostIndex]}
              postIndex={selectedPostIndex}
              posts={feed.posts}
              feedId={feed.feedId}
              autoOpenReply={autoOpenReply}
              onBack={() => {
                setSelectedPostIndex(null)
                setAutoOpenReply(false)
                requestAnimationFrame(() => {
                  document.querySelector('main')?.scrollTo(0, feedScrollRef.current)
                })
              }}
              onNavigateToPost={(idx) => {
                setSelectedPostIndex(idx)
                document.querySelector('main')?.scrollTo(0, 0)
              }}
              isBookmarked={bm.isBookmarked}
              onBookmarkToggle={(fid, idx, post) => bm.toggle(fid, idx, post)}
              getAnnotation={notes.getNote}
              onAnnotationSave={notes.save}
              onAnnotationDelete={notes.remove}
            />
          )
        }
        return (
          <>
            <FeedHeader
              paperCount={filteredPaperCount}
              onGenerate={handleGenerate}
              generating={feed.feedState === 'generating'}
              onMobileLogoTap={() => setShowMobileDrawer(true)}
              isOnline={isOnline}
              workspaceProps={{
                workspaces: ws.workspaces,
                active: ws.active,
                showUI: ws.showWorkspaceUI,
                onSwitch: ws.switchTo,
                onCreate: (name) => ws.create(name),
                onDelete: (id) => ws.remove(id),
                onRename: (id, name) => ws.rename(id, name),
                onDownload: handleDownloadWorkspace,
              }}
            />
            <OfflineBanner />
            <MobileInstallBanner />
            <FeedTabs active={activeTab} onSelect={setActiveTab} />
            <FeedHistory currentFeedId={feed.feedId} onLoadFeed={feed.loadFeed} workspaceId={ws.activeId} />
            <ComposeBox
              workspaceId={ws.activeId}
              onPostCreated={userPosts.refresh}
              userDisplayName={appSettings.settings?.user_display_name as string || 'You'}
              userHandle={appSettings.settings?.user_handle as string || '@you'}
              onUserClick={() => setActiveView('profile')}
              onViewProfileClick={() => setActiveView('profile')}
            />
            <PullToRefresh onRefresh={handlePullToRefresh}>
              <SwipeableTabs activeIndex={activeTab} tabCount={4} onChange={setActiveTab}>
                <FeedContent
                  posts={feed.posts}
                  feedId={feed.feedId}
                  feedState={feed.feedState}
                  generatingMeta={feed.generatingMeta}
                  error={feed.error}
                  activeTab={activeTab}
                  isBookmarked={bm.isBookmarked}
                  onBookmarkToggle={handleBookmarkToggleOuter}
                  getAnnotation={notes.getNote}
                  onAnnotationSave={notes.save}
                  onAnnotationDelete={notes.remove}
                  onPostClick={handlePostClick}
                  onPersonaClick={setSelectedPersona}
                  onReplyBookmark={handleReplyBookmark}
                  isReplyBookmarked={handleIsReplyBookmarked}
                  onGenerate={handleGenerateMore}
                />
              </SwipeableTabs>
            </PullToRefresh>
          </>
        )
    }
  }

  return (
    <PersonasProvider value={personas}>
      <div className="min-h-screen bg-bg text-text">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-bg focus:text-text focus:border focus:border-gold focus:px-3 focus:py-1.5 focus:rounded">Skip to main content</a>
        <div className="max-w-[1050px] mx-auto flex min-h-screen">
          <LeftNav active={activeView} onNavigate={setActiveView} alertCount={alertsHook.unreadCount} />
          <main id="main" className="flex-1 border-r border-border w-full md:max-w-[600px] min-w-0 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0 overflow-hidden">
            {/* Visually-hidden landmark heading: every authenticated view
                currently jumps to <h2>, which AXE flags as a missing h1.
                A single sr-only h1 establishes the document root for
                screen readers without changing visual hierarchy. */}
            <h1 className="sr-only">Ficino</h1>
            <Suspense fallback={<div className="p-4 text-text-muted">Loading…</div>}>
              {renderMainContent()}
            </Suspense>
          </main>
          <Sidebar
            corpus={corpus}
            activeTag={activeTag}
            onTagFilter={setActiveTag}
            enabledPersonas={enabledPersonas}
            onSearchClick={() => setActiveView('search')}
            paperSummaries={paperTldrs}
            onPaperClick={(paperId) => {
              setPendingPaperId(paperId)
              setActiveView('messages')
            }}
            onPersonaClick={setSelectedPersona}
          />
        </div>
        <MobileBottomNav
          active={activeView}
          onNavigate={setActiveView}
          onLongPressHome={() => setShowWorkspaceSheet(true)}
        />
        <MobileDrawer
          open={showMobileDrawer}
          onClose={() => setShowMobileDrawer(false)}
          corpus={corpus}
          enabledPersonas={enabledPersonas}
          activeTag={activeTag}
          onTagFilter={setActiveTag}
          paperSummaries={paperTldrs}
          onPaperClick={(paperId) => {
            setPendingPaperId(paperId)
            setActiveView('messages')
          }}
        />
        {showWorkspaceSheet && (
          <WorkspaceBottomSheet
            workspaces={ws.workspaces}
            activeId={ws.activeId}
            onSwitch={ws.switchTo}
            onCreate={(name) => ws.create(name)}
            onClose={() => setShowWorkspaceSheet(false)}
          />
        )}
      </div>
      <DownloadProgress
        progress={dlProgress}
        workspaceName={dlWorkspaceName}
        onClose={() => setDlProgress(null)}
        onCancel={handleCancelDownload}
      />
    </PersonasProvider>
  )
}
