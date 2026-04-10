import { useState, useRef } from 'react'
import {
  MessageCircle, Repeat2, Heart, Bookmark,
  MoreHorizontal, FileText, ImageIcon, ZoomIn, X, Loader2
} from 'lucide-react'
import { PERSONAS, type FeedPost, type PersonaKey } from '../../types'
import { sendReply, getPostReplies, type ReplyMessage } from '../../lib/api'

function FigureLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
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

function Avatar({ persona }: { persona: PersonaKey }) {
  const p = PERSONAS[persona]
  if (!p) return null
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
  icon: Icon, count, color, active, onClick,
}: {
  icon: typeof MessageCircle
  count: number
  color: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      className="flex items-center gap-[5px] px-2.5 py-1.5 rounded-[20px] text-[13px] flex-1 justify-center max-w-[80px] border-none bg-transparent cursor-pointer transition-all duration-100 hover:opacity-80"
      style={{
        color: active ? color : '#71767b',
        backgroundColor: active ? color + '15' : 'transparent',
      }}
    >
      <Icon
        size={16}
        strokeWidth={active ? 2.5 : 1.75}
        fill={active && color === '#f91880' ? color : 'none'}
      />
      <span>{formatNum(count)}</span>
    </button>
  )
}

interface PostCardProps {
  post: FeedPost
  feedId?: string | null
  postIndex?: number
  bookmarkedId?: string | null
  onBookmarkToggle?: (post: FeedPost, postIndex: number) => void
}

