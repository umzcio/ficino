import {
  Bell, AlertTriangle, GitBranch, BookOpen, Clock, X, CheckCheck
} from 'lucide-react'
import type { AlertItem } from '../../lib/api'

interface AlertsViewProps {
  alerts: AlertItem[]
  loading: boolean
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onDismiss: (id: string) => void
  onNavigate?: (view: string) => void
}

const ALERT_CONFIG: Record<string, { icon: typeof AlertTriangle; color: string; label: string }> = {
  contradiction: { icon: AlertTriangle, color: 'var(--color-persona-skeptic)', label: 'Contradiction' },
  disagreement_spike: { icon: GitBranch, color: 'var(--color-persona-hype)', label: 'Debate Spike' },
  reading_gap: { icon: BookOpen, color: 'var(--color-persona-practitioner)', label: 'Go Deeper' },
  stale_paper: { icon: Clock, color: 'var(--color-tab-inactive)', label: 'Stale Paper' },
  emerging_theme: { icon: GitBranch, color: 'var(--color-persona-methodologist)', label: 'Emerging Theme' },
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

function AlertCard({ alert, onMarkRead, onDismiss, onAction }: {
  alert: AlertItem
  onMarkRead: () => void
  onDismiss: () => void
  onAction?: () => void
}) {
  const config = ALERT_CONFIG[alert.type] || ALERT_CONFIG.contradiction
  const Icon = config.icon

  return (
    <div
      className="px-4 py-3.5 flex gap-3 border-b border-border cursor-pointer hover:bg-bg-hover transition-colors"
      style={{ backgroundColor: alert.read ? 'transparent' : 'color-mix(in srgb, var(--color-gold) 3%, transparent)' }}
      onClick={() => { onMarkRead(); onAction?.() }}
    >
      {/* Unread dot */}
      <div className="flex flex-col items-center pt-1.5 w-3 shrink-0">
        {!alert.read && (
          <div className="w-2 h-2 rounded-full bg-gold" />
        )}
      </div>

      {/* Icon */}
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
        style={{ backgroundColor: config.color + '15' }}
      >
        <Icon size={16} style={{ color: config.color }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span
            className="text-[10px] font-bold tracking-wider uppercase"
            style={{ color: config.color }}
          >
            {config.label}
          </span>
          <span className="text-[11px] text-text-muted">{timeAgo(alert.created_at)}</span>
        </div>
        <div className="text-[14px] font-semibold text-text mb-0.5">
          {alert.title}
        </div>
        <div className="text-[13px] text-text-mid leading-snug">
          {alert.body}
        </div>
        {onAction && (
          <div className="mt-1.5">
            <span className="text-[11px] text-gold font-medium">
              {alert.type === 'disagreement_spike' ? 'View feed →' :
               alert.type === 'reading_gap' || alert.type === 'stale_paper' ? 'View paper →' :
               alert.type === 'contradiction' ? 'View paper →' : ''}
            </span>
          </div>
        )}
      </div>

      {/* Dismiss */}
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
        aria-label={`Dismiss ${alert.title}`}
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-transparent border-none cursor-pointer hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function AlertsView({ alerts, loading, onMarkRead, onMarkAllRead, onDismiss, onNavigate }: AlertsViewProps) {
  const unread = alerts.filter((a) => !a.read).length

  const getAlertAction = (alert: AlertItem) => {
    if (!onNavigate) return undefined
    const meta = alert.metadata || {}
    if (alert.type === 'disagreement_spike' && meta.feed_id) {
      return () => onNavigate('feed')
    }
    if ((alert.type === 'reading_gap' || alert.type === 'stale_paper' || alert.type === 'contradiction') && meta.paper_id) {
      return () => onNavigate('messages')
    }
    return undefined
  }

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text">Alerts</h1>
          <p className="text-xs text-text-muted mt-0.5">Learning insights from your corpus</p>
        </div>
        {unread > 0 && (
          <button
            onClick={onMarkAllRead}
            className="flex items-center gap-1.5 text-[12px] text-gold bg-transparent border border-gold/20 rounded-lg px-2.5 py-1 cursor-pointer hover:bg-gold/5 transition-colors"
          >
            <CheckCheck size={13} />
            Mark all read
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <Bell size={48} strokeWidth={1} className="mb-4 text-gold/30" />
          <p className="text-lg font-semibold text-text-mid mb-2">No alerts yet</p>
          <p className="text-sm text-center max-w-[280px]">
            Upload papers and generate feeds — Ficino will surface contradictions, patterns, and insights
          </p>
        </div>
      ) : (
        <div>
          {alerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onMarkRead={() => onMarkRead(alert.id)}
              onDismiss={() => onDismiss(alert.id)}
              onAction={getAlertAction(alert)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
