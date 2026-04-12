import { useState, useEffect, useRef } from 'react'
import { Folder, Plus, FileText, Zap, Loader2, Trash2, Pencil, Search, X } from 'lucide-react'
import type { Workspace, ActivityItem } from '../../types'
import { getWorkspaceActivity, searchCorpus, type SearchResults } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'

interface ExploreViewProps {
  workspaces: Workspace[]
  activeId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  papers?: { id: string; title: string | null; status: string }[]
  paperSummaries?: Map<string, string>
  onPaperClick?: (paperId: string) => void
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function NewWorkspaceInput({ onCreate }: { onCreate: (name: string) => void }) {
  const [showing, setShowing] = useState(false)
  const [name, setName] = useState('')

  if (!showing) {
    return (
      <button
        onClick={() => setShowing(true)}
        className="w-full p-4 border-2 border-dashed border-border rounded-2xl flex items-center justify-center gap-2 text-text-muted hover:border-gold/30 hover:text-gold bg-transparent cursor-pointer transition-colors"
      >
        <Plus size={18} />
        <span className="text-sm font-medium">New Workspace</span>
      </button>
    )
  }

  return (
    <div className="p-4 border border-gold/20 rounded-2xl bg-bg-hover">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) { onCreate(name.trim()); setName(''); setShowing(false) }
          if (e.key === 'Escape') { setShowing(false); setName('') }
        }}
        placeholder="Workspace name..."
        autoFocus
        className="w-full bg-transparent border border-border rounded-lg px-3 py-2 text-sm text-text outline-none focus:border-gold/40 mb-2"
      />
      <div className="flex gap-2">
        <button
          onClick={() => { if (name.trim()) { onCreate(name.trim()); setName(''); setShowing(false) } }}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-bg cursor-pointer border-none"
          style={{ background: 'linear-gradient(135deg, var(--color-gold), var(--color-gold-dark))' }}
        >
          Create
        </button>
        <button
          onClick={() => { setShowing(false); setName('') }}
          className="px-3 py-1.5 rounded-lg text-xs text-text-muted bg-transparent border border-border cursor-pointer hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ActivityTimeline({ workspaceId }: { workspaceId: string }) {
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getWorkspaceActivity(workspaceId)
      .then(setActivities)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workspaceId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="text-text-muted animate-spin" />
      </div>
    )
  }

  if (activities.length === 0) {
    return (
      <p className="text-xs text-text-muted py-4 text-center">No activity yet</p>
    )
  }

  return (
    <div className="space-y-2">
      {activities.map((a, i) => (
        <div key={i} className="flex items-start gap-3 py-1.5">
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
            style={{
              backgroundColor: a.type === 'paper_upload' ? 'color-mix(in srgb, var(--color-persona-practitioner) 9%, transparent)' : 'color-mix(in srgb, var(--color-persona-gradstudent) 9%, transparent)',
            }}
          >
            {a.type === 'paper_upload'
              ? <FileText size={13} className="text-persona-practitioner" />
              : <Zap size={13} className="text-persona-gradstudent" />
            }
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-text truncate">{a.title}</div>
            <div className="text-[11px] text-text-muted">{a.detail} · {timeAgo(a.timestamp)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function SearchBar() {
  const personas = usePersonas()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [searching, setSearching] = useState(false)
  const [focused, setFocused] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!value.trim()) {
      setResults(null)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await searchCorpus(value.trim())
        setResults(data)
      } catch {
        // ignore
      } finally {
        setSearching(false)
      }
    }, 300)
  }

  const totalResults = results
    ? results.papers.length + results.chunks.length + results.posts.length
    : 0

  return (
    <div className="relative">
      <div className="flex items-center gap-2.5 bg-bg-hover border border-border rounded-2xl px-4 py-2.5 focus-within:border-gold/40 transition-colors">
        <Search size={16} className="text-text-muted shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          placeholder="Search papers, chunks, posts..."
          autoFocus
          aria-label="Search corpus"
          className="flex-1 bg-transparent border-none text-[15px] text-text outline-none placeholder:text-text-muted"
        />
        {searching && <Loader2 size={14} className="text-gold animate-spin shrink-0" />}
        {query && !searching && (
          <button
            onClick={() => { setQuery(''); setResults(null) }}
            aria-label="Clear search"
            className="bg-transparent border-none cursor-pointer p-1 text-text-muted hover:text-text"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Results dropdown */}
      {focused && results && query && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-bg border border-border rounded-2xl shadow-lg z-50 max-h-[60vh] overflow-y-auto">
          {totalResults === 0 ? (
            <div className="p-4 text-center text-sm text-text-muted">
              No results for "{query}"
            </div>
          ) : (
            <>
              {/* Papers */}
              {results.papers.length > 0 && (
                <div>
                  <div className="px-4 py-2 text-[11px] font-bold text-gold tracking-widest uppercase border-b border-border">
                    Papers ({results.papers.length})
                  </div>
                  {results.papers.map((p) => (
                    <div key={p.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-bg-hover cursor-pointer border-b border-border last:border-b-0">
                      <FileText size={14} className="text-text-muted shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-text font-medium truncate">{p.title}</div>
                        <div className="text-[11px] text-text-muted">
                          {p.authors.slice(0, 2).join(', ')}{p.year ? ` · ${p.year}` : ''} · {p.chunk_count} chunks
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Chunks */}
              {results.chunks.length > 0 && (
                <div>
                  <div className="px-4 py-2 text-[11px] font-bold text-persona-methodologist tracking-widest uppercase border-b border-border">
                    Passages ({results.chunks.length})
                  </div>
                  {results.chunks.map((c) => (
                    <div key={c.id} className="px-4 py-2.5 hover:bg-bg-hover cursor-pointer border-b border-border last:border-b-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] text-text-mid font-medium truncate">{c.paper_title}</span>
                        <span className="text-[10px] text-text-muted">· {c.section}</span>
                        <span className="text-[10px] text-gold/50 ml-auto">{(c.rank * 100).toFixed(0)}%</span>
                      </div>
                      <p className="text-[12px] text-text-muted leading-relaxed line-clamp-2">
                        {c.content}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Posts */}
              {results.posts.length > 0 && (
                <div>
                  <div className="px-4 py-2 text-[11px] font-bold text-persona-practitioner tracking-widest uppercase border-b border-border">
                    Feed Posts ({results.posts.length})
                  </div>
                  {results.posts.map((p, i) => {
                    const persona = personas[p.persona]
                    return (
                      <div key={i} className="px-4 py-2.5 flex items-start gap-2.5 hover:bg-bg-hover cursor-pointer border-b border-border last:border-b-0">
                        {persona && (
                          persona.avatar_url ? (
                            <img src={persona.avatar_url} alt={persona.name} className="w-6 h-6 rounded-full shrink-0 mt-0.5 object-cover" style={{ border: `1px solid ${persona.color}40` }} />
                          ) : (
                            <div
                              className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"
                              style={{ backgroundColor: persona.color + '22', border: `1px solid ${persona.color}40`, color: persona.color }}
                            >
                              {persona.initials}
                            </div>
                          )
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] text-text-muted mb-0.5">
                            {persona?.name || p.persona} · {p.paper_ref || 'General'}
                          </div>
                          <p className="text-[12px] text-text leading-relaxed line-clamp-2">
                            {p.content}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function ExploreView({ workspaces, activeId, onSwitch, onCreate, onDelete, onRename, papers, paperSummaries, onPaperClick }: ExploreViewProps) {
  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5">
        <h1 className="text-xl font-bold text-text">Explore</h1>
        <p className="text-xs text-text-muted mt-0.5">Search, workspaces & activity</p>
      </div>

      <div className="p-4 space-y-4">
        {/* Search */}
        <SearchBar />

        {/* What's happening — paper headlines with TL;DRs */}
        {papers && papers.filter(p => p.status === 'complete').length > 0 && (
          <div className="bg-bg-hover border border-border rounded-2xl p-4">
            <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
              What's happening
            </div>
            <div className="divide-y divide-border">
              {papers.filter(p => p.status === 'complete').map((paper) => {
                const tldr = paperSummaries?.get(paper.id)
                return (
                  <button
                    key={paper.id}
                    onClick={() => onPaperClick?.(paper.id)}
                    className="w-full text-left py-2.5 bg-transparent border-none cursor-pointer hover:bg-bg transition-colors -mx-1 px-1 rounded-lg"
                  >
                    <div className="text-[13px] text-text font-semibold leading-snug">
                      {paper.title || paper.id}
                    </div>
                    {tldr && (
                      <p className="text-[12px] text-text-muted leading-snug mt-0.5 line-clamp-2">
                        {tldr}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Workspace grid */}
        <div className="space-y-3">
          <div className="text-[13px] font-bold text-gold tracking-widest uppercase">
            Workspaces
          </div>

          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => onSwitch(ws.id)}
              className="w-full text-left p-4 rounded-2xl border flex items-start gap-3 bg-transparent cursor-pointer hover:bg-bg-hover transition-colors group"
              style={{
                borderColor: ws.id === activeId ? 'color-mix(in srgb, var(--color-gold) 25%, transparent)' : 'var(--color-border)',
                backgroundColor: ws.id === activeId ? 'color-mix(in srgb, var(--color-gold) 4%, transparent)' : undefined,
              }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: ws.id === activeId
                    ? 'linear-gradient(135deg, var(--color-gold), var(--color-gold-dark))'
                    : 'var(--color-border)',
                }}
              >
                <Folder size={18} color={ws.id === activeId ? 'var(--color-bg)' : 'var(--color-tab-inactive)'} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-text">{ws.name}</span>
                  {ws.id === activeId && (
                    <span className="text-[10px] text-gold bg-gold/10 border border-gold/20 rounded px-1.5 py-px font-semibold">
                      ACTIVE
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-muted mt-0.5">
                  {ws.paper_count} paper{ws.paper_count !== 1 ? 's' : ''} · {ws.feed_count} feed{ws.feed_count !== 1 ? 's' : ''}
                  {ws.last_activity && ` · ${timeAgo(ws.last_activity)}`}
                </div>
              </div>
              {ws.name !== 'Default' && (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      const name = prompt('Rename workspace:', ws.name)
                      if (name && name.trim()) onRename(ws.id, name.trim())
                    }}
                    aria-label={`Rename ${ws.name}`}
                    className="p-1.5 rounded-lg hover:bg-gold/10 bg-transparent border-none cursor-pointer"
                  >
                    <Pencil size={14} className="text-text-muted" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(ws.id) }}
                    aria-label={`Delete ${ws.name}`}
                    className="p-1.5 rounded-lg hover:bg-persona-skeptic/10 bg-transparent border-none cursor-pointer"
                  >
                    <Trash2 size={14} className="text-persona-skeptic" />
                  </button>
                </div>
              )}
            </button>
          ))}

          <NewWorkspaceInput onCreate={onCreate} />
        </div>

        {/* Activity timeline for active workspace */}
        <div>
          <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
            Recent Activity
          </div>
          <ActivityTimeline workspaceId={activeId} />
        </div>
      </div>
    </div>
  )
}
