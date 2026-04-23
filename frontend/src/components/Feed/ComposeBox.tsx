import { useEffect, useState } from 'react'
import { Send, Loader2, ArrowRight } from 'lucide-react'
import { createUserPost } from '../../lib/api'
import { useKeyboardAwareInput } from '../../hooks/useKeyboardAwareInput'

interface ComposeBoxProps {
  workspaceId: string | null
  onPostCreated: () => void
  userDisplayName?: string
  userHandle?: string
  onUserClick?: () => void
  onViewProfileClick?: () => void
}

export function ComposeBox({ workspaceId, onPostCreated, userDisplayName = 'You', userHandle = '@you', onUserClick, onViewProfileClick }: ComposeBoxProps) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One-shot "Asked — view reply in your profile" nudge after a successful
  // submit. Lives here rather than a global toast so it's anchored to the
  // compose box and disappears the moment the user starts typing again.
  const [justPosted, setJustPosted] = useState(false)
  // Scrolls the textarea into view when the iOS/Android keyboard opens,
  // so the input isn't hidden behind it.
  const inputRef = useKeyboardAwareInput<HTMLTextAreaElement>()

  // Auto-grow the textarea so longer questions are fully visible instead
  // of scrolling inside a 120px window. Reset to 'auto' first so that
  // scrollHeight measures the content height rather than the prior
  // locked-in height; then size to exactly fit. CSS max-height caps this
  // to roughly half the viewport and flips on overflow scroll past that.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [content, inputRef])

  const handleSubmit = async () => {
    const text = content.trim()
    if (!text || loading) return
    setLoading(true)
    setError(null)
    try {
      await createUserPost(text, workspaceId || undefined)
      setContent('')
      setJustPosted(true)
      onPostCreated()
    } catch (err) {
      // Surface failures both visually and via the live region so neither
      // sighted nor SR users are left staring at a post that silently never
      // sent. Keep the message generic enough not to leak server internals.
      setError(err instanceof Error ? err.message : 'Failed to post. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-b border-border px-4 py-3">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading ? 'Posting your question' : error ? `Post failed: ${error}` : ''}
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onUserClick}
          aria-label="View your profile"
          className="w-10 h-10 rounded-full bg-gold/15 flex items-center justify-center text-[12px] font-bold text-gold shrink-0 cursor-pointer hover:opacity-80 transition-opacity border-none"
        >
          You
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[14px] font-bold text-text">{userDisplayName}</span>
            <span className="text-[13px] text-text-muted">{userHandle}</span>
          </div>
          <textarea
            ref={inputRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              if (justPosted) setJustPosted(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="Ask your corpus anything..."
            aria-label="Compose new post"
            className="w-full bg-transparent border-none outline-none resize-none overflow-y-auto text-[15px] text-text placeholder:text-text-muted leading-relaxed min-h-[44px] max-h-[50vh]"
            rows={1}
            disabled={loading}
          />
          {justPosted && !error && (
            <button
              type="button"
              onClick={() => {
                setJustPosted(false)
                onViewProfileClick?.()
              }}
              className="mt-1 flex items-center gap-1 text-[12px] text-gold bg-transparent border-none cursor-pointer hover:underline px-0"
            >
              Asked. View reply in your profile
              <ArrowRight size={12} />
            </button>
          )}
          {error && (
            <div
              role="alert"
              className="text-[12px] text-persona-skeptic bg-persona-skeptic/10 border border-persona-skeptic/20 rounded-md px-2 py-1 mt-1"
            >
              {error}
            </div>
          )}
          <div className="flex justify-between items-center mt-1">
            <span className="text-[11px] text-text-muted">
              The Archivist will search your corpus and respond
            </span>
            <button
              onClick={handleSubmit}
              disabled={!content.trim() || loading}
              className="flex items-center gap-1.5 bg-gold text-bg text-[13px] font-semibold px-4 py-1.5 rounded-full border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-default"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Post
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
