import { useState, useEffect } from 'react'
import { HardDrive, AlertTriangle, Download, Trash2, Check } from 'lucide-react'
import { clearAllFeeds, clearAllSummaries, clearAllUserPosts, clearAllPapers, clearEverything } from '../../lib/api'
import { estimateCacheSize, clearOfflineData, getLastSync } from '../../lib/workspace-download'
import type { Workspace } from '../../types'
import { Section, SettingRow, DangerButton, Loader2 } from './primitives'

interface Props {
  settings: Record<string, unknown>
  onUpdate: (partial: Record<string, unknown>) => void
  workspaces?: Workspace[]
  onDownloadWorkspace?: (id: string) => void
}

export function StorageTab({ onDownloadWorkspace, workspaces }: Props) {
  const [cacheSize, setCacheSize] = useState<string>('...')
  const [syncTimes, setSyncTimes] = useState<Record<string, number>>({})
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    estimateCacheSize().then(({ formatted }) => setCacheSize(formatted))
    if (workspaces) {
      Promise.all(
        workspaces.map(async (ws) => {
          const ts = await getLastSync(ws.id)
          return [ws.id, ts] as const
        })
      ).then((entries) => {
        const map: Record<string, number> = {}
        for (const [id, ts] of entries) {
          if (ts) map[id] = ts
        }
        setSyncTimes(map)
      })
    }
  }, [workspaces])

  const handleClear = async () => {
    setClearing(true)
    await clearOfflineData()
    setClearing(false)
    setCleared(true)
    setSyncTimes({})
    estimateCacheSize().then(({ formatted }) => setCacheSize(formatted))
    setTimeout(() => setCleared(false), 2000)
  }

  const formatAgo = (ts: number) => {
    const mins = Math.floor((Date.now() - ts) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  return (
    <div className="p-4 space-y-4">
      <Section icon={HardDrive} title="Offline & Storage">
        <SettingRow label="Cache Size" description="Total data stored for offline use">
          <span className="text-[13px] text-text-muted font-mono">{cacheSize}</span>
        </SettingRow>

        {workspaces && workspaces.length > 0 && (
          <div>
            <div className="text-[12px] text-text-muted font-medium mb-2">Workspaces</div>
            <div className="space-y-2">
              {workspaces.map((ws) => (
                <div key={ws.id} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-text truncate">{ws.name}</div>
                    <div className="text-[11px] text-text-muted">
                      {syncTimes[ws.id]
                        ? `Synced ${formatAgo(syncTimes[ws.id])}`
                        : 'Not downloaded'}
                    </div>
                  </div>
                  {onDownloadWorkspace && (
                    <button
                      onClick={() => onDownloadWorkspace(ws.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gold bg-transparent border border-gold/30 cursor-pointer hover:bg-gold/10 transition-colors"
                    >
                      <Download size={12} />
                      {syncTimes[ws.id] ? 'Sync' : 'Download'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <SettingRow label="Clear Offline Data" description="Remove all cached data from this device">
          {cleared ? (
            <span className="text-[13px] text-persona-gradstudent flex items-center gap-1">
              <Check size={14} /> Cleared
            </span>
          ) : (
            <button
              onClick={handleClear}
              disabled={clearing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-persona-skeptic bg-transparent border border-persona-skeptic/30 cursor-pointer hover:bg-persona-skeptic/10 transition-colors disabled:opacity-50"
            >
              {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Clear
            </button>
          )}
        </SettingRow>
      </Section>

      <Section icon={AlertTriangle} title="Danger Zone">
        <SettingRow label="Clear All Feeds" description="Delete all generated feeds. Bookmarks are preserved.">
          <DangerButton label="Clear Feeds" onConfirm={clearAllFeeds} />
        </SettingRow>

        <SettingRow label="Clear All Summaries" description="Delete all paper summaries. They will regenerate on next view.">
          <DangerButton label="Clear Summaries" onConfirm={clearAllSummaries} />
        </SettingRow>

        <SettingRow label="Clear All Conversations" description="Delete all your posts and The Archivist's replies.">
          <DangerButton label="Clear Conversations" onConfirm={clearAllUserPosts} />
        </SettingRow>

        <SettingRow label="Delete All Papers" description="Permanently remove every paper, its chunks, figures, summaries, and feeds. This cannot be undone.">
          <DangerButton label="Delete All Papers" onConfirm={clearAllPapers} />
        </SettingRow>

        <SettingRow label="Delete Everything" description="Wipe all user-generated content: papers, feeds, conversations, paper summaries, notifications, reading lists, and tags. Workspaces and account settings are kept. This cannot be undone.">
          <DangerButton label="Delete Everything" onConfirm={clearEverything} />
        </SettingRow>
      </Section>
    </div>
  )
}
