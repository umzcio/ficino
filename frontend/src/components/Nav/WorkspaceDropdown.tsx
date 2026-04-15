import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Folder, Check, Plus, Trash2, Pencil, Download } from 'lucide-react'
import type { Workspace } from '../../types'

interface WorkspaceDropdownProps {
  workspaces: Workspace[]
  active: Workspace | null
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onDownload?: (id: string) => void
}

export function WorkspaceDropdown({ workspaces, active, onSwitch, onCreate, onDelete, onRename, onDownload }: WorkspaceDropdownProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  if (!active || workspaces.length <= 1) return null

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[13px] text-text-muted hover:text-gold bg-transparent border-none cursor-pointer transition-colors px-0"
      >
        <Folder size={11} />
        <span className="max-w-[120px] truncate">{active.name}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 w-[220px] bg-bg border border-border rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 text-[11px] text-text-muted font-semibold tracking-wider uppercase border-b border-border">
            Workspaces
          </div>
          {workspaces.map((ws) => (
            <div key={ws.id} className="flex items-center group hover:bg-bg-hover transition-colors">
              {renamingId === ws.id ? (
                <div className="flex-1 px-3 py-2">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && renameValue.trim()) {
                        onRename(ws.id, renameValue.trim())
                        setRenamingId(null)
                      }
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    autoFocus
                    className="w-full bg-transparent border border-border rounded px-2 py-1 text-xs text-text outline-none focus:border-gold/40"
                  />
                </div>
              ) : (
                <>
                  <button
                    onClick={() => { onSwitch(ws.id); setOpen(false) }}
                    className="flex-1 text-left px-3 py-2.5 flex items-center gap-2.5 bg-transparent border-none cursor-pointer"
                  >
                    <Folder size={14} style={{ color: ws.id === active.id ? 'var(--color-gold)' : 'var(--color-tab-inactive)' }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-text truncate">{ws.name}</div>
                      <div className="text-[11px] text-text-muted">{ws.paper_count} papers</div>
                    </div>
                    {ws.id === active.id && <Check size={14} className="text-gold shrink-0" />}
                  </button>
                  {ws.name !== 'Default' && (
                    <div className="flex items-center gap-0.5 pr-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      {onDownload && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDownload(ws.id); setOpen(false) }}
                          aria-label={`Download ${ws.name} for offline`}
                          className="p-1 rounded hover:bg-gold/10 bg-transparent border-none cursor-pointer"
                        >
                          <Download size={12} className="text-text-muted" />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setRenamingId(ws.id); setRenameValue(ws.name) }}
                        aria-label={`Rename ${ws.name}`}
                        className="p-1 rounded hover:bg-gold/10 bg-transparent border-none cursor-pointer"
                      >
                        <Pencil size={12} className="text-text-muted" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(ws.id); setOpen(false) }}
                        aria-label={`Delete ${ws.name}`}
                        className="p-1 rounded hover:bg-persona-skeptic/10 bg-transparent border-none cursor-pointer"
                      >
                        <Trash2 size={12} className="text-persona-skeptic" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          <div className="border-t border-border">
            {creating ? (
              <div className="p-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newName.trim()) {
                      onCreate(newName.trim())
                      setNewName('')
                      setCreating(false)
                      setOpen(false)
                    }
                    if (e.key === 'Escape') { setCreating(false); setNewName('') }
                  }}
                  placeholder="Name..."
                  autoFocus
                  className="w-full bg-transparent border border-border rounded px-2 py-1.5 text-xs text-text outline-none focus:border-gold/40"
                />
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full text-left px-3 py-2.5 flex items-center gap-2.5 bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors text-gold"
              >
                <Plus size={14} />
                <span className="text-[13px] font-medium">New Workspace</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
