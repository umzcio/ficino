import { useState } from 'react'
import { ChevronRight, Trash2, Loader2, CheckCircle, AlertCircle, Plus, X } from 'lucide-react'
import type { Paper, PaperStatus } from '../../types'
import { assignTag, unassignTag } from '../../lib/api'

interface CorpusPanelProps {
  papers: Paper[]
  loading: boolean
  onDelete: (paperId: string) => void
  onRefresh: () => void
  activeTag: string | null
  onTagFilter: (tag: string | null) => void
}

const STATUS_CONFIG: Record<PaperStatus, { label: string; color: string; icon?: 'loading' | 'done' | 'error' }> = {
  pending:            { label: 'Pending',    color: '#555d6e', icon: 'loading' },
  extracting:         { label: 'Extracting', color: '#f5a623', icon: 'loading' },
  quality_checking:   { label: 'Checking',   color: '#f5a623', icon: 'loading' },
  chunking:           { label: 'Chunking',   color: '#4a9eff', icon: 'loading' },
  embedding:          { label: 'Embedding',  color: '#a78bfa', icon: 'loading' },
  extracting_figures: { label: 'Figures',    color: '#a78bfa', icon: 'loading' },
  complete:           { label: 'Ready',      color: '#34d399', icon: 'done' },
  error:              { label: 'Error',      color: '#e85d4a', icon: 'error' },
}

function StatusBadge({ status }: { status: PaperStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded"
      style={{
        color: config.color,
        backgroundColor: config.color + '15',
        border: `1px solid ${config.color}30`,
      }}
    >
      {config.icon === 'loading' && <Loader2 size={10} className="animate-spin" />}
      {config.icon === 'done' && <CheckCircle size={10} />}
      {config.icon === 'error' && <AlertCircle size={10} />}
      {config.label}
    </span>
  )
}

function TagBadge({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gold bg-gold/8 border border-gold/20 rounded px-1.5 py-0.5">
      <span className="text-gold/50">#</span>{name}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="bg-transparent border-none cursor-pointer p-0 flex items-center text-gold/50 hover:text-gold"
        >
          <X size={9} />
        </button>
      )}
    </span>
  )
}

function AddTagInput({ paperId, onDone }: { paperId: string; onDone: () => void }) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    const name = value.trim()
    if (!name) return
    setSaving(true)
    try {
      await assignTag(paperId, name)
      setValue('')
      onDone()
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1 mt-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onDone() }}
        placeholder="tag name"
        autoFocus
        className="bg-transparent border border-border rounded px-1.5 py-0.5 text-[11px] text-text w-[80px] outline-none focus:border-gold/40"
      />
      {saving ? (
        <Loader2 size={10} className="text-gold animate-spin" />
      ) : (
        <button
          onClick={handleSubmit}
          className="bg-transparent border-none cursor-pointer p-0 text-gold hover:text-gold/80"
        >
          <CheckCircle size={12} />
        </button>
      )}
    </div>
  )
}

export function CorpusPanel({ papers, loading, onDelete, onRefresh, activeTag, onTagFilter }: CorpusPanelProps) {
  const [addingTagFor, setAddingTagFor] = useState<string | null>(null)

  // Collect all unique tags across papers
  const allTags = [...new Set(papers.flatMap((p) => p.tags?.map((t) => t.name) || []))].sort()

  const handleRemoveTag = async (paperId: string, tagId: string) => {
    await unassignTag(paperId, tagId)
    onRefresh()
  }

  if (loading) {
    return (
      <div className="bg-bg-hover border border-border rounded-2xl p-4">
        <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
          Active Corpus
        </div>
        <div className="flex items-center justify-center py-4">
          <Loader2 size={20} className="text-text-muted animate-spin" />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-bg-hover border border-border rounded-2xl p-4">
      <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
        Active Corpus
      </div>

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3 pb-3 border-b border-border">
          <button
            onClick={() => onTagFilter(null)}
            className="text-[11px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors"
            style={{
              color: activeTag === null ? '#080a0f' : '#8b92a5',
              backgroundColor: activeTag === null ? '#c8a96e' : 'transparent',
              borderColor: activeTag === null ? '#c8a96e' : '#1e2028',
            }}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => onTagFilter(activeTag === tag ? null : tag)}
              className="text-[11px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors"
              style={{
                color: activeTag === tag ? '#080a0f' : '#c8a96e',
                backgroundColor: activeTag === tag ? '#c8a96e' : 'transparent',
                borderColor: activeTag === tag ? '#c8a96e' : '#c8a96e30',
              }}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {papers.length === 0 ? (
        <p className="text-xs text-text-muted py-3 text-center">
          No papers uploaded yet
        </p>
      ) : (
        papers
          .filter((p) => !activeTag || p.tags?.some((t) => t.name === activeTag))
          .map((paper, i, filtered) => (
          <div
            key={paper.id}
            className="py-2 group"
            style={{ borderBottom: i < filtered.length - 1 ? '1px solid #1e2028' : 'none' }}
          >
            <div className="flex justify-between items-start">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-text font-semibold mb-0.5 truncate">
                  {paper.title || paper.filename}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge status={paper.status} />
                  {paper.status === 'complete' && (
                    <span className="text-xs text-text-muted">{paper.chunk_count} chunks</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-2 shrink-0">
                <button
                  onClick={() => onDelete(paper.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-persona-skeptic/10 transition-all"
                >
                  <Trash2 size={12} className="text-persona-skeptic" />
                </button>
                <ChevronRight size={14} className="text-text-muted" />
              </div>
            </div>

            {/* Tags row */}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {paper.tags?.map((tag) => (
                <TagBadge
                  key={tag.id}
                  name={tag.name}
                  onRemove={() => handleRemoveTag(paper.id, tag.id)}
                />
              ))}
              {addingTagFor === paper.id ? (
                <AddTagInput
                  paperId={paper.id}
                  onDone={() => { setAddingTagFor(null); onRefresh() }}
                />
              ) : (
                <button
                  onClick={() => setAddingTagFor(paper.id)}
                  className="inline-flex items-center gap-0.5 text-[10px] text-text-muted hover:text-gold bg-transparent border border-dashed border-border hover:border-gold/30 rounded px-1 py-0.5 cursor-pointer transition-colors"
                >
                  <Plus size={8} />
                  #
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
