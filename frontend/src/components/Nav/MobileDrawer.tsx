import { useEffect, useRef, useState } from 'react'
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
  const [mounted, setMounted] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  // Exit plays, then we hand off to the parent. 160ms matches the exit
  // duration. Parent-initiated closes (open flips to false from outside)
  // still unmount instantly — documented limitation.
  const requestClose = () => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 160)
  }

  // Esc closes the drawer from inside any child input. The global
  // keyboard-shortcut handler skips Esc when focus is on an INPUT/
  // TEXTAREA tag, so a user with focus on the upload filename input
  // (or any other input inside this drawer) was previously trapped
  // with no keyboard way out. Dialog-scoped listener bypasses that rule.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* Backdrop. aria-hidden so SR users focus the dialog itself
          rather than the click-catching overlay. */}
      <div
        aria-hidden="true"
        className={`fixed inset-0 bg-black/60 z-50 transition-opacity duration-200 ease-out ${
          closing || !mounted ? 'opacity-0' : 'opacity-100'
        }`}
        onClick={requestClose}
      />

      {/* Drawer */}
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Corpus management" className={`fixed top-0 left-0 bottom-0 w-[min(320px,88vw)] bg-bg z-50 overflow-y-auto border-r border-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] motion-reduce:transition-none transition-transform ease-[var(--ease-drawer)] starting:translate-x-[-100%] ${
        closing
          ? 'translate-x-[-100%] duration-[160ms]'
          : mounted
            ? 'translate-x-0 duration-[200ms]'
            : 'translate-x-[-100%] duration-[200ms]'
      }`}>
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
            onClick={requestClose}
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
            onTagFilter={(tag) => { onTagFilter(tag); requestClose() }}
            paperSummaries={paperSummaries}
            onPaperClick={onPaperClick ? (id) => { onPaperClick(id); requestClose() } : undefined}
          />

          <PersonaPanel enabledPersonas={enabledPersonas} />
        </div>
      </div>
    </>
  )
}
