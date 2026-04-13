import { useState, useRef } from 'react'
import { Send, Loader2 } from 'lucide-react'
import { createUserPost } from '../../lib/api'

interface ComposeBoxProps {
  workspaceId: string | null
  onPostCreated: () => void
  userDisplayName?: string
  userHandle?: string
  onUserClick?: () => void
}

export function ComposeBox({ workspaceId, onPostCreated, userDisplayName = 'You', userHandle = '@you', onUserClick }: ComposeBoxProps) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = async () => {
    const text = content.trim()
    if (!text || loading) return
    setLoading(true)
    try {
      await createUserPost(text, workspaceId || undefined)
      setContent('')
      onPostCreated()
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex gap-3">
        <div
          className="w-10 h-10 rounded-full bg-gold/15 flex items-center justify-center text-[12px] font-bold text-gold shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={onUserClick}
        >
          You
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[14px] font-bold text-text">{userDisplayName}</span>
            <span className="text-[13px] text-text-muted">{userHandle}</span>
          </div>
          <textarea
            ref={inputRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="Ask your corpus anything..."
            className="w-full bg-transparent border-none outline-none resize-none text-[15px] text-text placeholder:text-text-muted/50 leading-relaxed min-h-[44px] max-h-[120px]"
            rows={1}
            disabled={loading}
          />
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
