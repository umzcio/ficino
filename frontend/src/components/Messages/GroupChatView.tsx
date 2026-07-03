import { useState, useEffect } from 'react'
import { ArrowLeft, Users, FileText, Loader2, Zap, AlertTriangle, HelpCircle } from 'lucide-react'
import type { GroupChat, SummaryMessage } from '../../types'
import { getGroupChat, isNotFoundError, getApiErrorDetail } from '../../lib/api'
import { cacheGroupChat, getCachedGroupChat } from '../../lib/offline-cache'
import { usePollTask } from '../../hooks/usePollTask'

interface GroupChatViewProps {
  groupId: string
  onBack: () => void
}

const ROLE_CONFIG: Record<string, { icon: typeof FileText; color: string; label: string }> = {
  intro: { icon: FileText, color: 'var(--color-gold)', label: 'Paper' },
  finding: { icon: Zap, color: 'var(--color-persona-gradstudent)', label: 'Finding' },
  agreement: { icon: FileText, color: 'var(--color-persona-practitioner)', label: 'Agreement' },
  contradiction: { icon: AlertTriangle, color: 'var(--color-persona-skeptic)', label: 'Tension' },
  gap: { icon: HelpCircle, color: 'var(--color-persona-hype)', label: 'Gap' },
  summary: { icon: FileText, color: 'var(--color-persona-methodologist)', label: 'Synthesis' },
}

