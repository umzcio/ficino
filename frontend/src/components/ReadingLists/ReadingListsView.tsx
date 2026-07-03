import { useState, useEffect, useCallback } from 'react'
import { Plus, BookOpen, ChevronRight, Loader2, Trash2 } from 'lucide-react'
import {
  listReadingLists, createReadingList, deleteReadingList,
  type ReadingListSummary,
} from '../../lib/api'
import { ReadingListDetail } from './ReadingListDetail'
import { Spinner, EmptyState } from '../_shared/AsyncState'

interface ReadingListsViewProps {
  workspaceId: string | null
}

export function ReadingListsView({ workspaceId }: ReadingListsViewProps) {
  const [lists, setLists] = useState<ReadingListSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedListId, setSelectedListId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const refresh = useCallback(async () => {
    try {
      const data = await listReadingLists(workspaceId || undefined)
      setLists(data)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [workspaceId])

  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async () => {
    if (!newName.trim() || !workspaceId) return
    setCreating(true)
    try {
      const { id } = await createReadingList(newName.trim(), workspaceId)
      setNewName('')
      await refresh()
      setSelectedListId(id)
    } catch { /* ignore */ }
    finally { setCreating(false) }
  }

  const handleDelete = async (listId: string) => {
    await deleteReadingList(listId)
    if (selectedListId === listId) setSelectedListId(null)
    refresh()
  }

  if (selectedListId) {
    return (
      <ReadingListDetail
        listId={selectedListId}
        onBack={() => { setSelectedListId(null); refresh() }}
      />
    )
  }

  return (
    <div>
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5">
        <h2 className="text-[20px] font-bold text-text">Reading Lists</h2>
        <p className="text-[13px] text-text-muted mt-0.5">Curated paper sequences with guided discourse</p>
      </div>

      {/* Create new */}
      <div className="px-4 py-4 border-b border-border">
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="New reading list name..."
            className="flex-1 bg-bg-hover border border-border rounded-lg px-3 py-2 text-[14px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 transition-colors"
            disabled={creating}
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim() || creating || !workspaceId}
            className="flex items-center gap-1.5 bg-gold text-bg text-[13px] font-semibold px-4 py-2 rounded-lg border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-30"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create
          </button>
        </div>
        <p className="text-[11px] text-text-muted mt-2">
          Creates a reading list from all papers in your workspace. The Archivist will propose an optimal reading order.
        </p>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={24} />
        </div>
      ) : lists.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No reading lists yet"
          hint={<p className="text-sm">Create one to get a guided path through your papers</p>}
        />
      ) : (
        <div>
          {lists.map((list) => (
            // Can't convert to a real <button> — the Delete control below
            // is a real button and nesting buttons is invalid HTML. Use
            // role="button" + tabIndex + Enter/Space handler so keyboard
            // users can open the list; Delete stays independently tabbable.
            <div
              key={list.id}
              role="button"
              tabIndex={0}
              aria-label={`Open reading list: ${list.name}`}
              className="flex items-center gap-3 px-4 py-3.5 border-b border-border hover:bg-bg-hover transition-colors cursor-pointer"
              onClick={() => setSelectedListId(list.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedListId(list.id)
                }
              }}
            >
              <BookOpen size={20} className="text-gold shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-semibold text-text truncate">{list.name}</div>
                <div className="text-[12px] text-text-muted">
                  {list.paper_count} papers · {list.completed_chapters}/{list.chapter_count} chapters complete
                </div>
              </div>
              <button
                aria-label={`Delete ${list.name}`}
                className="p-1.5 text-text-muted hover:text-persona-skeptic bg-transparent border-none cursor-pointer rounded-full hover:bg-bg-hover transition-colors"
                onClick={(e) => { e.stopPropagation(); handleDelete(list.id) }}
              >
                <Trash2 size={14} />
              </button>
              <ChevronRight size={16} className="text-text-muted shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
