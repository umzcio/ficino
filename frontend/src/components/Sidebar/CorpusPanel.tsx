import { useState } from 'react'
import { ChevronRight, ChevronDown, Trash2, Loader2, CheckCircle, AlertCircle, Plus, X, MessageCircle } from 'lucide-react'
import type { Paper, PaperStatus } from '../../types'
import { assignTag, unassignTag } from '../../lib/api'

interface CorpusPanelProps {
  papers: Paper[]
  loading: boolean
  onDelete: (paperId: string) => void
  onRefresh: () => void
  activeTag: string | null
  onTagFilter: (tag: string | null) => void
  paperSummaries?: Map<string, string>
  onPaperClick?: (paperId: string) => void
}

const STATUS_CONFIG: Record<PaperStatus, { label: string; color: string; icon?: 'loading' | 'done' | 'error' }> = {
  pending:            { label: 'Pending',    color: 'var(--color-tab-inactive)', icon: 'loading' },
  extracting:         { label: 'Extracting', color: 'var(--color-persona-hype)', icon: 'loading' },
  quality_checking:   { label: 'Checking',   color: 'var(--color-persona-hype)', icon: 'loading' },
  chunking:           { label: 'Chunking',   color: 'var(--color-persona-practitioner)', icon: 'loading' },
  embedding:          { label: 'Embedding',  color: 'var(--color-persona-methodologist)', icon: 'loading' },
  extracting_figures: { label: 'Figures',    color: 'var(--color-persona-methodologist)', icon: 'loading' },
  complete:           { label: 'Ready',      color: 'var(--color-persona-gradstudent)', icon: 'done' },
  error:              { label: 'Error',      color: 'var(--color-persona-skeptic)', icon: 'error' },
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
          aria-label={`Remove tag ${name}`}
          className="bg-transparent border-none cursor-pointer p-1 -mr-0.5 flex items-center text-gold/50 hover:text-gold"
        >
          <X size={11} />
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
          aria-label="Add tag"
          className="bg-transparent border-none cursor-pointer p-0 text-gold hover:text-gold/80"
        >
          <CheckCircle size={12} />
        </button>
      )}
    </div>
  )
}

