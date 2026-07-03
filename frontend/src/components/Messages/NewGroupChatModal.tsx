import { useEffect, useRef, useState } from 'react'
import { X, Users } from 'lucide-react'
import { listPapers, createGroupChat } from '../../lib/api'
import type { Paper } from '../../types'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { Spinner, EmptyState } from '../_shared/AsyncState'

interface NewGroupChatModalProps {
  workspaceId?: string
  onClose: () => void
  // Called with the new synthesis_id once the backend accepts the create
  // request (202 — synthesis generation runs async). Caller navigates to
  // the group view immediately; GroupChatView's own poll/loading state
  // covers the "still generating" period.
  onCreated: (synthesisId: string) => void
}

// The backend rejects fewer than 2 papers (api/routers/messages.py
// create_group_chat: "Need at least 2 papers for a group chat") — a
// synthesis needs at least two viewpoints to compare.
const MIN_PAPERS = 2

export function NewGroupChatModal({ workspaceId, onClose, onCreated }: NewGroupChatModalProps) {
  const [papers, setPapers] = useState<Paper[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(true, dialogRef)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const all = await listPapers(workspaceId)
        if (!active) return
        // Only 'complete' papers have chunks to synthesize from — picking
        // a still-processing paper would just 404 the create call.
        setPapers(all.filter((p) => p.status === 'complete'))
      } catch (err) {
        if (active) setLoadError(err instanceof Error ? err.message : 'Failed to load papers')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [workspaceId])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canCreate = name.trim().length > 0 && selected.size >= MIN_PAPERS && !creating

  const handleCreate = async () => {
    if (!canCreate) return
    setCreating(true)
    setCreateError(null)
    try {
      const { synthesis_id } = await createGroupChat(name.trim(), Array.from(selected))
      onCreated(synthesis_id)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create group chat')
      setCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-group-chat-title"
        className="bg-bg border border-border rounded-xl w-full max-w-[420px] max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border">
          <h2 id="new-group-chat-title" className="text-[16px] font-bold text-text">New Group Chat</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-muted hover:text-text bg-transparent border-none cursor-pointer p-1"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-4 pt-3 pb-2">
          <label htmlFor="group-chat-name" className="block text-[11px] text-text-muted mb-1">
            Name
          </label>
          <input
            id="group-chat-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Trust & AI synthesis"
            autoFocus
            className="w-full bg-bg-hover border border-border rounded-lg px-3 py-2 text-[14px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
          />
        </div>

        <div className="px-4 pb-1 flex items-center justify-between">
          <span className="text-[11px] text-text-muted">Select at least {MIN_PAPERS} papers</span>
          <span className="text-[11px] text-gold">{selected.size} selected</span>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[160px]">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner size={22} />
            </div>
          ) : loadError ? (
            <div role="alert" className="px-2 py-6 text-center text-sm text-persona-skeptic">
              {loadError}
            </div>
          ) : papers.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No papers ready yet"
              hint={<p className="text-sm">Upload and process at least {MIN_PAPERS} papers to start a group chat</p>}
            />
          ) : (
            <ul className="space-y-1">
              {papers.map((p) => {
                const checked = selected.has(p.id)
                return (
                  <li key={p.id}>
                    <label className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-bg-hover cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(p.id)}
                        className="shrink-0 w-4 h-4 accent-gold cursor-pointer"
                      />
                      <span className="flex-1 min-w-0 text-[13px] text-text truncate">
                        {p.title || p.filename}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {createError && (
          <div role="alert" className="px-4 pb-2 text-[12px] text-persona-skeptic">
            {createError}
          </div>
        )}

        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={creating}
            className="px-3 py-1.5 rounded-lg text-[13px] text-text-muted bg-transparent border border-border cursor-pointer hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-semibold text-bg bg-gold border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-30"
          >
            {creating && <Spinner size={14} className="animate-spin text-bg" />}
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
