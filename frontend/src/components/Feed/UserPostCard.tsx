import { useEffect, useState } from 'react'
import { Loader2, FileText, Trash2, Send } from 'lucide-react'
import type { UserPost } from '../../lib/api'
import { getUserPostStatus, deleteUserPost, replyToUserPost, getUserPost } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'
import { useKeyboardAwareInput } from '../../hooks/useKeyboardAwareInput'
import { usePollTask } from '../../hooks/usePollTask'
import { Md } from '../_shared/Md'
import { timeAgo as sharedTimeAgo } from '../../lib/timeAgo'

interface UserPostCardProps {
  post: UserPost
  userDisplayName?: string
  userHandle?: string
  onDeleted?: () => void
  onPersonaClick?: (key: string) => void
}

// Shape stored in post.replies — loose on purpose so a legacy payload
// with missing optional fields still renders.
type ReplyTurn = { role: string; content: string; persona?: string }

export function UserPostCard({ post, userDisplayName = 'You', userHandle = '@you', onDeleted, onPersonaClick }: UserPostCardProps) {
  const personas = usePersonas()
  const archivist = personas['archivist']
  // Local state mirrors the props but lets us apply optimistic updates
  // (appending a user follow-up turn the instant it's submitted) without
  // waiting for the parent's list refresh to come back.
  const [status, setStatus] = useState<UserPost['status']>(post.status)
  const [replies, setReplies] = useState<ReplyTurn[]>(post.replies ?? [])
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [locallyDeleted, setLocallyDeleted] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')
  const [replying, setReplying] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const replyInputRef = useKeyboardAwareInput<HTMLTextAreaElement>()
  const poll = usePollTask()

  // Sync local state from props when the parent refetches the post.
  // Only overwrite if the parent's payload is "newer" (has >= our turn
  // count) so an optimistic user turn we just appended doesn't get
  // wiped by a stale list fetch that hasn't caught up yet.
  useEffect(() => {
    if ((post.replies?.length ?? 0) >= replies.length) {
      setReplies(post.replies ?? [])
    }
    setStatus(post.status)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.replies, post.status])

  // Auto-grow the reply textarea — same pattern as ComposeBox so long
  // follow-ups aren't stuck in a one-line window.
  useEffect(() => {
    const el = replyInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [replyDraft, replyInputRef])

  // Poll for completion while pending. On flip to complete we fetch the
  // full post so we pick up the new Archivist reply even if the parent
  // list hasn't refreshed yet (the parent polls every 3s; this loop
  // lets the card's own rendering catch up faster).
  useEffect(() => {
    if (status !== 'pending') return
    const controller = poll<{ status: string }>({
      fn: () => getUserPostStatus(post.id),
      isDone: (res) => res.status !== 'pending',
      onDone: async (res) => {
        setStatus(res.status as typeof status)
        try {
          const fresh = await getUserPost(post.id)
          setReplies(fresh.replies ?? [])
        } catch { /* parent refresh will correct shortly */ }
      },
      // No onError — a transient status-check failure keeps polling
      // (matches the original's empty catch), same as usePollTask's
      // documented default.
      intervalMs: 2000,
    })
    return () => controller.stop()
  }, [status, post.id, poll])

  const timeAgo = sharedTimeAgo(post.created_at, { suffix: false })

  const handleDelete = async () => {
    if (deleting) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      setTimeout(() => setConfirmingDelete(false), 3000)
      return
    }
    setDeleting(true)
    setLocallyDeleted(true)
    try {
      await deleteUserPost(post.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (!msg.includes('404')) {
        setLocallyDeleted(false)
        setDeleting(false)
        return
      }
    }
    onDeleted?.()
  }

  const handleReply = async () => {
    const text = replyDraft.trim()
    if (!text || replying || status !== 'complete') return
    setReplying(true)
    setReplyError(null)
    // Optimistic append — user sees their turn land immediately, and the
    // status flips to 'pending' so the existing "Archivist is searching..."
    // indicator appears under it.
    setReplies(prev => [...prev, { role: 'user', content: text }])
    setStatus('pending')
    setReplyDraft('')
    try {
      await replyToUserPost(post.id, text)
    } catch (err) {
      // Roll back on real failure so the user knows the server didn't
      // get it and can retry.
      setReplies(prev => prev.slice(0, -1))
      setStatus('complete')
      setReplyError(err instanceof Error ? err.message : 'Failed to send. Try again.')
    } finally {
      setReplying(false)
    }
  }

  if (locallyDeleted) return null

  // Split replies into rendered turns. Each turn is either the user or
  // the Archivist — render uniform PostCard-style rows in a thread.
  return (
    <div className="border-b border-border">
      {/* Original user question — same visual as a feed PostCard head. */}
      <article className="px-4 py-3.5 flex gap-3">
        <div className="w-10 h-10 rounded-full bg-gold/15 flex items-center justify-center text-[12px] font-bold text-gold shrink-0">
          You
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="font-bold text-[15px] text-text">{userDisplayName}</span>
            <span className="text-sm text-text-muted">{userHandle}</span>
            <span className="text-sm text-text-muted">·</span>
            <span className="text-sm text-text-muted">{timeAgo}</span>
            <button
              disabled={deleting}
              className={`ml-auto bg-transparent border-none cursor-pointer p-1 hover:bg-bg-hover rounded-full transition-colors disabled:opacity-40 disabled:cursor-default ${
                confirmingDelete ? 'text-persona-skeptic' : 'text-text-muted hover:text-persona-skeptic'
              }`}
              aria-label={confirmingDelete ? 'Click again to confirm delete' : 'Delete post'}
              title={confirmingDelete ? 'Click again to confirm' : 'Delete post'}
              onClick={handleDelete}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <Md text={post.content} className="my-1 text-[15px] text-text leading-relaxed break-words" />
        </div>
      </article>

      {/* Thread of replies. Each turn renders in the same PostCard-like
          frame; Archivist turns also carry the sources affordance under
          the FIRST turn (that's where the initial grounding citations
          live; follow-ups pull fresh chunks that aren't persisted). */}
      {replies.map((turn, i) => {
        const isUser = turn.role === 'user'
        const isFirstArchivistTurn =
          !isUser && replies.findIndex(r => r.role !== 'user') === i
        return (
          <ThreadTurn
            key={i}
            isUser={isUser}
            content={turn.content}
            archivist={archivist}
            userDisplayName={userDisplayName}
            userHandle={userHandle}
            onPersonaClick={onPersonaClick}
            sourcesOpen={isFirstArchivistTurn && sourcesOpen}
            sources={isFirstArchivistTurn ? post.sources : undefined}
            onToggleSources={isFirstArchivistTurn ? () => setSourcesOpen(v => !v) : undefined}
          />
        )
      })}

      {/* Pending indicator — applies to both the initial reply and any
          follow-up. Archivist avatar + spinner + "searching" copy. */}
      {status === 'pending' && (
        <div role="status" aria-live="polite" aria-atomic="true" className="px-4 py-3 flex gap-3 bg-bg-hover/30 border-l-2 border-[#8b92a5]/30 ml-0">
          {archivist?.avatar_url ? (
            <img
              src={archivist.avatar_url}
              alt="The Archivist"
              className="w-10 h-10 rounded-full shrink-0 object-cover"
              style={{ border: '1.5px solid #8b92a550' }}
            />
          ) : (
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
              style={{ backgroundColor: '#8b92a520', border: '1.5px solid #8b92a550', color: '#8b92a5' }}
            >
              {archivist?.initials || 'TA'}
            </div>
          )}
          <div className="flex items-center gap-2 text-[13px] text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>The Archivist is searching your corpus...</span>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div role="alert" aria-atomic="true" className="px-4 py-3 flex gap-3 border-l-2 border-persona-skeptic/30 ml-0">
          <div className="text-[13px] text-persona-skeptic ml-13">
            The Archivist encountered an error. Try again or check your LLM provider settings.
          </div>
        </div>
      )}

      {/* Reply composer — only available once the last Archivist reply
          has landed. During 'pending' the typing indicator above stands
          in for both the initial and follow-up wait, and allowing a
          second submit while one is in flight would stage an orphan
          user turn ahead of the previous response. */}
      {status === 'complete' && replies.length > 0 && (
        <div className="px-4 py-3 flex gap-3 border-t border-border">
          <div className="w-10 h-10 rounded-full bg-gold/15 flex items-center justify-center text-[12px] font-bold text-gold shrink-0">
            You
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-text-muted mb-1.5">
              Replying to <span className="text-gold">{archivist?.handle || '@the_archivist'}</span>
            </div>
            <div className="flex gap-2 items-end">
              <textarea
                ref={replyInputRef}
                value={replyDraft}
                onChange={(e) => {
                  setReplyDraft(e.target.value)
                  if (replyError) setReplyError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleReply()
                  }
                }}
                placeholder="Follow up with the Archivist..."
                aria-label="Reply to the Archivist"
                rows={1}
                disabled={replying}
                className="flex-1 bg-transparent border border-border rounded-xl px-3 py-2 text-[14px] text-text placeholder:text-text-muted outline-none focus:border-gold/40 resize-none overflow-y-auto min-h-[40px] max-h-[40vh]"
              />
              <button
                type="button"
                onClick={handleReply}
                disabled={!replyDraft.trim() || replying}
                aria-label="Send reply"
                className="w-10 h-10 rounded-full bg-gold text-bg flex items-center justify-center border-none cursor-pointer disabled:opacity-30 disabled:cursor-default hover:opacity-90 transition-opacity"
              >
                {replying ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </div>
            {replyError && (
              <div role="alert" className="text-[12px] text-persona-skeptic mt-1">
                {replyError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// A single turn in the thread — user or Archivist, styled to match a
// feed PostCard row. Kept as an internal helper to avoid duplicating
// ~30 lines of avatar/header/content markup in the render map above.
function ThreadTurn({
  isUser,
  content,
  archivist,
  userDisplayName,
  userHandle,
  onPersonaClick,
  sourcesOpen,
  sources,
  onToggleSources,
}: {
  isUser: boolean
  content: string
  archivist: ReturnType<typeof usePersonas>[string] | undefined
  userDisplayName: string
  userHandle: string
  onPersonaClick?: (key: string) => void
  sourcesOpen: boolean
  sources?: UserPost['sources']
  onToggleSources?: () => void
}) {
  const ringColor = '#8b92a550'
  if (isUser) {
    return (
      <article className="px-4 py-3.5 flex gap-3">
        <div className="w-10 h-10 rounded-full bg-gold/15 flex items-center justify-center text-[12px] font-bold text-gold shrink-0">
          You
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="font-bold text-[15px] text-text">{userDisplayName}</span>
            <span className="text-sm text-text-muted">{userHandle}</span>
          </div>
          <div className="text-[13px] text-text-muted mb-1">
            Replying to <span className="text-gold">{archivist?.handle || '@the_archivist'}</span>
          </div>
          <Md text={content} className="my-1 text-[15px] text-text leading-relaxed break-words" />
        </div>
      </article>
    )
  }
  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">The Archivist replied.</div>
      <article className="px-4 py-3.5 flex gap-3 bg-bg-hover/20 border-l-2 border-[#8b92a5]/30 ml-0">
        <button
          type="button"
          onClick={() => onPersonaClick?.('archivist')}
          aria-label={`Open ${archivist?.name || 'The Archivist'} profile`}
          className="w-10 h-10 p-0 rounded-full shrink-0 cursor-pointer bg-transparent border-none overflow-hidden"
          style={{ border: `1.5px solid ${ringColor}` }}
        >
          {archivist?.avatar_url ? (
            <img src={archivist.avatar_url} alt="" className="w-full h-full object-cover block" aria-hidden="true" />
          ) : (
            <span className="w-full h-full flex items-center justify-center text-[11px] font-bold" style={{ backgroundColor: '#8b92a520', color: '#8b92a5' }} aria-hidden="true">
              {archivist?.initials || 'TA'}
            </span>
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <button type="button" className="font-bold text-[15px] text-text hover:underline cursor-pointer bg-transparent border-0 p-0 text-left" onClick={() => onPersonaClick?.('archivist')}>
              {archivist?.name || 'The Archivist'}
            </button>
            <button type="button" className="text-sm text-text-muted hover:underline cursor-pointer bg-transparent border-0 p-0 text-left" onClick={() => onPersonaClick?.('archivist')}>
              {archivist?.handle || '@the_archivist'}
            </button>
          </div>
          <div className="text-[13px] text-text-muted mb-1">
            Replying to <span className="text-gold">{userHandle}</span>
          </div>
          <Md text={content} className="my-1 text-[15px] text-text leading-relaxed break-words" />
          {sources && sources.length > 0 && onToggleSources && (
            <div className="mt-2">
              <button
                onClick={onToggleSources}
                className="text-[11px] text-text-muted hover:text-gold bg-transparent border-none cursor-pointer transition-colors flex items-center gap-1 px-0"
              >
                <FileText size={10} />
                {sourcesOpen ? 'Hide sources' : `${sources.length} sources`}
              </button>
              {sourcesOpen && (
                <div className="mt-2 space-y-2">
                  {sources.map((src, i) => (
                    <div key={i} className="border border-border rounded-lg p-2.5 bg-bg text-[12px]">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-text-mid truncate">{src.paper_title}</span>
                        <span className="text-text-muted shrink-0">· {src.section}</span>
                        <span className="text-text-subtle shrink-0 text-[10px] ml-auto">{(src.score * 100).toFixed(0)}%</span>
                      </div>
                      <p className="text-text-muted leading-relaxed line-clamp-3">{src.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </article>
    </>
  )
}

