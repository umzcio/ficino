import { useState } from 'react'
import { Folder, Check, Plus, X } from 'lucide-react'
import type { Workspace } from '../../types'

interface WorkspaceBottomSheetProps {
  workspaces: Workspace[]
  activeId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onClose: () => void
}

export function WorkspaceBottomSheet({
  workspaces, activeId, onSwitch, onCreate, onClose,
}: WorkspaceBottomSheetProps) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-50"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-2xl max-h-[70vh] overflow-y-auto animate-slide-up">
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3 border-b border-border">
          <h2 className="text-lg font-bold text-text">Workspaces</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover"
          >
            <X size={18} className="text-text-muted" />
          </button>
        </div>

        {/* Workspace list */}
        <div className="py-2">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => { onSwitch(ws.id); onClose() }}
              className="w-full text-left px-5 py-3.5 flex items-center gap-3 bg-transparent border-none cursor-pointer active:bg-bg-hover transition-colors"
            >
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{
                  background: ws.id === activeId
                    ? 'linear-gradient(135deg, #c8a96e, #a07840)'
                    : '#1e2028',
                }}
              >
                <Folder size={16} color={ws.id === activeId ? '#080a0f' : '#555d6e'} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-semibold text-text">{ws.name}</div>
                <div className="text-xs text-text-muted">
                  {ws.paper_count} paper{ws.paper_count !== 1 ? 's' : ''} · {ws.feed_count} feed{ws.feed_count !== 1 ? 's' : ''}
                </div>
              </div>
              {ws.id === activeId && (
                <div className="w-6 h-6 rounded-full bg-gold/15 flex items-center justify-center">
                  <Check size={14} className="text-gold" />
                </div>
              )}
            </button>
          ))}
        </div>

        {/* New workspace */}
        <div className="px-4 pb-6 border-t border-border pt-3">
          {creating ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) {
                    onCreate(newName.trim())
                    setNewName('')
                    setCreating(false)
                    onClose()
                  }
                  if (e.key === 'Escape') { setCreating(false); setNewName('') }
                }}
                placeholder="Workspace name..."
                autoFocus
                className="flex-1 bg-transparent border border-border rounded-lg px-3 py-2.5 text-sm text-text outline-none focus:border-gold/40"
              />
              <button
                onClick={() => {
                  if (newName.trim()) {
                    onCreate(newName.trim())
                    setNewName('')
                    setCreating(false)
                    onClose()
                  }
                }}
                className="px-4 py-2.5 rounded-lg text-sm font-semibold text-bg border-none cursor-pointer"
                style={{ background: 'linear-gradient(135deg, #c8a96e, #a07840)' }}
              >
                Create
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full py-3 rounded-xl border border-dashed border-border flex items-center justify-center gap-2 text-gold bg-transparent cursor-pointer hover:border-gold/30 transition-colors"
            >
              <Plus size={16} />
              <span className="text-sm font-medium">New Workspace</span>
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .animate-slide-up {
          animation: slideUp 0.25s ease-out;
        }
      `}</style>
    </>
  )
}
