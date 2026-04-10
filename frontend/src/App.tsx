import { useState } from 'react'
import {
  Home, Search, Bell, Mail, Bookmark, Settings,
  Zap, Loader2
} from 'lucide-react'
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
          src="/ficino/ficino-favicon-light.png"
          alt="ficino"
          className="w-9 h-9 rounded-[10px]"
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
            color: active === view ? '#e8eaf0' : '#7a8194',
            backgroundColor: active === view ? 'rgba(200, 169, 110, 0.08)' : 'transparent',
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
          style={{ color: active === view ? '#c8a96e' : '#7a8194' }}
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
  activePersonaCount,
  onGenerate,
  generating,
  activeTag,
  onMobileLogoTap,
  workspaceProps,
}: {
  paperCount: number
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
  }
}) {
  return (
    <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5 flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2">
          <img
            src="/ficino/ficino-favicon-light.png"
            alt="ficino"
            className="w-7 h-7 rounded-lg md:hidden cursor-pointer"
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
            />
          )}
          {workspaceProps?.showUI && <span>·</span>}
          <span>
            {paperCount} paper{paperCount !== 1 ? 's' : ''} · {activePersonaCount} persona{activePersonaCount !== 1 ? 's' : ''} ·{' '}
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
        style={{ background: 'linear-gradient(135deg, #c8a96e, #a07840)' }}
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
    <div className="flex border-b border-border">
      {tabs.map((tab, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          className="flex-1 py-3.5 border-none bg-transparent cursor-pointer text-[15px] transition-all duration-150"
          style={{
            color: active === i ? '#e8eaf0' : '#555d6e',
            fontWeight: active === i ? 700 : 400,
            borderBottom: active === i ? '2px solid #c8a96e' : '2px solid transparent',
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}

function Sidebar({ corpus, activeTag, onTagFilter, enabledPersonas, onSearchClick }: {
  corpus: ReturnType<typeof useCorpus>
  activeTag: string | null
  onTagFilter: (tag: string | null) => void
  enabledPersonas: Record<string, boolean>
  onSearchClick: () => void
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

      <PaperUpload onUpload={corpus.upload} uploading={corpus.uploading} />

      <CorpusPanel
        papers={corpus.papers}
        loading={corpus.loading}
        onDelete={corpus.remove}
        onRefresh={corpus.refresh}
        activeTag={activeTag}
        onTagFilter={onTagFilter}
      />

      <PersonaPanel enabledPersonas={enabledPersonas} />
    </aside>
  )
}

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('feed')
  const [activeTab, setActiveTab] = useState(0)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [showWorkspaceSheet, setShowWorkspaceSheet] = useState(false)
  const [showMobileDrawer, setShowMobileDrawer] = useState(false)
  const ws = useWorkspaces()
  const corpus = useCorpus(ws.activeId)
  const feed = useFeed()
  const bm = useBookmarks()
  const appSettings = useSettings()
  const alertsHook = useAlerts()

  const completePapers = corpus.papers.filter((p) => p.status === 'complete')
  const enabledPersonas = (appSettings.settings.personas_enabled || {}) as Record<string, boolean>
  const activePersonaCount = Object.values(enabledPersonas).filter((v) => v !== false).length || 5

  const filteredPaperCount = activeTag
    ? completePapers.filter((p) => p.tags?.some((t) => t.name === activeTag)).length
    : completePapers.length

  const handleGenerate = () => {
    feed.generate(undefined, activeTag ? [activeTag] : undefined)
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
        return <MessagesView />
      case 'search':
        return (
          <ExploreView
            workspaces={ws.workspaces}
            activeId={ws.activeId}
            onSwitch={ws.switchTo}
            onCreate={(name) => ws.create(name)}
            onDelete={ws.remove}
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
        return <BookmarksView bookmarks={bm.bookmarks} loading={bm.loading} onRemove={bm.remove} />
      case 'settings':
        return (
          <SettingsView
            settings={appSettings.settings}
            loading={appSettings.loading}
            onUpdate={appSettings.update}
          />
        )
      default:
        return (
          <>
            <FeedHeader
              paperCount={filteredPaperCount}
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
              }}
            />
            <FeedTabs active={activeTab} onSelect={setActiveTab} />
            <FeedHistory currentFeedId={feed.feedId} onLoadFeed={feed.loadFeed} />
            <FeedContent
              posts={feed.posts}
              feedId={feed.feedId}
              feedState={feed.feedState}
              generatingMeta={feed.generatingMeta}
              error={feed.error}
              activeTab={activeTab}
              isBookmarked={bm.isBookmarked}
              onBookmarkToggle={(fid, idx, post) => bm.toggle(fid, idx, post)}
            />
          </>
        )
    }
  }

  return (
    <div className="min-h-screen bg-bg text-text">
      <div className="max-w-[1050px] mx-auto flex min-h-screen">
        <LeftNav active={activeView} onNavigate={setActiveView} alertCount={alertsHook.unreadCount} />
        <main className="flex-1 border-r border-border w-full md:max-w-[600px] min-w-0 pb-16 md:pb-0 overflow-hidden">
          {renderMainContent()}
        </main>
        <Sidebar corpus={corpus} activeTag={activeTag} onTagFilter={setActiveTag} enabledPersonas={enabledPersonas} onSearchClick={() => setActiveView('search')} />
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
  )
}
