import { useState, useRef, useEffect } from 'react'
import {
  MessageCircle, Repeat2, Heart, Bookmark,
  MoreHorizontal, FileText, ImageIcon, ZoomIn, X, Loader2
} from 'lucide-react'
import type { FeedPost } from '../../types'
import { sendReply, sendZap, getPostReplies, getCitation, type ReplyMessage } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'

/** Lightweight inline markdown: **bold**, *italic*, `code`. No block elements. */
export function InlineMd({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  // Split on **bold**, *italic*, and `code` patterns
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[2]) parts.push(<strong key={key++}>{match[2]}</strong>)
    else if (match[3]) parts.push(<em key={key++}>{match[3]}</em>)
    else if (match[4]) parts.push(<code key={key++} className="text-[13px] bg-bg-hover px-1 py-px rounded">{match[4]}</code>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function FigureLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Figure lightbox"
    >
      <button
        onClick={onClose}
        aria-label="Close lightbox"
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-bg/80 border border-border flex items-center justify-center cursor-pointer hover:bg-bg transition-colors"
      >
        <X size={20} className="text-text" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-[90vh] object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

function formatNum(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
}

function Avatar({ persona }: { persona: string }) {
  const personas = usePersonas()
  const p = personas[persona]
  if (!p) return null
  if (p.avatar_url) {
    return (
      <img
        src={p.avatar_url}
        alt={p.name}
        className="w-[42px] h-[42px] rounded-full shrink-0 object-cover"
        style={{ border: `2px solid ${p.color}50` }}
      />
    )
  }
  return (
    <div
      className="w-[42px] h-[42px] rounded-full shrink-0 flex items-center justify-center text-[13px] font-bold tracking-tight"
      style={{
        backgroundColor: p.color + '28',
        border: `2px solid ${p.color}50`,
        color: p.color,
      }}
    >
      {p.initials}
    </div>
  )
}

function ActionBtn({
  icon: Icon, count, color, active, onClick, label,
}: {
  icon: typeof MessageCircle
  count?: number
  color: string
  active?: boolean
  onClick?: () => void
  label: string
}) {
  const [hovered, setHovered] = useState(false)
  const isLit = active || hovered

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={count !== undefined ? `${label}: ${count}` : label}
      aria-pressed={active}
      className="flex items-center gap-[5px] px-2.5 py-1.5 rounded-[20px] text-[13px] flex-1 justify-center max-w-[80px] border-none bg-transparent cursor-pointer transition-all duration-100"
      style={{
        color: isLit ? color : 'var(--color-text-muted)',
        backgroundColor: isLit ? color + '15' : 'transparent',
      }}
    >
      <Icon
        size={16}
        strokeWidth={isLit ? 2.5 : 1.75}
        fill={active && color === 'var(--color-like)' ? color : 'none'}
      />
      {count !== undefined && <span>{formatNum(count)}</span>}
    </button>
  )
}

interface PostCardProps {
  post: FeedPost
  feedId?: string | null
  postIndex?: number
  bookmarkedId?: string | null
  onBookmarkToggle?: (post: FeedPost, postIndex: number) => void
  onClick?: () => void
  hasUserReply?: boolean
  annotation?: string | null
  onAnnotationSave?: (feedId: string, postIndex: number, body: string) => void
  onAnnotationDelete?: (feedId: string, postIndex: number) => void
  onPersonaClick?: (key: string) => void
  autoOpenReply?: boolean
}

export function PostCard({ post, feedId, postIndex = 0, bookmarkedId, onBookmarkToggle, onClick, hasUserReply, annotation, onAnnotationSave, onAnnotationDelete, onPersonaClick, autoOpenReply }: PostCardProps) {
  const personas = usePersonas()
  const p = personas[post.persona]
  const [liked, setLiked] = useState(false)
  const bookmarked = !!bookmarkedId
  const [figureExpanded, setFigureExpanded] = useState(false)
  const [threadExpanded, setThreadExpanded] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyMessages, setReplyMessages] = useState<ReplyMessage[]>([])
  const [replyInput, setReplyInput] = useState('')
  const [replyLoading, setReplyLoading] = useState(false)
  const [repliesLoaded, setRepliesLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [noteEditing, setNoteEditing] = useState(false)
  const [noteText, setNoteText] = useState(annotation || '')
  const inputRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const loadRequestRef = useRef(0)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [zapOpen, setZapOpen] = useState<number | null>(null) // index of message being zapped, -1 = post itself
  const [zapLoading, setZapLoading] = useState(false)
  const zapRef = useRef<HTMLDivElement>(null)

  // Close zap dropdown on click outside or Escape
  useEffect(() => {
    if (zapOpen === null) return
    const handleClick = (e: MouseEvent) => {
      if (zapRef.current && !zapRef.current.contains(e.target as Node)) setZapOpen(null)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZapOpen(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [zapOpen])

  // Filter personas for @mention autocomplete
  const allPersonas = Object.entries(personas).map(([k, pp]) => ({ personaKey: k, ...pp }))
  const mentionFiltered = mentionQuery !== null
    ? allPersonas.filter(pp =>
        pp.handle?.toLowerCase().includes(mentionQuery.toLowerCase()) ||
        pp.name?.toLowerCase().includes(mentionQuery.toLowerCase())
      ).slice(0, 5)
    : []

  const insertMention = (mp: { handle?: string }) => {
    if (!mp.handle) return
    const handle = mp.handle.startsWith('@') ? mp.handle.slice(1) : mp.handle
    // Replace the @query with the full handle
    const val = replyInput
    const match = val.match(/@(\w*)$/)
    if (match) {
      const before = val.slice(0, match.index)
      setReplyInput(`${before}@${handle} `)
    }
    setMentionQuery(null)
    setMentionIdx(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handleZap = async (targetKey: string, sourceKey: string, sourceMessage: string) => {
    if (!feedId || zapLoading) return
    setZapLoading(true)
    setZapOpen(null)
    // Open reply thread if not already open
    if (!replyOpen) setReplyOpen(true)
    const requestId = ++loadRequestRef.current
    try {
      const data = await sendZap(
        feedId, postIndex, targetKey, sourceKey,
        sourceMessage, post.content, paper || null,
      )
      if (requestId === loadRequestRef.current) {
        setReplyMessages(data.messages)
        setRepliesLoaded(true)
      }
    } catch {
      // ignore
    } finally {
      setZapLoading(false)
    }
  }

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2000)
  }

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => showToast(`${label} copied`)).catch(() => {})
  }

  const handleCite = async (format: 'apa' | 'mla') => {
    const title = post.sources?.[0]?.paper_title
    if (!title) { showToast('No source paper'); return }
    try {
      const data = await getCitation(title, format)
      await navigator.clipboard.writeText(data.citation)
      showToast(`${format.toUpperCase()} citation copied`)
    } catch {
      showToast('Citation failed')
    }
  }

  const handleOpenReply = async () => {
    const opening = !replyOpen
    setReplyOpen(opening)
    if (opening && !repliesLoaded && feedId) {
      const requestId = ++loadRequestRef.current
      try {
        const data = await getPostReplies(feedId, postIndex)
        if (requestId === loadRequestRef.current) {
          setReplyMessages(data.messages)
          setRepliesLoaded(true)
        }
      } catch {
        if (requestId === loadRequestRef.current) {
          setRepliesLoaded(true)
        }
      }
    }
  }

  // Focus input after reply section renders
  useEffect(() => {
    if (replyOpen && repliesLoaded) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [replyOpen, repliesLoaded])

  const handleSendReply = async () => {
    if (!replyInput.trim() || !feedId || replyLoading) return
    const userMessage = replyInput.trim()
    setReplyMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setReplyInput('')
    setReplyLoading(true)
    const requestId = ++loadRequestRef.current
    try {
      const data = await sendReply(
        feedId, postIndex, post.persona,
        userMessage, post.content, paper || null,
      )
      if (requestId === loadRequestRef.current) {
        setReplyMessages(data.messages)
      }
    } catch {
      if (requestId === loadRequestRef.current) {
        setReplyMessages(prev => prev.filter((_, idx) => idx < prev.length - 1))
        setReplyInput(userMessage)
      }
    } finally {
      setReplyLoading(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  // Auto-open reply thread
  useEffect(() => {
    if (autoOpenReply && !replyOpen && feedId) {
      handleOpenReply()
    }
  }, [autoOpenReply, feedId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return null

  const isFigure = post.post_type === 'figure'
  const isThread = post.post_type === 'thread' && post.thread_posts && post.thread_posts.length > 0
  const paper = post.paper_ref
  const apiBase = import.meta.env.VITE_API_BASE || '/ficino/api'
  const figSrc = post.figure_url ? `${apiBase}${post.figure_url}` : ''

  return (
    <article
      className="border-b border-border px-4 py-3.5 flex gap-3 hover:bg-bg-hover transition-colors cursor-pointer relative"
      style={{
        borderLeft: isFigure ? '3px solid color-mix(in srgb, var(--color-gold) 19%, transparent)' : '3px solid transparent',
      }}
      onClick={onClick}
    >
      <Avatar persona={post.persona} />

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          <span
            className="font-bold text-[15px] text-text hover:underline cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onPersonaClick?.(post.persona) }}
          >{p.name}</span>
          <span
            className="text-sm text-text-muted hover:underline cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onPersonaClick?.(post.persona) }}
          >{p.handle}</span>
          <span className="text-sm text-text-muted">·</span>
          <span className="text-sm text-text-muted">{post.time}</span>
          {post.post_type === 'thread' && post.thread_count && (
            <span className="text-[11px] text-gold bg-gold/8 border border-gold/20 rounded px-1.5 py-px font-semibold tracking-wide">
              THREAD {post.thread_count}
            </span>
          )}
          {hasUserReply && (
            <span className="text-[11px] text-persona-practitioner bg-persona-practitioner/8 border border-persona-practitioner/20 rounded px-1.5 py-px font-semibold tracking-wide inline-flex items-center gap-1">
              <MessageCircle size={9} />
              REPLIED
            </span>
          )}
          {isFigure && (
            <span className="text-[11px] text-persona-methodologist bg-persona-methodologist/8 border border-persona-methodologist/20 rounded px-1.5 py-px font-semibold tracking-wide inline-flex items-center gap-1">
              <ImageIcon size={9} />
              FIGURE
            </span>
          )}
          <div className="ml-auto relative">
            <button
              aria-label="More options"
              className="bg-transparent border-none cursor-pointer p-1 hover:bg-bg-hover rounded-full"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
            >
              <MoreHorizontal size={16} className="text-text-muted" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={(e) => { e.stopPropagation(); setMenuOpen(false) }} />
                <div className="absolute right-0 top-8 z-30 bg-bg border border-border rounded-xl shadow-lg py-1 min-w-[180px]">
                  <button
                    className="w-full text-left px-3 py-2 text-[13px] text-text hover:bg-bg-hover bg-transparent border-none cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      const text = isThread && post.thread_posts
                        ? post.thread_posts.join('\n\n')
                        : post.content
                      copyToClipboard(text, 'Post text')
                    }}
                  >
                    Copy text
                  </button>
                  {post.sources && post.sources.length > 0 && (
                    <>
                      <button
                        className="w-full text-left px-3 py-2 text-[13px] text-text hover:bg-bg-hover bg-transparent border-none cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); handleCite('apa') }}
                      >
                        Cite (APA)
                      </button>
                      <button
                        className="w-full text-left px-3 py-2 text-[13px] text-text hover:bg-bg-hover bg-transparent border-none cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); handleCite('mla') }}
                      >
                        Cite (MLA)
                      </button>
                    </>
                  )}
                  <div className="border-t border-border my-1" />
                  <button
                    className="w-full text-left px-3 py-2 text-[13px] text-text hover:bg-bg-hover bg-transparent border-none cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      setNoteText(annotation || '')
                      setNoteEditing(true)
                      setTimeout(() => noteRef.current?.focus(), 50)
                    }}
                  >
                    {annotation ? 'Edit note' : 'Add note'}
                  </button>
                  {annotation && (
                    <button
                      className="w-full text-left px-3 py-2 text-[13px] text-persona-skeptic hover:bg-bg-hover bg-transparent border-none cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpen(false)
                        if (feedId) onAnnotationDelete?.(feedId, postIndex)
                      }}
                    >
                      Remove note
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Replying to */}
        {post.replying_to && (
          <div className="text-[13px] text-text-muted mb-1">
            Replying to <span className="text-gold">{post.replying_to}</span>
          </div>
        )}

        {/* Paper tag */}
        {paper && (
          <div className="flex items-center gap-1.5 mb-1.5">
            <FileText size={11} className="text-text-muted" />
            <span className="text-[11px] text-text-mid bg-gold/4 border border-gold/10 rounded px-[7px] py-px">
              {paper}
            </span>
          </div>
        )}

        {/* Content — thread opener or regular post */}
        {isThread ? (
          <div className="my-1 mb-2.5">
            {/* Thread opener (post 1) */}
            <div className="flex gap-2 items-start">
              <div className="flex flex-col items-center shrink-0 mt-1">
                <span className="text-[11px] font-bold text-gold">1</span>
                <div className="w-px flex-1 bg-gold/20 mt-1" />
              </div>
              <p className="text-[15px] text-text leading-relaxed whitespace-pre-wrap break-words flex-1">
                <InlineMd text={post.thread_posts![0]} />
              </p>
            </div>

            {/* Expand/collapse */}
            {!threadExpanded ? (
              <button
                onClick={(e) => { e.stopPropagation(); setThreadExpanded(true) }}
                className="mt-2 ml-5 text-[13px] text-gold bg-transparent border border-gold/20 rounded-[16px] px-3 py-1 cursor-pointer hover:bg-gold/5 transition-colors font-medium"
              >
                Show thread ({post.thread_posts!.length} posts)
              </button>
            ) : (
              <>
                {post.thread_posts!.slice(1).map((text, i) => (
                  <div key={i} className="flex gap-2 items-start mt-2">
                    <div className="flex flex-col items-center shrink-0 mt-1">
                      <span className="text-[11px] font-bold text-gold">{i + 2}</span>
                      {i < post.thread_posts!.length - 2 && (
                        <div className="w-px flex-1 bg-gold/20 mt-1" />
                      )}
                    </div>
                    <p className="text-[15px] text-text leading-relaxed whitespace-pre-wrap break-words flex-1">
                      <InlineMd text={text} />
                    </p>
                  </div>
                ))}
                <button
                  onClick={(e) => { e.stopPropagation(); setThreadExpanded(false) }}
                  className="mt-2 ml-5 text-[13px] text-text-muted bg-transparent border-none cursor-pointer hover:text-gold transition-colors"
                >
                  Collapse thread
                </button>
              </>
            )}
          </div>
        ) : (
          <p className="my-1 mb-2.5 text-[15px] text-text leading-relaxed whitespace-pre-wrap break-words">
            <InlineMd text={post.content} />
          </p>
        )}

        {/* Figure block */}
        {isFigure && (post.figure_caption || post.figure_url) && (
          <div className="mb-2.5">
            <div
              onClick={(e) => { e.stopPropagation(); if (figSrc) setFigureExpanded(true) }}
              className="border border-border rounded-xl overflow-hidden bg-bg-hover relative cursor-zoom-in hover:border-gold/25 transition-colors"
            >
              <div className="absolute top-2.5 left-2.5 z-10 flex items-center gap-1.5 bg-bg/80 backdrop-blur-sm border border-gold/20 rounded-md px-2 py-0.5">
                <ImageIcon size={10} className="text-gold" />
                <span className="text-[10px] text-gold font-semibold tracking-wider">EXTRACTED FIGURE</span>
              </div>
              {figSrc && (
                <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1 bg-bg/80 backdrop-blur-sm border border-border rounded-md px-1.5 py-0.5">
                  <ZoomIn size={10} className="text-text-muted" />
                  <span className="text-[10px] text-text-muted">expand</span>
                </div>
              )}
              {figSrc ? (
                <img
                  src={figSrc}
                  alt={post.figure_caption || 'Extracted figure'}
                  className="w-full max-h-[400px] object-contain bg-bg-hover"
                  loading="lazy"
                />
              ) : (
                <div className="h-[150px] flex items-center justify-center text-text-muted text-sm bg-bg-hover">
                  [Figure not available]
                </div>
              )}
            </div>
            {post.figure_caption && (
              <div className="flex items-start gap-1.5 mt-1.5 px-0.5">
                <FileText size={11} className="text-text-muted shrink-0 mt-0.5" />
                <span className="text-xs text-text-muted leading-snug italic">
                  {post.figure_caption}
                </span>
              </div>
            )}
            {figureExpanded && figSrc && (
              <FigureLightbox
                src={figSrc}
                alt={post.figure_caption || 'Extracted figure'}
                onClose={() => setFigureExpanded(false)}
              />
            )}
          </div>
        )}

        {/* Quote block */}
        {post.post_type === 'quote' && post.quoting_content && (
          <div className="border border-border rounded-xl px-3.5 py-2.5 mb-2.5 bg-bg-hover">
            <div className="text-[13px] text-text-muted font-semibold mb-1">
              {post.quoting_handle}
            </div>
            <div className="text-[13px] text-text-secondary leading-snug">
              <InlineMd text={post.quoting_content || ''} />
            </div>
          </div>
        )}

        {/* Source reveal */}
        {post.sources && post.sources.length > 0 && (
          <div className="mb-1">
            <button
              onClick={(e) => { e.stopPropagation(); setSourcesOpen(!sourcesOpen) }}
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
                      <span className="text-gold/50 shrink-0 text-[10px] ml-auto">{(src.score * 100).toFixed(0)}%</span>
                    </div>
                    <p className="text-text-muted leading-relaxed line-clamp-3">
                      {src.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Annotation display */}
        {annotation && !noteEditing && (
          <div
            className="mb-2 px-3 py-2 border-l-2 border-gold/30 bg-gold/4 rounded-r-lg cursor-pointer hover:bg-gold/8 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              setNoteText(annotation)
              setNoteEditing(true)
              setTimeout(() => noteRef.current?.focus(), 50)
            }}
          >
            <div className="text-[11px] text-gold/60 font-semibold uppercase tracking-wider mb-0.5">Your note</div>
            <p className="text-[13px] text-text-mid leading-snug italic whitespace-pre-wrap">{annotation}</p>
          </div>
        )}

        {/* Annotation editor */}
        {noteEditing && (
          <div className="mb-2" onClick={(e) => e.stopPropagation()}>
            <textarea
              ref={noteRef}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a personal note..."
              rows={3}
              className="w-full bg-bg-hover border border-border rounded-lg px-3 py-2 text-[13px] text-text resize-none focus:outline-none focus:border-gold/40 transition-colors"
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setNoteEditing(false) }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  if (noteText.trim() && feedId) {
                    onAnnotationSave?.(feedId, postIndex, noteText.trim())
                  }
                  setNoteEditing(false)
                }
              }}
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[11px] text-text-muted">Ctrl+Enter to save, Esc to cancel</span>
              <div className="flex gap-2">
                <button
                  className="text-[12px] text-text-muted bg-transparent border-none cursor-pointer hover:text-text"
                  onClick={() => setNoteEditing(false)}
                >
                  Cancel
                </button>
                <button
                  className="text-[12px] text-gold bg-gold/10 border border-gold/20 rounded-lg px-3 py-1 cursor-pointer hover:bg-gold/15 font-semibold disabled:opacity-40"
                  disabled={!noteText.trim()}
                  onClick={() => {
                    if (noteText.trim() && feedId) {
                      onAnnotationSave?.(feedId, postIndex, noteText.trim())
                    }
                    setNoteEditing(false)
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex -ml-2 mt-1">
          <ActionBtn icon={MessageCircle} count={post.replies + replyMessages.filter(m => m.role !== 'interjection').length} color="var(--color-persona-practitioner)" active={replyOpen} onClick={handleOpenReply} label="Replies" />
          <div className="relative" ref={zapOpen === -1 ? zapRef : undefined}>
            <ActionBtn
              icon={Repeat2}
              count={post.retweets}
              color="var(--color-retweet)"
              active={zapOpen === -1}
              onClick={() => setZapOpen(zapOpen === -1 ? null : -1)}
              label="Pass to persona"
            />
            {zapOpen === -1 && (
              <div className="absolute bottom-full left-0 mb-1 w-56 bg-bg border border-border rounded-xl shadow-lg overflow-hidden z-20" onClick={e => e.stopPropagation()}>
                <div className="px-3 py-2 text-[11px] text-text-muted border-b border-border font-medium">Have a persona respond</div>
                {allPersonas.filter(pp => pp.personaKey !== post.persona).map(pp => (
                  <button
                    key={pp.personaKey}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left border-none cursor-pointer hover:bg-bg-hover transition-colors bg-transparent"
                    onClick={() => handleZap(pp.personaKey, post.persona, post.content)}
                  >
                    {pp.avatar_url ? (
                      <img src={pp.avatar_url} alt={pp.name} className="w-6 h-6 rounded-full object-cover" style={{ border: `1.5px solid ${pp.color}50` }} />
                    ) : (
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ backgroundColor: pp.color + '22', color: pp.color }}>{pp.initials}</div>
                    )}
                    <span className="text-[13px] text-text">{pp.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <ActionBtn
            icon={Heart}
            count={post.likes + (liked ? 1 : 0)}
            color="var(--color-like)"
            active={liked}
            onClick={() => setLiked(!liked)}
            label="Like"
          />
          <ActionBtn
            icon={Bookmark}
            count={post.bookmarks + (bookmarked ? 1 : 0)}
            color="var(--color-gold)"
            active={bookmarked}
            onClick={() => onBookmarkToggle?.(post, postIndex)}
            label="Bookmark"
          />
        </div>

        {/* Reply thread — Twitter/X style */}
        {replyOpen && (
          <div className="mt-3 border-t border-border pt-3">
            {/* Existing conversation as post-style replies */}
            {replyMessages.length > 0 && (
              <div className="mb-3">
                {replyMessages.map((msg, i) => {
                  const isUser = msg.role === 'user'
                  const isInterjection = msg.role === 'interjection'
                  const msgPersona = isInterjection && msg.persona ? personas[msg.persona] : p
                  const displayName = isUser ? 'You' : (msgPersona?.name || p.name)
                  const displayHandle = isUser ? '' : (msgPersona?.handle || p.handle)
                  const displayColor = msgPersona?.color || p.color

                  return (
                    <div
                      key={i}
                      className="flex gap-3 py-2.5"
                      style={{
                        borderBottom: i < replyMessages.length - 1 ? '1px solid var(--color-border)' : 'none',
                        borderLeft: isInterjection ? `2px solid ${displayColor}40` : undefined,
                        paddingLeft: isInterjection ? '8px' : undefined,
                      }}
                    >
                      {/* Avatar */}
                      <div className="flex flex-col items-center">
                        {isUser ? (
                          <div className="w-8 h-8 rounded-full bg-gold/15 flex items-center justify-center text-[11px] font-bold text-gold shrink-0">
                            You
                          </div>
                        ) : msgPersona?.avatar_url ? (
                          <img src={msgPersona.avatar_url} alt={displayName} className="w-8 h-8 rounded-full shrink-0 object-cover" style={{ border: `1.5px solid ${displayColor}50` }} />
                        ) : (
                          <div
                            className="w-8 h-8 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-[11px] font-bold"
                            style={{
                              backgroundColor: displayColor + '22',
                              border: `1.5px solid ${displayColor}50`,
                              color: displayColor,
                            }}
                          >
                            {msgPersona?.initials || p.initials}
                          </div>
                        )}
                        {i < replyMessages.length - 1 && (
                          <div className="w-0.5 flex-1 bg-border mt-1" />
                        )}
                      </div>
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-[13px] font-bold text-text">
                            {displayName}
                          </span>
                          <span className="text-[13px] text-text-muted">
                            {displayHandle}
                          </span>
                          {isInterjection && (
                            <span className="text-[10px] text-text-muted bg-bg-hover border border-border rounded px-1.5 py-px">
                              jumped in
                            </span>
                          )}
                        </div>
                        <div className="text-[13px] text-text-muted mb-1">
                          {isInterjection ? (
                            <>Jumping into this thread</>
                          ) : (
                            <>Replying to <span className="text-gold">{isUser ? p.handle : 'you'}</span></>
                          )}
                        </div>
                        <p className="text-[14px] text-text leading-relaxed whitespace-pre-wrap">
                          <InlineMd text={msg.content} />
                        </p>
                        {/* Reply message actions — mirrors post action bar */}
                        <div className="flex -ml-2 mt-1">
                          <ActionBtn icon={MessageCircle} color="var(--color-persona-practitioner)" onClick={() => inputRef.current?.focus()} label="Reply" />
                          {!isUser && (
                            <div className="relative" ref={zapOpen === i ? zapRef : undefined}>
                              <ActionBtn
                                icon={Repeat2}
                                color="var(--color-retweet)"
                                active={zapOpen === i}
                                onClick={() => setZapOpen(zapOpen === i ? null : i)}
                                label="Pass to persona"
                              />
                              {zapOpen === i && (
                                <div className="absolute bottom-full left-0 mb-1 w-56 bg-bg border border-border rounded-xl shadow-lg overflow-hidden z-20" onClick={e => e.stopPropagation()}>
                                  <div className="px-3 py-2 text-[11px] text-text-muted border-b border-border font-medium">Have a persona respond to this</div>
                                  {allPersonas.filter(pp => pp.personaKey !== (msg.persona || post.persona)).map(pp => (
                                    <button
                                      key={pp.personaKey}
                                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left border-none cursor-pointer hover:bg-bg-hover transition-colors bg-transparent"
                                      onClick={() => handleZap(pp.personaKey, msg.persona || post.persona, msg.content)}
                                    >
                                      {pp.avatar_url ? (
                                        <img src={pp.avatar_url} alt={pp.name} className="w-6 h-6 rounded-full object-cover" style={{ border: `1.5px solid ${pp.color}50` }} />
                                      ) : (
                                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ backgroundColor: pp.color + '22', color: pp.color }}>{pp.initials}</div>
                                      )}
                                      <span className="text-[13px] text-text">{pp.name}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          <ActionBtn icon={Heart} color="var(--color-like)" onClick={() => {}} label="Like" />
                          <ActionBtn icon={Bookmark} color="var(--color-gold)" onClick={() => {}} label="Bookmark" />
                        </div>
                      </div>
                    </div>
                  )
                })}
                {(replyLoading || zapLoading) && (
                  <div className="flex gap-3 py-2.5">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: 'var(--color-persona-hype)' + '22',
                        border: `1.5px solid var(--color-persona-hype)50`,
                      }}
                    >
                      {zapLoading ? <Repeat2 size={14} style={{ color: 'var(--color-retweet)' }} /> : <Loader2 size={14} className="animate-spin" style={{ color: p.color }} />}
                    </div>
                    <div className="flex items-center gap-2 text-[13px] text-text-muted">
                      <Loader2 size={14} className="animate-spin" />
                      <span>{zapLoading ? 'Generating response...' : `${p.name} is typing...`}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Reply input */}
            <div className="flex gap-3 items-start">
              <div className="w-8 h-8 rounded-full bg-gold/15 flex items-center justify-center text-[11px] font-bold text-gold shrink-0 mt-0.5">
                You
              </div>
              <div className="flex-1">
                <div className="text-[13px] text-text-muted mb-1.5">
                  Replying to <span className="text-gold">{p.handle}</span>
                </div>
                <div className="relative">
                  <div className="flex gap-2 items-end">
                    <input
                      ref={inputRef}
                      type="text"
                      value={replyInput}
                      onChange={(e) => {
                        setReplyInput(e.target.value)
                        // Check for @mention autocomplete
                        const val = e.target.value
                        const cursorPos = e.target.selectionStart || val.length
                        const textBeforeCursor = val.slice(0, cursorPos)
                        const mentionMatch = textBeforeCursor.match(/@(\w*)$/)
                        setMentionQuery(mentionMatch ? mentionMatch[1] : null)
                      }}
                      onKeyDown={(e) => {
                        if (mentionQuery !== null && mentionFiltered.length > 0) {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault()
                            setMentionIdx(i => Math.min(i + 1, mentionFiltered.length - 1))
                            return
                          }
                          if (e.key === 'ArrowUp') {
                            e.preventDefault()
                            setMentionIdx(i => Math.max(i - 1, 0))
                            return
                          }
                          if (e.key === 'Enter' || e.key === 'Tab') {
                            e.preventDefault()
                            insertMention(mentionFiltered[mentionIdx])
                            return
                          }
                          if (e.key === 'Escape') {
                            setMentionQuery(null)
                            return
                          }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) handleSendReply()
                      }}
                      placeholder={replyLoading ? `Waiting for ${p.name}...` : 'Post your reply... (@ to mention)'}
                      disabled={replyLoading}
                      className="flex-1 bg-transparent border-none text-[15px] text-text outline-none placeholder:text-text-muted disabled:opacity-50 py-1"
                    />
                    <button
                      onClick={handleSendReply}
                      disabled={!replyInput.trim() || replyLoading}
                      className="px-3.5 py-1.5 rounded-full text-[13px] font-bold border-none cursor-pointer disabled:opacity-30 transition-colors text-bg"
                      style={{ background: replyInput.trim() && !replyLoading ? 'linear-gradient(135deg, var(--color-gold), var(--color-gold-dark))' : 'var(--color-toggle-off)', color: replyInput.trim() && !replyLoading ? 'var(--color-bg)' : 'var(--color-tab-inactive)' }}
                    >
                      Reply
                    </button>
                  </div>
                  {/* @mention autocomplete dropdown */}
                  {mentionQuery !== null && mentionFiltered.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-1 w-64 bg-bg border border-border rounded-xl shadow-lg overflow-hidden z-20">
                      {mentionFiltered.map((mp, i) => (
                        <button
                          key={mp.personaKey}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-left border-none cursor-pointer transition-colors"
                          style={{ backgroundColor: i === mentionIdx ? 'var(--color-bg-hover)' : 'transparent' }}
                          onMouseEnter={() => setMentionIdx(i)}
                          onMouseDown={(e) => { e.preventDefault(); insertMention(mp) }}
                        >
                          {mp.avatar_url ? (
                            <img src={mp.avatar_url} alt={mp.name} className="w-7 h-7 rounded-full object-cover" style={{ border: `1.5px solid ${mp.color}50` }} />
                          ) : (
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ backgroundColor: mp.color + '22', color: mp.color }}>
                              {mp.initials}
                            </div>
                          )}
                          <div>
                            <div className="text-[13px] font-bold text-text">{mp.name}</div>
                            <div className="text-[11px] text-text-muted">{mp.handle}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-gold text-bg text-[12px] font-semibold px-3 py-1.5 rounded-lg shadow-lg z-40 whitespace-nowrap">
          {toast}
        </div>
      )}
    </article>
  )
}
