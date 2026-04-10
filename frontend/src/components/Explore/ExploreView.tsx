import { useState, useEffect } from 'react'
import { Folder, Plus, FileText, Zap, Loader2, Trash2 } from 'lucide-react'
import type { Workspace, ActivityItem } from '../../types'
import { getWorkspaceActivity } from '../../lib/api'

interface ExploreViewProps {
  workspaces: Workspace[]
  activeId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
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
          style={{ background: 'linear-gradient(135deg, #c8a96e, #a07840)' }}
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
              backgroundColor: a.type === 'paper_upload' ? '#4a9eff18' : '#34d39918',
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

export function ExploreView({ workspaces, activeId, onSwitch, onCreate, onDelete }: ExploreViewProps) {
  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5">
        <h1 className="text-xl font-bold text-text">Explore</h1>
        <p className="text-xs text-text-muted mt-0.5">Workspaces & activity</p>
      </div>

      <div className="p-4 space-y-4">
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
                borderColor: ws.id === activeId ? '#c8a96e40' : '#1e2028',
                backgroundColor: ws.id === activeId ? 'rgba(200, 169, 110, 0.04)' : undefined,
              }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: ws.id === activeId
                    ? 'linear-gradient(135deg, #c8a96e, #a07840)'
                    : '#1e2028',
                }}
              >
                <Folder size={18} color={ws.id === activeId ? '#080a0f' : '#555d6e'} />
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
              {ws.id !== activeId && ws.name !== 'Default' && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(ws.id) }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-persona-skeptic/10 transition-all bg-transparent border-none cursor-pointer"
                >
                  <Trash2 size={14} className="text-persona-skeptic" />
                </button>
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
