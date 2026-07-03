import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, FileText, Loader2 } from 'lucide-react'
import type { PaperSummary, SummaryMessage } from '../../types'
import { getPaperSummary, getPaperSummaryStatus } from '../../lib/api'
import { cachePaperSummary, getCachedPaperSummary } from '../../lib/offline-cache'
import { usePollTask, type PollController } from '../../hooks/usePollTask'

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
  const poll = usePollTask()
  const pollControllerRef = useRef<PollController | null>(null)

  useEffect(() => {
    // Per-effect-run cancellation flag — distinct from usePollTask's own
    // mount tracking. usePollTask only gates its isDone/onDone/onError
    // dispatch; it can't gate the nested `await getPaperSummary(paperId)`
    // inside onDone below, which can resolve after paperId has already
    // changed to a new effect run (or after unmount).
    let active = true
    async function load() {
      setLoading(true)
      setError(null)
      // R10 FE-5: this initial fetch used to be a bare `await` with no
      // try/catch — a transient 5xx / offline rejection escaped as an
      // unhandled promise rejection, `setLoading` never flipped back to
      // false, and the view spun forever with no way out short of a full
      // reload. Mirrors Inbox.tsx's try/catch/finally shape.
      try {
        const data = await getPaperSummary(paperId)
        if (!active) return
        // Only cache a *complete* summary — a mid-generation snapshot
        // (few/no messages) would clobber a previously-cached complete
        // one and make the offline fallback regress instead of help.
        if (data.status === 'complete') {
          cachePaperSummary(data).catch(() => {})
        }
        setSummary(data)

        if (data.status === 'generating' && data.task_id) {
          const taskId = data.task_id
          // R10 DUP-11: canonical usePollTask poller. The loop must handle
          // terminal non-complete states (error / unknown) or the spinner
          // runs forever when the worker has already given up — the API
          // returns `{status: 'error', error: ...}` when the Celery task
          // faulted, and we used to just re-schedule the poll and spin.
          pollControllerRef.current = poll<{ status: string; error?: string }>({
            fn: () => getPaperSummaryStatus(paperId, taskId),
            isDone: (status) => status.status === 'complete' || status.status === 'error' || status.status === 'unknown',
            onDone: async (status) => {
              if (status.status === 'complete') {
                // R10 wave-4 final-review: this getPaperSummary(...) used to
                // be a bare await inside onDone — a transient failure here
                // left `loading` stuck true forever (spinner with no way
                // out). Mirror the onError branch below: surface it as an
                // error instead of spinning.
                try {
                  const updated = await getPaperSummary(paperId)
                  if (!active) return
                  cachePaperSummary(updated).catch(() => {})
                  setSummary(updated)
                  setLoading(false)
                } catch (err) {
                  if (!active) return
                  setError(err instanceof Error ? err.message : 'Failed to load generated summary')
                  setLoading(false)
                }
              } else {
                setError(status.error || 'Summary generation failed')
                setLoading(false)
              }
            },
            // A rejected getPaperSummaryStatus (network failure, not a
            // terminal status field) stops the chain outright rather than
            // retrying — matches the original's catch-and-stop behavior.
            onError: (e) => {
              if (!active) return
              setError(e instanceof Error ? e.message : 'Failed to check summary status')
              setLoading(false)
            },
            maxAttempts: 1,
            intervalMs: 2000,
          })
        }
      } catch (err) {
        if (!active) return
        // Offline fallback: fall back to the last cached summary rather
        // than surfacing the error branch when we have one to show.
        let usedCache = false
        try {
          const cached = await getCachedPaperSummary(paperId)
          if (active && cached) {
            setSummary(cached)
            usedCache = true
          }
        } catch { /* IDB unavailable — fall through to the error state */ }
        if (!usedCache) {
          setError(err instanceof Error ? err.message : 'Failed to load paper summary')
        }
      } finally {
        // Runs even on the `generating` path above — harmless there since
        // the render below also gates the spinner on
        // `summary?.status === 'generating'`, which stays true until the
        // poll's onDone/onError fires and calls setLoading(false) itself.
        if (active) setLoading(false)
      }
    }
    load()

    return () => {
      active = false
      pollControllerRef.current?.stop()
    }
  }, [paperId, poll])

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
        // aria-live so SR users who opened this view hear that summary
        // generation is underway. Without the live region the 30-60s
        // wait is silent. aria-busy signals "content being produced".
        <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 size={28} className="text-gold animate-spin" aria-hidden="true" />
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
