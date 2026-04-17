import { useRef } from 'react'
import { X } from 'lucide-react'
import { PaperUpload } from '../Upload/PaperUpload'
import { CorpusPanel } from '../Sidebar/CorpusPanel'
import { PersonaPanel } from '../Sidebar/PersonaPanel'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { Paper } from '../../types'

interface MobileDrawerProps {
  open: boolean
  onClose: () => void
  corpus: {
    papers: Paper[]
    loading: boolean
    uploading: boolean
    error: string | null
    upload: (file: File) => Promise<void>
    remove: (id: string) => void
    refresh: () => void
  }
  enabledPersonas: Record<string, boolean>
  activeTag: string | null
  onTagFilter: (tag: string | null) => void
  paperSummaries?: Map<string, string>
  onPaperClick?: (paperId: string) => void
}

export function MobileDrawer({
  open, onClose, corpus, enabledPersonas, activeTag, onTagFilter,
  paperSummaries, onPaperClick,
}: MobileDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(open, dialogRef)

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-50"
        onClick={onClose}
      />

      {/* Drawer */}
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Corpus management" className="fixed top-0 left-0 bottom-0 w-[300px] max-w-[85vw] bg-bg z-50 overflow-y-auto animate-slide-right border-r border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
          <div className="flex items-center gap-2.5">
            <img
              src={`${import.meta.env.BASE_URL}ficino-favicon-light.png`}
              alt=""
              className="w-8 h-8 rounded-lg app-logo"
            />
            <span
              className="text-lg font-semibold text-text tracking-[0.015em]"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
            >
              ficino
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close drawer"
            className="w-10 h-10 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover"
          >
            <X size={18} className="text-text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          <PaperUpload onUpload={corpus.upload} uploading={corpus.uploading} error={corpus.error} />

          <CorpusPanel
            papers={corpus.papers}
            loading={corpus.loading}
            onDelete={corpus.remove}
            onRefresh={corpus.refresh}
            activeTag={activeTag}
            onTagFilter={(tag) => { onTagFilter(tag); onClose() }}
            paperSummaries={paperSummaries}
            onPaperClick={onPaperClick ? (id) => { onPaperClick(id); onClose() } : undefined}
          />

          <PersonaPanel enabledPersonas={enabledPersonas} />
        </div>
      </div>

      <style>{`
        @keyframes slideRight {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-right {
          animation: slideRight 0.2s ease-out;
        }
      `}</style>
    </>
  )
}