export function PostCard({ post, feedId, postIndex = 0, bookmarkedId, onBookmarkToggle }: PostCardProps) {
  const p = PERSONAS[post.persona]
  const [liked, setLiked] = useState(false)
  const [retweeted, setRetweeted] = useState(false)
  const bookmarked = !!bookmarkedId
  const [figureExpanded, setFigureExpanded] = useState(false)
  const [threadExpanded, setThreadExpanded] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyMessages, setReplyMessages] = useState<ReplyMessage[]>([])
  const [replyInput, setReplyInput] = useState('')
  const [replyLoading, setReplyLoading] = useState(false)
  const [repliesLoaded, setRepliesLoaded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  if (!p) return null

  const isFigure = post.post_type === 'figure'
  const isThread = post.post_type === 'thread' && post.thread_posts && post.thread_posts.length > 0
  const paper = post.paper_ref
  const figSrc = post.figure_url ? `/ficino/api${post.figure_url}` : ''

  const handleOpenReply = async () => {
    setReplyOpen(!replyOpen)
    if (!replyOpen && !repliesLoaded && feedId) {
      try {
        const data = await getPostReplies(feedId, postIndex)
        setReplyMessages(data.messages)
        setRepliesLoaded(true)
      } catch {
        // no existing replies, that's fine
        setRepliesLoaded(true)
      }
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  const handleSendReply = async () => {
    if (!replyInput.trim() || !feedId || replyLoading) return
    setReplyLoading(true)
    try {
      const data = await sendReply(
        feedId, postIndex, post.persona,
        replyInput.trim(), post.content, paper || null,
      )
      setReplyMessages(data.messages)
      setReplyInput('')
    } catch {
      // ignore
    } finally {
      setReplyLoading(false)
    }
  }

  return (
    <div
      className="border-b border-border px-4 py-3.5 flex gap-3 hover:bg-bg-hover transition-colors cursor-pointer"
      style={{
        borderLeft: isFigure ? '3px solid #c8a96e30' : '3px solid transparent',
      }}
    >
      <Avatar persona={post.persona} />

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          <span className="font-bold text-[15px] text-text">{p.name}</span>
          <span className="text-sm text-text-muted">{p.handle}</span>
          <span className="text-sm text-text-muted">·</span>
          <span className="text-sm text-text-muted">{post.time}</span>
          {post.post_type === 'thread' && post.thread_count && (
            <span className="text-[11px] text-gold bg-gold/8 border border-gold/20 rounded px-1.5 py-px font-semibold tracking-wide">
              THREAD {post.thread_count}
            </span>
          )}
          {isFigure && (
            <span className="text-[11px] text-persona-methodologist bg-persona-methodologist/8 border border-persona-methodologist/20 rounded px-1.5 py-px font-semibold tracking-wide inline-flex items-center gap-1">
              <ImageIcon size={9} />
              FIGURE
            </span>
          )}
          <div className="ml-auto">
            <MoreHorizontal size={16} className="text-text-muted" />
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
              <p className="text-[15px] text-text leading-relaxed whitespace-pre-wrap flex-1">
                {post.thread_posts![0]}
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
                    <p className="text-[15px] text-text leading-relaxed whitespace-pre-wrap flex-1">
                      {text}
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
          <p className="my-1 mb-2.5 text-[15px] text-text leading-relaxed whitespace-pre-wrap">
            {post.content}
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
                  className="w-full max-h-[400px] object-contain bg-[#0d0f14]"
                  loading="lazy"
                />
              ) : (
                <div className="h-[150px] flex items-center justify-center text-text-muted text-sm bg-[#0d0f14]">
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
              {post.quoting_content}
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

        {/* Actions */}
        <div className="flex -ml-2 mt-1">
          <ActionBtn icon={MessageCircle} count={post.replies + replyMessages.length} color="#4a9eff" active={replyOpen} onClick={handleOpenReply} />
          <ActionBtn
            icon={Repeat2}
            count={post.retweets + (retweeted ? 1 : 0)}
            color="#34d399"
            active={retweeted}
            onClick={() => setRetweeted(!retweeted)}
          />
          <ActionBtn
            icon={Heart}
            count={post.likes + (liked ? 1 : 0)}
            color="#f91880"
            active={liked}
            onClick={() => setLiked(!liked)}
          />
          <ActionBtn
            icon={Bookmark}
            count={post.bookmarks + (bookmarked ? 1 : 0)}
            color="#c8a96e"
            active={bookmarked}
            onClick={() => onBookmarkToggle?.(post, postIndex)}
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
                  return (
                    <div key={i} className="flex gap-3 py-2.5" style={{ borderBottom: i < replyMessages.length - 1 ? '1px solid #1e2028' : 'none' }}>
                      {/* Avatar */}
                      <div className="flex flex-col items-center">
                        {isUser ? (
                          <div className="w-8 h-8 rounded-full bg-gold/15 flex items-center justify-center text-[11px] font-bold text-gold shrink-0">
                            You
                          </div>
                        ) : (
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                            style={{
                              backgroundColor: p.color + '22',
                              border: `1.5px solid ${p.color}50`,
                              color: p.color,
                            }}
                          >
                            {p.initials}
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
                            {isUser ? 'You' : p.name}
                          </span>
                          <span className="text-[13px] text-text-muted">
                            {isUser ? '' : p.handle}
                          </span>
                        </div>
                        <div className="text-[13px] text-text-muted mb-1">
                          Replying to <span className="text-gold">{isUser ? p.handle : 'you'}</span>
                        </div>
                        <p className="text-[14px] text-text leading-relaxed whitespace-pre-wrap">
                          {msg.content}
                        </p>
                      </div>
                    </div>
                  )
                })}
                {replyLoading && (
                  <div className="flex gap-3 py-2.5">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                      style={{
                        backgroundColor: p.color + '22',
                        border: `1.5px solid ${p.color}50`,
                        color: p.color,
                      }}
                    >
                      {p.initials}
                    </div>
                    <div className="flex items-center gap-2 text-[13px] text-text-muted">
                      <Loader2 size={14} className="animate-spin" />
                      <span>{p.name} is typing...</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Reply input — post-style compose */}
            <div className="flex gap-3 items-start">
              <div className="w-8 h-8 rounded-full bg-gold/15 flex items-center justify-center text-[11px] font-bold text-gold shrink-0 mt-0.5">
                You
              </div>
              <div className="flex-1">
                <div className="text-[13px] text-text-muted mb-1.5">
                  Replying to <span className="text-gold">{p.handle}</span>
                </div>
                <div className="flex gap-2 items-end">
                  <input
                    ref={inputRef}
                    type="text"
                    value={replyInput}
                    onChange={(e) => setReplyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSendReply() }}
                    placeholder="Post your reply..."
                    disabled={replyLoading}
                    className="flex-1 bg-transparent border-none text-[15px] text-text outline-none placeholder:text-text-muted disabled:opacity-50 py-1"
                  />
                  <button
                    onClick={handleSendReply}
                    disabled={!replyInput.trim() || replyLoading}
                    className="px-3.5 py-1.5 rounded-full text-[13px] font-bold border-none cursor-pointer disabled:opacity-30 transition-colors text-bg"
                    style={{ background: replyInput.trim() ? 'linear-gradient(135deg, #c8a96e, #a07840)' : '#1e2028', color: replyInput.trim() ? '#080a0f' : '#555d6e' }}
                  >
                    Reply
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
