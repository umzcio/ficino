import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, FileText, Loader2 } from 'lucide-react'
import type { PaperSummary, SummaryMessage } from '../../types'
import { getPaperSummary, getPaperSummaryStatus } from '../../lib/api'

interface PaperChatProps {
  paperId: string
  onBack: () => void
}

const TYPE_LABELS: Record<string, string> = {
  tldr: 'TL;DR',
  intro: 'Overview',
  question: 'Research Question',
  methods: 'Methodology',
  findings: 'Key Findings',
  surprise: 'What Stood Out',
  limitations: 'Limitations',
  implications: 'Why It Matters',
  figure: 'Figure Highlight',
  summary: 'Summary',
}

const TYPE_COLORS: Record<string, string> = {
  tldr: 'var(--color-gold)',
  intro: 'var(--color-text-mid)',
  question: 'var(--color-persona-practitioner)',
  methods: 'var(--color-persona-methodologist)',
  findings: 'var(--color-persona-gradstudent)',
  surprise: 'var(--color-persona-hype)',
  limitations: 'var(--color-persona-skeptic)',
  implications: 'var(--color-persona-practitioner)',
  figure: 'var(--color-gold)',
  summary: 'var(--color-gold)',
}

function MessageBubble({ message }: { message: SummaryMessage }) {
  const label = TYPE_LABELS[message.type] || message.type
  const color = TYPE_COLORS[message.type] || 'var(--color-gold)'
  const isTldr = message.type === 'tldr'

  if (isTldr) {
    return (
      <div className="mx-4 my-2 p-4 rounded-xl border" style={{ backgroundColor: 'color-mix(in srgb, var(--color-gold) 4%, transparent)', borderColor: 'color-mix(in srgb, var(--color-gold) 15%, transparent)' }}>
        <span className="text-[11px] font-bold tracking-widest uppercase text-gold">TL;DR</span>
        <p className="text-[16px] text-text font-semibold leading-snug mt-1.5">
          {message.content}
        </p>
      </div>
    )
  }

  return (
    <div className="flex gap-3 px-4 py-2">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1"
        style={{ backgroundColor: color + '18', border: `1.5px solid ${color}40` }}
      >
        <FileText size={14} style={{ color }} />
      </div>
      <div className="flex-1 min-w-0">
        <span
          className="text-[11px] font-semibold tracking-wide uppercase"
          style={{ color }}
        >
          {label}
        </span>
        <p className="text-[14px] text-text leading-relaxed mt-0.5 whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    </div>
  )
}

export function PaperChat({ paperId, onBack }: PaperChatProps) {
  const [summary, setSummary] = useState<PaperSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError(null)
      const data = await getPaperSummary(paperId)
      if (!active) return
      setSummary(data)

      if (data.status === 'generating' && data.task_id) {
        // Poll for completion. The poll loop must handle terminal non-complete
        // states (error / unknown) or the spinner runs forever when the worker
        // has already given up — the API returns `{status: 'error', error: ...}`
        // when the Celery task faulted, and we used to just re-schedule the
        // poll and spin.
        const poll = async () => {
          try {
            const status = await getPaperSummaryStatus(paperId, data.task_id!)
            if (!active) return
            if (status.status === 'complete') {
              const updated = await getPaperSummary(paperId)
              if (!active) return
              setSummary(updated)
              setLoading(false)
            } else if (status.status === 'error' || status.status === 'unknown') {
              setError(status.error || 'Summary generation failed')
              setLoading(false)
            } else {
              timeoutRef.current = setTimeout(poll, 2000)
            }
          } catch (e) {
            if (!active) return
            setError(e instanceof Error ? e.message : 'Failed to check summary status')
            setLoading(false)
          }
        }
        timeoutRef.current = setTimeout(poll, 2000)
      } else {
        setLoading(false)
      }
    }
    load()

    return () => {
      active = false
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [paperId])

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3 flex items-center gap-3">
        <button
          onClick={onBack}
          aria-label="Go back"
          className="w-10 h-10 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors"
        >
          <ArrowLeft size={18} className="text-text" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] text-text truncate">
            {summary?.title || 'Loading...'}
          </div>
          {summary?.authors && summary.authors.length > 0 && (
            <div className="text-xs text-text-muted truncate">
              {summary.authors.slice(0, 3).join(', ')}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      {error ? (
        <div role="alert" className="flex flex-col items-center justify-center py-20 gap-3 px-6 text-center">
          <p className="text-sm text-text">Summary generation failed</p>
          <p className="text-xs text-text-muted">{error}</p>
        </div>
      ) : loading || (summary?.status === 'generating') ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 size={28} className="text-gold animate-spin" />
          <p className="text-sm text-text-muted">
            {summary?.messages?.length === 0 ? 'Generating summary...' : 'Loading...'}
          </p>
          <p className="text-xs text-text-subtle">This may take 30-60 seconds</p>
        </div>
      ) : summary?.messages && summary.messages.length > 0 ? (
        <div className="py-3 space-y-3">
          {/* Paper intro card */}
          <div className="mx-4 p-3 bg-bg-hover border border-border rounded-xl">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-6 h-6 rounded-md bg-gold/15 flex items-center justify-center">
                <FileText size={12} className="text-gold" />
              </div>
              <span className="text-xs font-semibold text-gold tracking-wide uppercase">Paper Summary</span>
            </div>
            <p className="text-[13px] text-text-muted">
              This paper has {summary.messages.length} key takeaways for you.
            </p>
          </div>

          {summary.messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}

          <div className="px-4 py-3 text-center">
            <span className="text-xs text-text-subtle">End of summary</span>
          </div>
        </div>
      ) : (
        <div className="py-16 text-center text-text-muted text-sm">
          No summary available.
        </div>
      )}
    </div>
  )
}
