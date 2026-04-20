import { memo, useState, useRef, useEffect } from 'react'
import {
  MessageCircle, Repeat2, Heart, Bookmark,
  MoreHorizontal, FileText, ImageIcon, ZoomIn, Loader2,
  RefreshCw, EyeOff, Bug, Copy, Quote, StickyNote, Trash2
} from 'lucide-react'
import type { FeedPost } from '../../types'
import { sendReply, sendZap, getPostReplies, getCitation, regeneratePost, deletePost, updateSettings, deleteReplyMessage, type ReplyMessage } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'
import { InlineMd } from './_shared/InlineMd'
import { FigureLightbox } from './_shared/FigureLightbox'
import { Avatar } from './_shared/Avatar'
import { formatNum } from './_shared/formatNum'
import { haptic } from '../../hooks/useHaptic'
import { SwipeToAct } from '../_shared/SwipeToAct'

// Re-export for existing consumers that imported InlineMd from PostCard.
export { InlineMd } from './_shared/InlineMd'

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
      className="flex items-center gap-[5px] px-3 py-2.5 rounded-[20px] text-[13px] flex-1 justify-center max-w-[80px] min-h-[44px] border-none bg-transparent cursor-pointer transition-all duration-100"
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

function MenuItem({
  icon: Icon, label, onClick, color, disabled, iconClassName,
}: {
  icon: typeof MessageCircle
  label: string
  onClick: (e: React.MouseEvent) => void
  color?: string
  disabled?: boolean
  iconClassName?: string
}) {
  return (
    <button
      role="menuitem"
      className="w-full flex items-center gap-3 text-left px-4 py-2.5 text-[14px] hover:bg-bg-hover bg-transparent border-none cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default"
      style={{ color: color || 'var(--color-text)' }}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={1.75} className={`shrink-0 ${iconClassName || ''}`} style={{ color: color || 'var(--color-text-muted)' }} />
      {label}
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
  liked?: boolean
  onLikeToggle?: (postIndex: number, personaKey: string, postType: string, category?: string) => void
  isReplyLiked?: (postIndex: number, messageIndex: number) => boolean
  onReplyLikeToggle?: (postIndex: number, messageIndex: number, personaKey?: string) => void
  onReplyBookmark?: (feedId: string, postIndex: number, messageIndex: number, snapshot: Record<string, unknown>) => void
  isReplyBookmarked?: (postIndex: number, messageIndex: number) => boolean
  onPostRegenerated?: () => void
  onPostDeleted?: (postIndex: number) => void
  // Optional vertical rail drawn inside the avatar column, used by threaded
  // views (e.g. the profile Replies tab) to visually chain parent → child.
  // 'below' draws a rail from just under the avatar to the card's bottom
  // edge. 'above' draws one from the card's top edge to just above the
  // avatar. Combining 'below' on the parent and 'above' on the reply
  // produces a continuous Twitter-style connector across the two cards.
  threadConnector?: 'below' | 'above' | 'both'
}

function PostCardImpl({ post, feedId, postIndex = 0, bookmarkedId, onBookmarkToggle, onClick, hasUserReply, annotation, onAnnotationSave, onAnnotationDelete, onPersonaClick, autoOpenReply, liked = false, onLikeToggle, isReplyLiked, onReplyLikeToggle, onReplyBookmark, isReplyBookmarked, onPostRegenerated, onPostDeleted, threadConnector }: PostCardProps) {
  const personas = usePersonas()
  const p = personas[post.persona]
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
  // Menu uses a document-level click-outside handler instead of a
  // fixed-inset overlay because every PostCard is wrapped in SwipeToAct,
  // which applies `transform: translateX(...)` and creates a stacking
  // context — overlays positioned with `fixed inset-0` inside a
  // transformed parent are clipped to that parent's bounds, not the
  // viewport. A click on another post's 3-dot would never land on the
  // overlay and the first menu would stay stuck open.
  const menuWrapperRef = useRef<HTMLDivElement>(null)
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
  // Per-reply-message 3-dot menu. Tracks which message index currently has
  // its menu open; null = none. Parallel to zapOpen so each message can
  // toggle its overflow actions independently.
  const [msgMenuOpen, setMsgMenuOpen] = useState<number | null>(null)
  const msgMenuRef = useRef<HTMLDivElement>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
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

  // Close the 3-dot post menu on click outside or Escape. Document-level
  // listener rather than an overlay so it works even when the card is
  // inside SwipeToAct's transformed subtree (which creates a stacking
  // context and clips fixed-inset overlays to the card bounds).
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuWrapperRef.current && !menuWrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

  // Same click-outside / Escape pattern for the per-message 3-dot menu.
  useEffect(() => {
    if (msgMenuOpen === null) return
    const handleClick = (e: MouseEvent) => {
      if (msgMenuRef.current && !msgMenuRef.current.contains(e.target as Node)) {
        setMsgMenuOpen(null)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMsgMenuOpen(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [msgMenuOpen])

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
  // figure_url may be absolute (Supabase signed URL on SaaS) or relative
  // (self-host `/figures/…?token=…`). Prefix apiBase only for the relative
  // case — blindly concatenating onto an absolute URL produces
  // "<apiBase>https://supabase.co/…" which the browser parses as a bogus
  // host and 404s.
  const figSrc = !post.figure_url
    ? ''
    : /^https?:\/\//i.test(post.figure_url)
      ? post.figure_url
      : `${apiBase}${post.figure_url}`

  return (
    <SwipeToAct
      onSwipeLeft={onLikeToggle ? () => onLikeToggle(postIndex, post.persona, post.post_type, post.category) : undefined}
      onSwipeRight={() => { setReplyOpen(true); haptic(10) }}
      // Disable during reply edit (the reply textarea gets horizontal drags)
      // and while a menu or zap panel is open so the user isn't fighting
      // the gesture for the surface they care about.
      disabled={replyOpen || menuOpen || zapOpen !== null}
    >
    <article
      className="border-b border-border px-4 py-3.5 flex gap-3 hover:bg-bg-hover transition-colors cursor-pointer relative"
      style={{
        borderLeft: isFigure ? '3px solid color-mix(in srgb, var(--color-gold) 19%, transparent)' : '3px solid transparent',
      }}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        // Only trigger when the article itself is focused (not nested buttons/inputs)
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      } : undefined}
    >
      {/* Thread connector rail. Positioned so its center-X aligns with the
          avatar center (px-4=16 + avatar-half=21 = 37), width 2px.
          'below': starts 2px under the avatar and runs to the card's bottom
          edge. 'above': runs from the card's top edge to 2px above the
          avatar. Combined on adjacent cards, this produces Twitter's
          continuous reply-chain rail. */}
      {(threadConnector === 'below' || threadConnector === 'both') && (
        <div
          aria-hidden="true"
          className="absolute bg-border"
          style={{ left: 36, top: 58, bottom: 0, width: 2 }}
        />
      )}
      {(threadConnector === 'above' || threadConnector === 'both') && (
        <div
          aria-hidden="true"
          className="absolute bg-border"
          style={{ left: 36, top: 0, height: 12, width: 2 }}
        />
      )}
      <Avatar persona={post.persona} />

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          <button
            type="button"
            className="font-bold text-[15px] text-text hover:underline cursor-pointer bg-transparent border-0 p-0 text-left"
            onClick={(e) => { e.stopPropagation(); onPersonaClick?.(post.persona) }}
          >{p.name}</button>
          <button
            type="button"
            className="text-sm text-text-muted hover:underline cursor-pointer bg-transparent border-0 p-0 text-left"
            onClick={(e) => { e.stopPropagation(); onPersonaClick?.(post.persona) }}
          >{p.handle}</button>
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
          <div ref={menuWrapperRef} className="ml-auto relative">
            <button
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="bg-transparent border-none cursor-pointer p-1 hover:bg-bg-hover rounded-full"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
            >
              <MoreHorizontal size={16} className="text-text-muted" />
            </button>
            {menuOpen && (
              <>
                <div role="menu" className="absolute right-0 top-8 z-30 bg-bg border border-border rounded-xl shadow-[0_4px_24px_rgba(0,0,0,0.35)] py-1.5 min-w-[220px] max-w-[calc(100vw-2rem)]">
                  <MenuItem icon={Copy} label="Copy text" onClick={(e) => {
                    e.stopPropagation(); setMenuOpen(false)
                    const text = isThread && post.thread_posts ? post.thread_posts.join('\n\n') : post.content
                    copyToClipboard(text, 'Post text')
                  }} />
                  {post.sources && post.sources.length > 0 && (
                    <>
                      <MenuItem icon={Quote} label="Cite (APA)" onClick={(e) => { e.stopPropagation(); setMenuOpen(false); handleCite('apa') }} />
                      <MenuItem icon={Quote} label="Cite (MLA)" onClick={(e) => { e.stopPropagation(); setMenuOpen(false); handleCite('mla') }} />
                    </>
                  )}
                  <div className="border-t border-border my-1.5 mx-3" />
                  <MenuItem icon={StickyNote} label={annotation ? 'Edit note' : 'Add note'} onClick={(e) => {
                    e.stopPropagation(); setMenuOpen(false)
                    setNoteText(annotation || ''); setNoteEditing(true)
                    setTimeout(() => noteRef.current?.focus(), 50)
                  }} />
                  {annotation && (
                    <MenuItem icon={Trash2} label="Remove note" color="var(--color-persona-skeptic)" onClick={(e) => {
                      e.stopPropagation(); setMenuOpen(false)
                      if (feedId) onAnnotationDelete?.(feedId, postIndex)
                    }} />
                  )}
                  <div className="border-t border-border my-1.5 mx-3" />
                  <MenuItem
                    icon={RefreshCw}
                    label={regenerating ? 'Regenerating...' : 'Regenerate'}
                    iconClassName={regenerating ? 'animate-spin' : ''}
                    disabled={regenerating}
                    onClick={async (e) => {
                      e.stopPropagation(); setMenuOpen(false)
                      if (!feedId) return
                      setRegenerating(true)
                      try {
                        await regeneratePost(feedId, postIndex)
                        setToast('Regenerating post...')
                        setTimeout(() => { onPostRegenerated?.(); setRegenerating(false) }, 4000)
                      } catch { setToast('Failed to regenerate'); setRegenerating(false) }
                    }}
                  />
                  <MenuItem icon={EyeOff} label={`Hide ${p.name}`} onClick={async (e) => {
                    e.stopPropagation(); setMenuOpen(false)
                    try {
                      await updateSettings({ personas_enabled: { [post.persona]: false } })
                      setToast(`${p.name} hidden from future feeds`)
                    } catch { setToast('Failed to update settings') }
                  }} />
                  <MenuItem
                    icon={Trash2}
                    label={deleting ? 'Deleting...' : confirmingDelete ? 'Click again to confirm' : 'Delete post'}
                    color="var(--color-persona-skeptic)"
                    disabled={deleting}
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!feedId) return
                      if (!confirmingDelete) {
                        setConfirmingDelete(true)
                        setTimeout(() => setConfirmingDelete(false), 3000)
                        return
                      }
                      setDeleting(true)
                      try {
                        await deletePost(feedId, postIndex)
                        setToast('Post deleted')
                        setMenuOpen(false)
                        setConfirmingDelete(false)
                        onPostDeleted?.(postIndex)
                      } catch {
                        setToast('Failed to delete post')
                      } finally {
                        setDeleting(false)
                      }
                    }}
                  />
                  {import.meta.env.DEV && (
                    <>
                      <div className="border-t border-border my-1.5 mx-3" />
                      <MenuItem icon={Bug} label={debugOpen ? 'Hide debug' : 'Debug view'} color="var(--color-text-muted)" onClick={(e) => {
                        e.stopPropagation(); setMenuOpen(false); setDebugOpen(!debugOpen)
                      }} />
                    </>
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

        {/* Figure block. A real <button> (type="button" so it doesn't
            submit any enclosing form, unstyled to preserve the layout)
            so keyboard users can activate the lightbox with Enter /
            Space — SR users hear the label instead of "image button". */}
        {isFigure && (post.figure_caption || post.figure_url) && (
          <div className="mb-2.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); if (figSrc) setFigureExpanded(true) }}
              aria-label={figSrc ? (post.figure_caption ? `Zoom figure: ${post.figure_caption}` : 'Zoom figure') : 'Figure not available'}
              disabled={!figSrc}
              className="block w-full p-0 text-left border border-border rounded-xl overflow-hidden bg-bg-hover relative cursor-zoom-in hover:border-gold/25 transition-colors disabled:cursor-default"
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
            </button>
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

        {/* Quote block — Twitter-style nested post card. Renders the quoted
            persona's avatar + name + @handle inline at the top of a rounded
            border box, with the quoted content below. Matches how Twitter
            displays a quote-tweet: the quoted post is embedded inside the
            quoter's post, with no action bar of its own. Previously showed
            only the handle string and content text — visually inconsistent
            with the rest of the app, which always displays persona identity
            with an avatar. */}
        {post.post_type === 'quote' && post.quoting_content && (() => {
          // Handles are unique per persona. Look up the full persona by
          // handle so we can render avatar + name. If the handle doesn't
          // resolve (legacy post, renamed persona), fall back to a handle-
          // only header.
          const quoted = Object.entries(personas).find(
            ([, pp]) => pp.handle === post.quoting_handle,
          )
          const quotedKey = quoted?.[0]
          const quotedPersona = quoted?.[1]
          return (
            <div
              role={quotedKey && onPersonaClick ? 'button' : undefined}
              tabIndex={quotedKey && onPersonaClick ? 0 : undefined}
              aria-label={quotedKey && onPersonaClick && quotedPersona
                ? `Open ${quotedPersona.name} profile`
                : undefined
              }
              className="border border-border rounded-2xl px-3.5 py-3 mb-2.5 bg-transparent cursor-pointer hover:bg-bg-hover transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                if (quotedKey && onPersonaClick) onPersonaClick(quotedKey)
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && quotedKey && onPersonaClick) {
                  e.preventDefault()
                  e.stopPropagation()
                  onPersonaClick(quotedKey)
                }
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                {quotedPersona && (
                  quotedPersona.avatar_url ? (
                    <img
                      src={quotedPersona.avatar_url}
                      alt={quotedPersona.name}
                      className="w-5 h-5 rounded-full shrink-0 object-cover"
                      style={{ border: `1.5px solid ${quotedPersona.color}50` }}
                    />
                  ) : (
                    <div
                      className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold"
                      style={{
                        backgroundColor: quotedPersona.color + '22',
                        color: quotedPersona.color,
                        border: `1.5px solid ${quotedPersona.color}50`,
                      }}
                    >
                      {quotedPersona.initials}
                    </div>
                  )
                )}
                {quotedPersona?.name && (
                  <span className="text-[14px] font-bold text-text truncate">
                    {quotedPersona.name}
                  </span>
                )}
                <span className="text-[14px] text-text-muted truncate">
                  {post.quoting_handle}
                </span>
              </div>
              <div className="text-[14px] text-text leading-snug">
                <InlineMd text={post.quoting_content || ''} />
              </div>
            </div>
          )
        })()}

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
                      <span className="text-text-subtle shrink-0 text-[10px] ml-auto">{(src.score * 100).toFixed(0)}%</span>
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

        {/* Debug view (dev only) */}
        {debugOpen && (
          <div className="mb-2 border border-border rounded-lg p-3 bg-bg text-[11px] font-mono space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="text-[10px] text-text-muted uppercase tracking-wider font-semibold flex items-center gap-1.5 mb-1">
              <Bug size={10} /> Post metadata
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <span className="text-text-muted">persona</span>
              <span className="text-text">{post.persona}</span>
              <span className="text-text-muted">post_type</span>
              <span className="text-text">{post.post_type}</span>
              <span className="text-text-muted">category</span>
              <span className="text-text">{post.category}</span>
              <span className="text-text-muted">paper_ref</span>
              <span className="text-text truncate">{post.paper_ref || '—'}</span>
              <span className="text-text-muted">post_index</span>
              <span className="text-text">{postIndex}</span>
              <span className="text-text-muted">feed_id</span>
              <span className="text-text truncate">{feedId || '—'}</span>
              {post.replying_to && <>
                <span className="text-text-muted">replying_to</span>
                <span className="text-text">{post.replying_to}</span>
              </>}
              {post.quoting_handle && <>
                <span className="text-text-muted">quoting</span>
                <span className="text-text">{post.quoting_handle}</span>
              </>}
              {'regenerated' in post && <>
                <span className="text-text-muted">regenerated</span>
                <span className="text-gold">true</span>
              </>}
            </div>
            {post.sources && post.sources.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border">
                <div className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-1">Retrieved chunks ({post.sources.length})</div>
                {post.sources.map((src, si) => (
                  <div key={si} className="mt-1 pl-2 border-l border-border">
                    <div className="text-text-muted">[{si}] {src.paper_title} / {src.section} — score: {src.score}</div>
                    <div className="text-text/60 line-clamp-2">{src.content}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Annotation display. role + tabIndex + onKeyDown so keyboard
            users can re-open the note editor with Enter or Space instead
            of losing access the moment the note is saved. */}
        {annotation && !noteEditing && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Edit note"
            className="mb-2 px-3 py-2 border-l-2 border-gold/30 bg-gold/4 rounded-r-lg cursor-pointer hover:bg-gold/8 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              setNoteText(annotation)
              setNoteEditing(true)
              setTimeout(() => noteRef.current?.focus(), 50)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setNoteText(annotation)
                setNoteEditing(true)
                setTimeout(() => noteRef.current?.focus(), 50)
              }
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
              <div className="absolute bottom-full left-0 mb-1 w-56 max-w-[calc(100vw-2rem)] bg-bg border border-border rounded-xl shadow-lg overflow-hidden z-20" onClick={e => e.stopPropagation()}>
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
            onClick={() => { haptic(10); onLikeToggle?.(postIndex, post.persona, post.post_type, post.category) }}
            label="Like"
          />
          <ActionBtn
            icon={Bookmark}
            count={post.bookmarks + (bookmarked ? 1 : 0)}
            color="var(--color-gold)"
            active={bookmarked}
            onClick={() => { haptic(10); onBookmarkToggle?.(post, postIndex) }}
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
                                <div className="absolute bottom-full left-0 mb-1 w-56 max-w-[calc(100vw-2rem)] bg-bg border border-border rounded-xl shadow-lg overflow-hidden z-20" onClick={e => e.stopPropagation()}>
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
                          <ActionBtn
                            icon={Heart}
                            color="var(--color-like)"
                            active={isReplyLiked?.(postIndex, i) ?? false}
                            onClick={() => onReplyLikeToggle?.(postIndex, i, isUser ? undefined : (msg.persona || post.persona))}
                            label="Like"
                          />
                          <ActionBtn
                            icon={Bookmark}
                            color="var(--color-gold)"
                            active={isReplyBookmarked?.(postIndex, i) ?? false}
                            onClick={() => feedId && onReplyBookmark?.(feedId, postIndex, i, {
                              role: msg.role,
                              content: msg.content,
                              persona: msg.persona || post.persona,
                              persona_name: displayName,
                              persona_handle: displayHandle,
                              parent_post_persona: post.persona,
                              parent_post_content: post.content?.slice(0, 200),
                            })}
                            label="Bookmark"
                          />
                          {/* Per-message 3-dot menu. Previously there was no way
                              to remove a single interjection or reply — the whole
                              thread was kept or nothing. Copy + Delete covers the
                              day-to-day use; per-persona hide already lives on
                              the parent post's menu. */}
                          <div className="relative" ref={msgMenuOpen === i ? msgMenuRef : undefined}>
                            <button
                              type="button"
                              aria-label="More options"
                              aria-haspopup="menu"
                              aria-expanded={msgMenuOpen === i}
                              className="bg-transparent border-none cursor-pointer p-1 ml-1 hover:bg-bg-hover rounded-full"
                              onClick={(e) => {
                                e.stopPropagation()
                                setMsgMenuOpen(msgMenuOpen === i ? null : i)
                              }}
                            >
                              <MoreHorizontal size={14} className="text-text-muted" />
                            </button>
                            {msgMenuOpen === i && (
                              <div
                                role="menu"
                                className="absolute right-0 bottom-full mb-1 z-30 bg-bg border border-border rounded-xl shadow-[0_4px_24px_rgba(0,0,0,0.35)] py-1.5 min-w-[200px] max-w-[calc(100vw-2rem)]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MenuItem
                                  icon={Copy}
                                  label="Copy text"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setMsgMenuOpen(null)
                                    copyToClipboard(msg.content, 'Message text')
                                  }}
                                />
                                {!isUser && (
                                  <MenuItem
                                    icon={Trash2}
                                    label="Delete message"
                                    color="var(--color-persona-skeptic)"
                                    onClick={async (e) => {
                                      e.stopPropagation()
                                      setMsgMenuOpen(null)
                                      if (!feedId) return
                                      try {
                                        await deleteReplyMessage(feedId, postIndex, i)
                                        // Optimistic local removal; server write is already committed.
                                        setReplyMessages(prev => prev.filter((_, idx) => idx !== i))
                                      } catch {
                                        setToast('Failed to delete message')
                                      }
                                    }}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {(replyLoading || zapLoading) && (
                  <div role="status" aria-live="polite" aria-atomic="true" className="flex gap-3 py-2.5">
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
                      aria-label={`Reply to ${p.name}`}
                      role="combobox"
                      aria-expanded={mentionQuery !== null && mentionFiltered.length > 0}
                      aria-controls="mention-listbox"
                      aria-autocomplete="list"
                      aria-activedescendant={
                        mentionQuery !== null && mentionFiltered.length > 0 && mentionIdx >= 0
                          ? `mention-option-${mentionIdx}`
                          : undefined
                      }
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
                    <ul
                      role="listbox"
                      id="mention-listbox"
                      className="absolute bottom-full left-0 mb-1 w-64 max-w-[calc(100vw-2rem)] bg-bg border border-border rounded-xl shadow-lg overflow-hidden z-20 list-none p-0 m-0"
                    >
                      {mentionFiltered.map((mp, i) => (
                        <li
                          key={mp.personaKey}
                          role="option"
                          id={`mention-option-${i}`}
                          aria-selected={i === mentionIdx}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-left cursor-pointer transition-colors list-none"
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
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div role="status" aria-live="polite" aria-atomic="true" className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-gold text-bg text-[12px] font-semibold px-3 py-1.5 rounded-lg shadow-lg z-40 whitespace-nowrap">
          {toast}
        </div>
      )}
    </article>
    </SwipeToAct>
  )
}

/**
 * Re-render only when data or flags that PostCard visibly depends on change.
 *
 * Callback identity is intentionally NOT in the comparator — Feed.tsx passes
 * inline arrow functions for onBookmarkToggle/onClick/onPostDeleted that
 * change every render. Including them would defeat the memo.
 *
 * Reference equality on `post` works because the feed array is rebuilt only
 * when the server returns new post data; an intermediate `posts.filter(...)`
 * preserves the underlying object refs.
 */
function arePostsEqual(prev: PostCardProps, next: PostCardProps): boolean {
  return (
    prev.post === next.post &&
    prev.feedId === next.feedId &&
    prev.postIndex === next.postIndex &&
    prev.liked === next.liked &&
    prev.bookmarkedId === next.bookmarkedId &&
    prev.hasUserReply === next.hasUserReply &&
    prev.annotation === next.annotation &&
    prev.autoOpenReply === next.autoOpenReply
  )
}

export const PostCard = memo(PostCardImpl, arePostsEqual)