function PaperCard({
  paper, tldr, expanded, onToggle, onDelete, onRefresh, onPaperClick, addingTag, setAddingTag,
}: {
  paper: Paper
  tldr?: string
  expanded: boolean
  onToggle: () => void
  onDelete: () => void
  onRefresh: () => void
  onPaperClick?: () => void
  addingTag: boolean
  setAddingTag: (v: boolean) => void
}) {
  const isComplete = paper.status === 'complete'
  const isProcessing = !isComplete && paper.status !== 'error'

  const handleRemoveTag = async (tagId: string) => {
    await unassignTag(paper.id, tagId)
    onRefresh()
  }

  return (
    <div className="py-2 group">
      {/* Headline row — clickable. A real <button> so keyboard and SR
          users can expand a paper to manage tags, open the summary, or
          delete. Reset the native button styling with bg-transparent /
          border-none / p-0 / text-left so the expanded layout below
          (which assumes block-level children) renders unchanged. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-start gap-2 cursor-pointer w-full text-left bg-transparent border-none p-0"
      >
        <div className="flex-1 min-w-0">
          {/* Category tag from paper tags */}
          {paper.tags && paper.tags.length > 0 && (
            <div className="text-[11px] text-gold/60 mb-0.5">
              {paper.tags.map(t => `#${t.name}`).join(' · ')}
            </div>
          )}
          {/* Title as headline */}
          <div className="text-[13px] text-text font-semibold leading-snug">
            {paper.title || paper.filename}
          </div>
          {/* TL;DR teaser or status */}
          {isComplete && tldr ? (
            <p className="text-[12px] text-text-muted leading-snug mt-0.5 line-clamp-2">
              {tldr}
            </p>
          ) : isProcessing ? (
            <div className="mt-1">
              <StatusBadge status={paper.status} />
            </div>
          ) : paper.status === 'error' ? (
            <div className="mt-1">
              <StatusBadge status={paper.status} />
              {paper.error_message && (
                <p className="text-[11px] text-persona-skeptic/80 mt-1 leading-snug">
                  {paper.error_message}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-text-muted mt-0.5">
              {paper.chunk_count} chunks · {paper.figure_count} figures
            </p>
          )}
        </div>
        <div className="shrink-0 mt-0.5" aria-hidden="true">
          {expanded ? (
            <ChevronDown size={14} className="text-text-muted" />
          ) : (
            <ChevronRight size={14} className="text-text-muted" />
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-2 pl-0">
          {/* Full TL;DR */}
          {isComplete && tldr && (
            <div className="border-l-2 border-gold/20 pl-3 mb-2">
              <p className="text-[12px] text-text-mid leading-relaxed">{tldr}</p>
            </div>
          )}

          {/* Stats */}
          {isComplete && (
            <div className="flex items-center gap-3 text-[11px] text-text-muted mb-2">
              <span>{paper.chunk_count} chunks</span>
              {paper.figure_count > 0 && <span>{paper.figure_count} figures</span>}
              {paper.authors && paper.authors.length > 0 && (
                <span>{paper.authors.slice(0, 2).join(', ')}{paper.authors.length > 2 ? ' et al.' : ''}</span>
              )}
            </div>
          )}

          {/* Tags */}
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            {paper.tags?.map((tag) => (
              <TagBadge
                key={tag.id}
                name={tag.name}
                onRemove={() => handleRemoveTag(tag.id)}
              />
            ))}
            {addingTag ? (
              <AddTagInput
                paperId={paper.id}
                onDone={() => { setAddingTag(false); onRefresh() }}
              />
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setAddingTag(true) }}
                className="inline-flex items-center gap-0.5 text-[10px] text-text-muted hover:text-gold bg-transparent border border-dashed border-border hover:border-gold/30 rounded px-1 py-0.5 cursor-pointer transition-colors"
              >
                <Plus size={8} />
                #
              </button>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {isComplete && onPaperClick && (
              <button
                onClick={(e) => { e.stopPropagation(); onPaperClick() }}
                className="inline-flex items-center gap-1.5 text-[11px] text-gold bg-gold/8 border border-gold/20 rounded-lg px-2.5 py-1 cursor-pointer hover:bg-gold/15 transition-colors font-medium"
              >
                <MessageCircle size={10} />
                View summary
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-persona-skeptic bg-transparent border border-border hover:border-persona-skeptic/30 rounded-lg px-2 py-1 cursor-pointer transition-colors"
            >
              <Trash2 size={10} />
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function CorpusPanel({ papers, loading, onDelete, onRefresh, activeTag, onTagFilter, paperSummaries, onPaperClick }: CorpusPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addingTagFor, setAddingTagFor] = useState<string | null>(null)

  // Collect all unique tags across papers
  const allTags = [...new Set(papers.flatMap((p) => p.tags?.map((t) => t.name) || []))].sort()

  if (loading) {
    return (
      <div className="bg-bg-hover border border-border rounded-2xl p-4">
        <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
          What's happening
        </div>
        <div className="flex items-center justify-center py-4">
          <Loader2 size={20} className="text-text-muted animate-spin" />
        </div>
      </div>
    )
  }

  const filtered = papers.filter((p) => !activeTag || p.tags?.some((t) => t.name === activeTag))

  return (
    <div className="bg-bg-hover border border-border rounded-2xl p-4">
      <div className="text-[13px] font-bold text-gold tracking-widest uppercase mb-3">
        What's happening
      </div>

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3 pb-3 border-b border-border">
          <button
            onClick={() => onTagFilter(null)}
            className="text-[11px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors"
            style={{
              color: activeTag === null ? 'var(--color-bg)' : 'var(--color-text-mid)',
              backgroundColor: activeTag === null ? 'var(--color-gold)' : 'transparent',
              borderColor: activeTag === null ? 'var(--color-gold)' : 'var(--color-border)',
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
                color: activeTag === tag ? 'var(--color-bg)' : 'var(--color-gold)',
                backgroundColor: activeTag === tag ? 'var(--color-gold)' : 'transparent',
                borderColor: activeTag === tag ? 'var(--color-gold)' : 'color-mix(in srgb, var(--color-gold) 19%, transparent)',
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
      ) : filtered.length === 0 ? (
        <p className="text-xs text-text-muted py-3 text-center">
          No papers match #{activeTag}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map((paper) => (
            <PaperCard
              key={paper.id}
              paper={paper}
              tldr={paperSummaries?.get(paper.id)}
              expanded={expandedId === paper.id}
              onToggle={() => setExpandedId(expandedId === paper.id ? null : paper.id)}
              onDelete={() => onDelete(paper.id)}
              onRefresh={onRefresh}
              onPaperClick={onPaperClick ? () => onPaperClick(paper.id) : undefined}
              addingTag={addingTagFor === paper.id}
              setAddingTag={(v) => setAddingTagFor(v ? paper.id : null)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
