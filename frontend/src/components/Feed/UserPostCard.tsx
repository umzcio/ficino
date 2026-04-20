import { useState, useEffect } from 'react'
import { Loader2, FileText, Trash2 } from 'lucide-react'
import type { UserPost } from '../../lib/api'
import { getUserPostStatus, deleteUserPost } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'
import { InlineMd } from './_shared/InlineMd'

interface UserPostCardProps {
  post: UserPost
  userDisplayName?: string
  userHandle?: string
  onDeleted?: () => void
  onPersonaClick?: (key: string) => void
}

export function UserPostCard({ post, userDisplayName = 'You', userHandle = '@you', onDeleted, onPersonaClick }: UserPostCardProps) {
  const personas = usePersonas()
  const archivist = personas['archivist']
  const [status, setStatus] = useState(post.status)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Poll for completion if pending
  useEffect(() => {
    if (status !== 'pending') return
    const interval = setInterval(async () => {
      try {
        const res = await getUserPostStatus(post.id)
        if (res.status !== 'pending') {
          setStatus(res.status as typeof status)
          clearInterval(interval)
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [status, post.id])

  const reply = post.replies?.[0]
  const timeAgo = formatTimeAgo(post.created_at)

  return (
    <div className="border-b border-border">
      {/* User's post */}
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
              className={`ml-auto bg-transparent border-none cursor-pointer p-1 hover:bg-bg-hover rounded-full transition-colors ${
                confirmingDelete ? 'text-persona-skeptic' : 'text-text-muted hover:text-persona-skeptic'
              }`}
              aria-label={confirmingDelete ? 'Click again to confirm delete' : 'Delete post'}
              title={confirmingDelete ? 'Click again to confirm' : 'Delete post'}
              onClick={async () => {
                if (!confirmingDelete) {
                  setConfirmingDelete(true)
                  setTimeout(() => setConfirmingDelete(false), 3000)
                  return
                }
                await deleteUserPost(post.id)
                onDeleted?.()
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <p className="my-1 text-[15px] text-text leading-relaxed whitespace-pre-wrap break-words">
            <InlineMd text={post.content} />
          </p>
        </div>
      </article>

      {/* Archivist reply */}
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

      {status === 'complete' && reply && (
        // One-shot SR announcement — short message, outside the article,
        // so expanding "Sources" below doesn't re-announce the full reply.
        // Prior wiring put role="status" + aria-atomic="true" on the article
        // itself, which overrode article semantics AND caused every subtree
        // mutation (e.g. sources toggle) to re-read the entire AI response.
        <>
          <div role="status" aria-live="polite" className="sr-only">The Archivist replied.</div>
          <article className="px-4 py-3.5 flex gap-3 bg-bg-hover/20 border-l-2 border-[#8b92a5]/30 ml-0">
          {/* Avatar is a real <button type="button"> so keyboard users can
              activate it with Enter / Space — previously the img / div
              had only onClick, so SR users heard "graphic" with no affordance
              and keyboard users couldn't reach the profile at all. */}
          <button
            type="button"
            onClick={() => onPersonaClick?.('archivist')}
            aria-label={`Open ${archivist?.name || 'The Archivist'} profile`}
            className="w-10 h-10 p-0 rounded-full shrink-0 cursor-pointer bg-transparent border-none overflow-hidden"
            style={{ border: '1.5px solid #8b92a550' }}
          >
            {archivist?.avatar_url ? (
              <img
                src={archivist.avatar_url}
                alt=""
                className="w-full h-full object-cover block"
                aria-hidden="true"
              />
            ) : (
              <span
                className="w-full h-full flex items-center justify-center text-[11px] font-bold"
                style={{ backgroundColor: '#8b92a520', color: '#8b92a5' }}
                aria-hidden="true"
              >
                {archivist?.initials || 'TA'}
              </span>
            )}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <button
                type="button"
                className="font-bold text-[15px] text-text hover:underline cursor-pointer bg-transparent border-0 p-0 text-left"
                onClick={() => onPersonaClick?.('archivist')}
              >
                {archivist?.name || 'The Archivist'}
              </button>
              <button
                type="button"
                className="text-sm text-text-muted hover:underline cursor-pointer bg-transparent border-0 p-0 text-left"
                onClick={() => onPersonaClick?.('archivist')}
              >
                {archivist?.handle || '@the_archivist'}
              </button>
            </div>
            <div className="text-[13px] text-text-muted mb-1">
              Replying to <span className="text-gold">{userHandle}</span>
            </div>
            <p className="my-1 text-[15px] text-text leading-relaxed whitespace-pre-wrap break-words">
              <InlineMd text={reply.content} />
            </p>

            {/* Sources */}
            {post.sources && post.sources.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setSourcesOpen(!sourcesOpen)}
                  className="text-[11px] text-text-muted hover:text-gold bg-transparent border-none cursor-pointer transition-colors flex items-center gap-1 px-0"
                >
                  <FileText size={10} />
                  {sourcesOpen ? 'Hide sources' : `${post.sources.length} sources`}
                </button>
                {sourcesOpen && (
                  <div className="mt-2 space-y-2">
                    {post.sources.map((src, i) => (
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
      )}

      {status === 'error' && (
        <div className="px-4 py-3 flex gap-3 border-l-2 border-persona-skeptic/30 ml-0">
          <div className="text-[13px] text-persona-skeptic ml-13">
            The Archivist encountered an error. Try again or check your LLM provider settings.
          </div>
        </div>
      )}
    </div>
  )
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