function SynthesisMessage({ message }: { message: SummaryMessage }) {
  const config = ROLE_CONFIG[message.type] || ROLE_CONFIG.summary
  const Icon = config.icon
  const isPaperSpeaking = message.role === 'paper'

  return (
    <div className={`flex gap-3 px-4 py-2 ${isPaperSpeaking ? '' : 'bg-bg-hover/50'}`}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1"
        style={{ backgroundColor: config.color + '18', border: `1.5px solid ${config.color}40` }}
      >
        {isPaperSpeaking ? (
          <FileText size={14} style={{ color: config.color }} />
        ) : (
          <Icon size={14} style={{ color: config.color }} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wide uppercase" style={{ color: config.color }}>
            {isPaperSpeaking ? (message.paper_ref || 'Paper') : config.label}
          </span>
        </div>
        <p className="text-[14px] text-text leading-relaxed mt-0.5 whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    </div>
  )
}

// Wave-5 Task 4: create_group_chat now inserts a status='generating'
// placeholder row right after dispatch (mirrors paper_summaries), so GET
// /messages/groups/{id} returns {status: 'generating'} with a 200 for the
// whole generation window instead of 404ing. The 404-retry loop below is
// now only a FALLBACK for rows created before that migration shipped (a
// pre-migration row whose synthesis was mid-flight at deploy time) — kept
// at the same cadence (25 attempts x 4s ≈ 100s) in case one is still in
// flight, but the fast path below never needs it.
const SYNTH_RETRY_MAX_ATTEMPTS = 25
const SYNTH_RETRY_INTERVAL_MS = 4000

// Exported for testing (this repo has no @testing-library/react — see
// usePollTask.ts — so component logic worth unit-testing gets pulled out
// as a plain function, same pattern as PostCard's arePostsEqual). A 200
// response is only terminal once the row has left 'generating': the
// placeholder row means the GET can now succeed with status:'generating'
// well before the synthesis is actually done.
// eslint-disable-next-line react-refresh/only-export-components -- exported for unit testing (Wave-5 Task 4); not a component
export function isGroupChatDone(data: GroupChat): boolean {
  return data.status !== 'generating'
}

export function GroupChatView({ groupId, onBack }: GroupChatViewProps) {
  const [chat, setChat] = useState<GroupChat | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // True once the initial fetch has 404'd: the synthesis row doesn't exist
  // yet, so we're waiting on generation (not on a slow network round-trip)
  // — the loading state adds a "Synthesizing…" hint so the user knows why
  // the wait is long.
  const [synthesizing, setSynthesizing] = useState(false)
  // R10 wave-4 final-review: distinguishes the ~100s 404-retry exhaustion
  // (still-generating, not a real failure — SYNTH_RETRY_MAX_ATTEMPTS x
  // SYNTH_RETRY_INTERVAL_MS below) from a genuine fetch failure, so the
  // error branch's heading doesn't claim "Synthesis failed to load" when
  // nothing has actually failed yet.
  const [timedOut, setTimedOut] = useState(false)
  const poll = usePollTask()

  // Render-time state reset when groupId changes (React's endorsed
  // "adjusting state when a prop changes" pattern — same shape as
  // MessagesView). The initial useState values cover first mount; this
  // covers switching to a different group without an effect-driven
  // setState cascade.
  const [loadedGroupId, setLoadedGroupId] = useState(groupId)
  if (loadedGroupId !== groupId) {
    setLoadedGroupId(groupId)
    setChat(null)
    setLoading(true)
    setError(null)
    setSynthesizing(false)
    setTimedOut(false)
  }

  useEffect(() => {
    // R10 FE-5: the initial fetch used to be a bare `await` with no
    // try/catch — a transient 5xx / offline rejection escaped as an
    // unhandled promise rejection and `loading` never flipped back to
    // false, wedging the spinner forever.
    //
    // R10 FE-4 follow-up / Wave-5 Task 4: the 404-retry path below is now
    // only a FALLBACK — since create_group_chat inserts a placeholder row
    // at dispatch, the fast path is a 200 with status:'generating', which
    // isGroupChatDone treats as not-done and the scheduler just reschedules
    // (no onError involved at all). The 404 branch only fires for a row
    // created before that migration shipped.
    // No synchronous state resets here: initial useState values cover
    // mount, and the render-time reset above covers groupId changes —
    // both happen before this effect fires.
    let active = true
    let notFoundCount = 0

    const controller = poll<GroupChat>({
      fn: async () => {
        const data = await getGroupChat(groupId)
        // Fast path: a 200 with status:'generating' means the row exists
        // but the worker isn't done — show the same "Synthesizing…" hint
        // the 404-fallback path used to be the only way to reach.
        if (active && data.status === 'generating') {
          setSynthesizing(true)
        }
        return data
      },
      isDone: isGroupChatDone,
      onDone: (data) => {
        if (!active) return
        if (data.status === 'error') {
          // Retries exhausted server-side — finally distinguishable from
          // a slow synthesis instead of another indefinite spin (the
          // whole point of this ticket).
          setSynthesizing(false)
          setTimedOut(false)
          setError('Synthesis failed. Go back and try creating the group chat again.')
          setLoading(false)
          return
        }
        cacheGroupChat(data).catch(() => {})
        setChat(data)
        setSynthesizing(false)
        setTimedOut(false)
        setLoading(false)
      },
      onError: async (err) => {
        if (!active) return
        if (isNotFoundError(err)) {
          // Fallback path: a pre-migration row whose synthesis was
          // mid-flight when this shipped — no placeholder row exists for
          // it, so it still legitimately 404s until the worker's
          // completion upsert lands.
          notFoundCount += 1
          if (notFoundCount < SYNTH_RETRY_MAX_ATTEMPTS) {
            // Still generating — stay in the loading state (with the
            // synthesizing hint) and let the scheduler retry.
            setSynthesizing(true)
            return
          }
          // Bounded window exhausted (~100s of 404s) — this is NOT a
          // real failure, just a longer-than-usual wait. setTimedOut(true)
          // lets the render branch below show an info heading ("Still
          // synthesizing") instead of "Synthesis failed to load", which
          // would misreport a still-in-progress generation as broken.
          setSynthesizing(false)
          setTimedOut(true)
          setError('Synthesis is taking longer than expected. Go back and reopen this chat in a moment.')
          setLoading(false)
          return
        }
        // Non-404 (real failure): stop retrying immediately. Offline
        // fallback: prefer the last cached synthesis over the error
        // branch when we have one to show.
        controller.stop()
        let usedCache = false
        try {
          const cached = await getCachedGroupChat(groupId)
          if (active && cached) {
            setChat(cached)
            usedCache = true
          }
        } catch { /* IDB unavailable — fall through to the error state */ }
        if (!active) return
        if (!usedCache) {
          setTimedOut(false)
          setError(getApiErrorDetail(err, 'Failed to load group synthesis'))
        }
        setSynthesizing(false)
        setLoading(false)
      },
      intervalMs: SYNTH_RETRY_INTERVAL_MS,
      initialDelayMs: 0, // first fetch fires immediately, like the old effect
      maxAttempts: SYNTH_RETRY_MAX_ATTEMPTS,
    })

    return () => {
      active = false
      controller.stop()
    }
  }, [groupId, poll])

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
            {chat?.name ?? (error ? 'Group chat' : 'Loading...')}
          </div>
          {chat?.papers && (
            <div className="text-xs text-text-muted">
              {Object.keys(chat.papers).length} papers
            </div>
          )}
        </div>
      </div>

      {error ? (
        // R10 wave-4 final-review: the ~100s 404-retry exhaustion path
        // (timedOut) is an info state, not a failure — the synthesis is
        // probably still running server-side. Only a genuine fetch
        // failure gets the "Synthesis failed to load" heading; role
        // stays "alert" either way since both are worth announcing to
        // screen readers, but the copy no longer claims something broke
        // when it didn't.
        <div role="alert" className="flex flex-col items-center justify-center py-20 gap-3 px-6 text-center">
          <p className="text-sm text-text">{timedOut ? 'Still synthesizing' : 'Synthesis failed to load'}</p>
          <p className="text-xs text-text-muted">{error}</p>
        </div>
      ) : loading ? (
        // Group synthesis takes many seconds; announce it so SR users
        // aren't left in silence while Claude works through the prompts.
        <div role="status" aria-live="polite" aria-busy="true" aria-label="Generating group synthesis" className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 size={28} className="text-gold animate-spin" aria-hidden="true" />
          {synthesizing && (
            // The fetch has 404'd at least once: the synthesis row doesn't
            // exist yet because the worker is still generating. Say so —
            // an unexplained spinner over a ~30-60s wait reads as a hang.
            <div className="text-center px-6">
              <p className="text-sm text-text">Synthesizing…</p>
              <p className="text-xs text-text-muted mt-1">
                The papers are talking it over. This can take a minute or two.
              </p>
            </div>
          )}
        </div>
      ) : chat?.messages && chat.messages.length > 0 ? (
        <div className="py-3 space-y-2">
          {/* Participants card */}
          <div className="mx-4 p-3 bg-bg-hover border border-border rounded-xl mb-3">
            <div className="flex items-center gap-2 mb-2">
              <Users size={14} className="text-persona-methodologist" />
              <span className="text-xs font-semibold text-persona-methodologist tracking-wide uppercase">
                Papers in this conversation
              </span>
            </div>
            <div className="space-y-1">
              {Object.entries(chat.papers).map(([id, title]) => (
                <div key={id} className="flex items-center gap-2">
                  <FileText size={11} className="text-text-muted" />
                  <span className="text-[13px] text-text-mid">{title}</span>
                </div>
              ))}
            </div>
          </div>

          {chat.messages.map((msg, i) => (
            <SynthesisMessage key={i} message={msg} />
          ))}

          <div className="px-4 py-3 text-center">
            <span className="text-xs text-text-subtle">End of synthesis</span>
          </div>
        </div>
      ) : (
        <div className="py-16 text-center text-text-muted text-sm">
          No synthesis available.
        </div>
      )}
    </div>
  )
}
