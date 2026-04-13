import { useState, useRef, useEffect } from 'react'
import {
  Home, Search, Bell, Mail, Bookmark, Settings,
  Zap, Loader2
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
import { FeedHistory } from './components/Feed/FeedHistory'
import { MessagesView } from './components/Messages/MessagesView'
import { BookmarksView } from './components/Bookmarks/BookmarksView'
import { ExploreView } from './components/Explore/ExploreView'
import { SettingsView } from './components/Settings/SettingsView'
import { AlertsView } from './components/Alerts/AlertsView'
import { useSettings } from './hooks/useSettings'
import { useAlerts } from './hooks/useAlerts'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { WorkspaceDropdown } from './components/Nav/WorkspaceDropdown'
import { WorkspaceBottomSheet } from './components/Nav/WorkspaceBottomSheet'
import { MobileDrawer } from './components/Nav/MobileDrawer'
import { PostDetail } from './components/Feed/PostDetail'
import { ComposeBox } from './components/Feed/ComposeBox'
import { UserPostCard } from './components/Feed/UserPostCard'
import { PersonaProfile } from './components/Personas/PersonaProfile'
import { UserProfile } from './components/Personas/UserProfile'
import { usePersonasLoader, PersonasProvider } from './hooks/usePersonas'
import { useUserPosts } from './hooks/useUserPosts'
import { getFeed, getPaperTldrs } from './lib/api'
import { useAnnotations } from './hooks/useAnnotations'

type AppView = 'feed' | 'messages' | 'search' | 'alerts' | 'bookmarks' | 'settings'

const NAV_ITEMS: { icon: typeof Home; view: AppView; label: string }[] = [
  { icon: Home, view: 'feed', label: 'Home' },
  { icon: Search, view: 'search', label: 'Search' },
  { icon: Bell, view: 'alerts', label: 'Alerts' },
  { icon: Mail, view: 'messages', label: 'Messages' },
  { icon: Bookmark, view: 'bookmarks', label: 'Saved' },
  { icon: Settings, view: 'settings', label: 'Settings' },
]

function LeftNav({ active, onNavigate, alertCount }: { active: AppView; onNavigate: (v: AppView) => void; alertCount: number }) {
  return (
    <nav aria-label="Main navigation" className="w-16 shrink-0 flex-col items-center pt-5 gap-0.5 border-r border-border hidden md:flex">
      <div className="mb-5">
        <img
          src={`${import.meta.env.BASE_URL}ficino-favicon-light.png`}
          alt="ficino"
          className="w-9 h-9 rounded-[10px] app-logo"
        />
      </div>
      {NAV_ITEMS.map(({ icon: Icon, view, label }) => (
        <button
          key={view}
          onClick={() => onNavigate(view)}
          aria-label={label}
          aria-current={active === view ? 'page' : undefined}
          className="w-[46px] h-[46px] rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-100 hover:bg-gold/10 hover:text-gold relative"
          style={{
            color: active === view ? 'var(--color-nav-active)' : 'var(--color-nav-inactive)',
            backgroundColor: active === view ? 'color-mix(in srgb, var(--color-gold) 8%, transparent)' : 'transparent',
          }}
        >
          <Icon size={20} strokeWidth={active === view ? 2.25 : 1.75} />
          {view === 'alerts' && alertCount > 0 && (
            <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 rounded-full bg-persona-skeptic text-white text-[10px] font-bold flex items-center justify-center px-1">
              {alertCount > 9 ? '9+' : alertCount}
            </span>
          )}
        </button>
      ))}
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
    { icon: Search, view: 'search', label: 'Explore' },
    { icon: Mail, view: 'messages', label: 'Messages' },
    { icon: Bookmark, view: 'bookmarks', label: 'Saved' },
  ]
  let longPressTimer: ReturnType<typeof setTimeout> | null = null

  return (
    <nav aria-label="Mobile navigation" className="fixed bottom-0 left-0 right-0 bg-bg/95 backdrop-blur-md border-t border-border flex md:hidden z-50">
      {items.map(({ icon: Icon, view, label }) => (
        <button
          key={view}
          onClick={() => onNavigate(view)}
          onTouchStart={view === 'feed' ? () => {
            longPressTimer = setTimeout(onLongPressHome, 500)
          } : undefined}
          onTouchEnd={view === 'feed' ? () => {
            if (longPressTimer) clearTimeout(longPressTimer)
          } : undefined}
          onTouchCancel={view === 'feed' ? () => {
            if (longPressTimer) clearTimeout(longPressTimer)
          } : undefined}
          aria-label={label}
          aria-current={active === view ? 'page' : undefined}
          className="flex-1 flex flex-col items-center py-2.5 gap-0.5 bg-transparent border-none transition-colors"
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
  totalPaperCount,
  activePersonaCount,
  onGenerate,
  generating,
  activeTag,
  onMobileLogoTap,
  workspaceProps,
}: {
  paperCount: number
  totalPaperCount: number
  activePersonaCount: number
  onGenerate: () => void
  generating: boolean
  activeTag: string | null
  onMobileLogoTap?: () => void
  workspaceProps?: {
    workspaces: import('./types').Workspace[]
    active: import('./types').Workspace | null
    showUI: boolean
    onSwitch: (id: string) => void
    onCreate: (name: string) => void
    onDelete: (id: string) => void
    onRename: (id: string, name: string) => void
  }
}) {
  return (
    <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5 flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2">
          <img
            src={`${import.meta.env.BASE_URL}ficino-favicon-light.png`}
            alt="ficino"
            className="w-7 h-7 rounded-lg md:hidden cursor-pointer app-logo"
            onClick={onMobileLogoTap}
          />
          <span className="text-[22px] font-semibold text-text tracking-[0.015em]" style={{ fontFamily: "'Cormorant Garamond', serif", fontKerning: 'normal' }}>ficino</span>
          <span className="text-[11px] text-gold bg-gold/10 border border-gold/20 rounded px-1.5 py-0.5 font-semibold tracking-wider">
            BETA
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs text-text-muted mt-0.5">
          {workspaceProps?.showUI && workspaceProps.active && (
            <WorkspaceDropdown
              workspaces={workspaceProps.workspaces}
              active={workspaceProps.active}
              onSwitch={workspaceProps.onSwitch}
              onCreate={workspaceProps.onCreate}
              onDelete={workspaceProps.onDelete}
              onRename={workspaceProps.onRename}
            />
          )}
          {workspaceProps?.showUI && <span>·</span>}
          <span>
            {paperCount === totalPaperCount
              ? `${paperCount} paper${paperCount !== 1 ? 's' : ''}`
              : `${paperCount} of ${totalPaperCount} papers`
            } · {activePersonaCount} persona{activePersonaCount !== 1 ? 's' : ''} ·{' '}
            {generating ? 'generating' : 'ready'}
          </span>
          {activeTag && (
            <span className="ml-1 text-gold"> · #{activeTag}</span>
          )}
        </div>
      </div>
      <button
        onClick={onGenerate}
        disabled={generating || paperCount === 0}
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
  return (
    <div className="flex border-b border-border" role="tablist" aria-label="Feed filters">
      {tabs.map((tab, i) => (
        <button
          key={i}
          role="tab"
          aria-selected={active === i}
          onClick={() => onSelect(i)}
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

export default function App() {
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

  useEffect(() => {
    getPaperTldrs().then((data) => setPaperTldrs(new Map(Object.entries(data)))).catch(() => {})
  }, [corpus.papers])

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
  const activePersonaCount = Object.values(enabledPersonas).filter((v) => v !== false).length || 5

  const filteredPaperCount = activeTag
    ? completePapers.filter((p) => p.tags?.some((t) => t.name === activeTag)).length
    : completePapers.length

  const handleGenerate = () => {
    setSelectedPostIndex(null)
    feed.generate(ws.activeId, activeTag ? [activeTag] : undefined)
  }

  useKeyboardShortcuts({
    onNavigate: setActiveView,
    onGenerate: handleGenerate,
    onCloseMobileDrawer: () => setShowMobileDrawer(false),
    onCloseWorkspaceSheet: () => setShowWorkspaceSheet(false),
    generating: feed.feedState === 'generating',
  })

  const renderMainContent = () => {
    switch (activeView) {
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
      case 'settings':
        return (
          <SettingsView
            settings={appSettings.settings}
            loading={appSettings.loading}
            onUpdate={appSettings.update}
          />
        )
      default:
        if (selectedPersona === '__user__') {
          return (
            <UserProfile
              workspaceId={ws.activeId}
              displayName={appSettings.settings?.user_display_name as string || 'You'}
              handle={appSettings.settings?.user_handle as string || '@you'}
              onBack={() => setSelectedPersona(null)}
              onPersonaClick={setSelectedPersona}
            />
          )
        }
        if (selectedPersona) {
          return (
            <PersonaProfile
              personaKey={selectedPersona}
              onBack={() => setSelectedPersona(null)}
              posts={feed.posts}
              feedId={feed.feedId}
            />
          )
        }
        if (selectedPostIndex !== null && feed.posts[selectedPostIndex]) {
          return (
            <PostDetail
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
              totalPaperCount={corpus.papers.length}
              activePersonaCount={activePersonaCount}
              onGenerate={handleGenerate}
              generating={feed.feedState === 'generating'}
              activeTag={activeTag}
              onMobileLogoTap={() => setShowMobileDrawer(true)}
              workspaceProps={{
                workspaces: ws.workspaces,
                active: ws.active,
                showUI: ws.showWorkspaceUI,
                onSwitch: ws.switchTo,
                onCreate: (name) => ws.create(name),
                onDelete: (id) => ws.remove(id),
                onRename: (id, name) => ws.rename(id, name),
              }}
            />
            <FeedTabs active={activeTab} onSelect={setActiveTab} />
            <FeedHistory currentFeedId={feed.feedId} onLoadFeed={feed.loadFeed} workspaceId={ws.activeId} />
            <ComposeBox
              workspaceId={ws.activeId}
              onPostCreated={userPosts.refresh}
              userDisplayName={appSettings.settings?.user_display_name as string || 'You'}
              userHandle={appSettings.settings?.user_handle as string || '@you'}
              onUserClick={() => setSelectedPersona('__user__')}
            />
            {userPosts.posts.length > 0 && (
              <div>
                {userPosts.posts.map((up) => (
                  <UserPostCard
                    key={up.id}
                    post={up}
                    userDisplayName={appSettings.settings?.user_display_name as string || 'You'}
                    userHandle={appSettings.settings?.user_handle as string || '@you'}
                    onDeleted={userPosts.refresh}
                    onPersonaClick={setSelectedPersona}
                  />
                ))}
              </div>
            )}
            <FeedContent
              posts={feed.posts}
              feedId={feed.feedId}
              feedState={feed.feedState}
              generatingMeta={feed.generatingMeta}
              error={feed.error}
              activeTab={activeTab}
              isBookmarked={bm.isBookmarked}
              onBookmarkToggle={(fid, idx, post) => bm.toggle(fid, idx, post)}
              getAnnotation={notes.getNote}
              onAnnotationSave={notes.save}
              onAnnotationDelete={notes.remove}
              onPostClick={(idx) => {
                feedScrollRef.current = document.querySelector('main')?.scrollTop ?? 0
                setSelectedPostIndex(idx)
                document.querySelector('main')?.scrollTo(0, 0)
              }}
              onPersonaClick={setSelectedPersona}
              onReplyBookmark={(fid, postIdx, msgIdx, snapshot) => bm.toggle(fid, postIdx, snapshot as unknown as FeedPost, msgIdx)}
              isReplyBookmarked={(postIdx, msgIdx) => feed.feedId ? bm.isReplyBookmarked(feed.feedId, postIdx, msgIdx) : false}
              onGenerate={() => {
                feed.generate(ws.activeId, activeTag ? [activeTag] : undefined, feed.feedId || undefined)
              }}
            />
          </>
        )
    }
  }

  return (
    <PersonasProvider value={personas}>
      <div className="min-h-screen bg-bg text-text">
        <div className="max-w-[1050px] mx-auto flex min-h-screen">
          <LeftNav active={activeView} onNavigate={setActiveView} alertCount={alertsHook.unreadCount} />
          <main className="flex-1 border-r border-border w-full md:max-w-[600px] min-w-0 pb-16 md:pb-0 overflow-hidden">
            {renderMainContent()}
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
    </PersonasProvider>
  )
}
