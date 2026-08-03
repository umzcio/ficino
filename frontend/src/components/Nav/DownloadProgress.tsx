import { useState, useEffect } from 'react'
import { X, Check, Download, Loader2 } from 'lucide-react'
import type { DownloadProgress as Progress } from '../../lib/workspace-download'

interface Props {
  progress: Progress | null
  workspaceName: string
  onClose: () => void
  onCancel: () => void
}

export function DownloadProgress({ progress, workspaceName, onClose, onCancel }: Props) {
  // Mount-entrance flag, same data-mounted pattern as _shared/FadeIn:
  // render hidden, flip the attribute after one frame so the CSS
  // transition has something to interpolate from.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // `progress.done` flips long after mount, so the success branch needs
  // its own mount flag for its entrance.
  const done = progress?.done
  const [doneMounted, setDoneMounted] = useState(false)
  useEffect(() => {
    if (!done) return
    const id = requestAnimationFrame(() => setDoneMounted(true))
    return () => cancelAnimationFrame(id)
  }, [done])

  if (!progress) return null

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <div
      data-mounted={mounted || undefined}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm opacity-0 transition-opacity duration-200 ease-out data-[mounted]:opacity-100"
    >
      <div
        data-mounted={mounted || undefined}
        className="bg-bg border border-border rounded-xl w-[340px] shadow-xl opacity-0 scale-[0.97] transition-[opacity,transform] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none data-[mounted]:opacity-100 data-[mounted]:scale-100"
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div className="flex items-center gap-2 text-text font-medium text-sm">
            <Download size={16} className="text-gold" />
            <span>Download for offline</span>
          </div>
          <button
            onClick={progress.done ? onClose : onCancel}
            className="text-text-secondary hover:text-text bg-transparent border-none cursor-pointer p-1"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pb-4">
          <p className="text-xs text-text-muted mb-3 truncate">{workspaceName}</p>

          {progress.done ? (
            <div
              data-mounted={doneMounted || undefined}
              className="flex items-center gap-2 text-sm text-green-400 py-2 opacity-0 transition-opacity duration-150 ease-out data-[mounted]:opacity-100"
            >
              <span className="inline-flex scale-90 transition-transform duration-200 ease-[var(--ease-out)] motion-reduce:transition-none data-[mounted]:scale-100" data-mounted={doneMounted || undefined}>
                <Check size={16} />
              </span>
              <span>Ready for offline use</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-text-secondary mb-2">
                <Loader2 size={14} className="animate-spin text-gold" />
                <span>{progress.step}...</span>
                <span className="ml-auto text-text-muted text-xs">{pct}%</span>
              </div>
              <div className="h-1.5 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{
                    width: `${pct}%`,
                    background: 'linear-gradient(90deg, var(--color-gold), var(--color-gold-dark))',
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
