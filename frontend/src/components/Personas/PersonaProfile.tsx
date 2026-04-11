import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, MessageCircle, Loader2, Send } from 'lucide-react'
import { usePersonas } from '../../hooks/usePersonas'
import { getPersonaStats, getPersonaDm, sendPersonaDm, type ReplyMessage } from '../../lib/api'
import type { FeedPost } from '../../types'
import { PostCard, InlineMd } from '../Feed/PostCard'

interface PersonaProfileProps {
  personaKey: string
  onBack: () => void
  posts?: FeedPost[]
  feedId?: string | null
}

export function PersonaProfile({ personaKey, onBack, posts, feedId }: PersonaProfileProps) {
  const personas = usePersonas()
  const p = personas[personaKey]
  const [tab, setTab] = useState<'posts' | 'dm'>('posts')
  const [stats, setStats] = useState<{ reply_threads: number } | null>(null)
  const [dmMessages, setDmMessages] = useState<ReplyMessage[]>([])
  const [dmInput, setDmInput] = useState('')
  const [dmLoading, setDmLoading] = useState(false)
  const [dmLoaded, setDmLoaded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getPersonaStats(personaKey).then(setStats).catch(() => {})
  }, [personaKey])

  useEffect(() => {
    if (tab === 'dm' && !dmLoaded) {
      getPersonaDm(personaKey).then((data) => {
        setDmMessages(data.messages)
        setDmLoaded(true)
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      }).catch(() => setDmLoaded(true))
      setTimeout(() => inputRef.current?.focus(), 200)
    }
  }, [tab, personaKey, dmLoaded])

  const handleSendDm = async () => {
    if (!dmInput.trim() || dmLoading) return
    setDmLoading(true)
    try {
      const data = await sendPersonaDm(personaKey, dmInput.trim())
      setDmMessages(data.messages)
      setDmInput('')
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch {
      // ignore
    } finally {
      setDmLoading(false)
    }
  }

  if (!p) return null

  const personaPosts = posts?.filter(post => post.persona === personaKey) || []

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3 flex items-center gap-4">
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors"
          aria-label="Back"
        >
          <ArrowLeft size={18} className="text-text" />
        </button>
        <div>
          <div className="font-bold text-[15px] text-text">{p.name}</div>
          <div className="text-xs text-text-muted">{personaPosts.length} posts</div>
        </div>
      </div>

      {/* Profile banner area */}
      <div className="px-4 pt-4 pb-3">
        {/* Avatar + name */}
        <div className="flex items-start gap-4">
          {p.avatar_url ? (
            <img
              src={p.avatar_url}
              alt={p.name}
              className="w-20 h-20 rounded-full object-cover"
              style={{ border: `3px solid ${p.color}60` }}
            />
          ) : (
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold"
              style={{ backgroundColor: p.color + '28', border: `3px solid ${p.color}60`, color: p.color }}
            >
              {p.initials}
            </div>
          )}
          <div className="flex-1 min-w-0 pt-1">
            <div className="text-xl font-bold text-text">{p.name}</div>
            <div className="text-[15px] text-text-muted">{p.handle}</div>
          </div>
          {/* DM button */}
          <button
            onClick={() => setTab('dm')}
            className="mt-1 w-10 h-10 rounded-full flex items-center justify-center border cursor-pointer hover:bg-bg-hover transition-colors"
            style={{
              borderColor: p.color + '40',
              backgroundColor: tab === 'dm' ? p.color + '15' : 'transparent',
              color: p.color,
            }}
            aria-label={`Message ${p.name}`}
          >
            <MessageCircle size={18} />
          </button>
        </div>

        {/* Bio */}
        {p.bio && (
          <p className="mt-3 text-[14px] text-text leading-relaxed">
            {p.bio}
          </p>
        )}

        {/* Stats */}
        <div className="flex items-center gap-4 mt-3 text-[13px]">
          <span>
            <span className="font-bold text-text">{personaPosts.length}</span>
            <span className="text-text-muted ml-1">posts</span>
          </span>
          {stats && (
            <span>
              <span className="font-bold text-text">{stats.reply_threads}</span>
              <span className="text-text-muted ml-1">conversations</span>
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab('posts')}
          className="flex-1 py-3 border-none bg-transparent cursor-pointer text-[15px] transition-all"
          style={{
            color: tab === 'posts' ? 'var(--color-tab-active)' : 'var(--color-tab-inactive)',
            fontWeight: tab === 'posts' ? 700 : 400,
            borderBottom: tab === 'posts' ? `2px solid ${p.color}` : '2px solid transparent',
          }}
        >
          Posts
        </button>
        <button
          onClick={() => setTab('dm')}
          className="flex-1 py-3 border-none bg-transparent cursor-pointer text-[15px] transition-all"
          style={{
            color: tab === 'dm' ? 'var(--color-tab-active)' : 'var(--color-tab-inactive)',
            fontWeight: tab === 'dm' ? 700 : 400,
            borderBottom: tab === 'dm' ? `2px solid ${p.color}` : '2px solid transparent',
          }}
        >
          Messages
        </button>
      </div>

      {/* Content */}
      {tab === 'posts' ? (
        <div>
          {personaPosts.length === 0 ? (
            <div className="py-16 text-center text-text-muted text-sm">
              No posts from {p.name} in the current feed.
            </div>
          ) : (
            personaPosts.map((post, i) => {
              const originalIndex = posts?.indexOf(post) ?? i
              return (
                <PostCard
                  key={post.id ?? i}
                  post={post}
                  feedId={feedId}
                  postIndex={originalIndex}
                />
              )
            })
          )}
        </div>
      ) : (
        <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 350px)' }}>
          {/* DM conversation */}
          <div className="flex-1 overflow-y-auto">
            {!dmLoaded ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={24} className="animate-spin" style={{ color: p.color }} />
              </div>
            ) : dmMessages.length === 0 ? (
              <div className="py-16 px-6 text-center">
                <div className="mb-3">
                  {p.avatar_url ? (
                    <img src={p.avatar_url} alt={p.name} className="w-16 h-16 rounded-full mx-auto object-cover" style={{ border: `2px solid ${p.color}50` }} />
                  ) : (
                    <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center text-xl font-bold" style={{ backgroundColor: p.color + '22', color: p.color }}>
                      {p.initials}
                    </div>
                  )}
                </div>
                <p className="text-[15px] font-semibold text-text mb-1">Message {p.name}</p>
                <p className="text-[13px] text-text-muted">
                  Ask questions about your corpus. {p.name} responds in character, grounded in your papers.
                </p>
              </div>
            ) : (
              <div className="py-3">
                {dmMessages.map((msg, i) => {
                  const isUser = msg.role === 'user'
                  return (
                    <div key={i} className="flex gap-3 px-4 py-2.5">
                      {isUser ? (
                        <div className="w-8 h-8 rounded-full bg-gold/15 flex items-center justify-center text-[11px] font-bold text-gold shrink-0">
                          You
                        </div>
                      ) : p.avatar_url ? (
                        <img src={p.avatar_url} alt={p.name} className="w-8 h-8 rounded-full shrink-0 object-cover" style={{ border: `1.5px solid ${p.color}50` }} />
                      ) : (
                        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold" style={{ backgroundColor: p.color + '22', border: `1.5px solid ${p.color}50`, color: p.color }}>
                          {p.initials}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-bold text-text">
                          {isUser ? 'You' : p.name}
                        </span>
                        <p className="text-[14px] text-text leading-relaxed mt-0.5 whitespace-pre-wrap">
                          <InlineMd text={msg.content} />
                        </p>
                      </div>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* DM input */}
          <div className="sticky bottom-0 border-t border-border bg-bg px-4 py-3">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={dmInput}
                onChange={(e) => setDmInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendDm() } }}
                placeholder={`Message ${p.handle}...`}
                className="flex-1 bg-bg-hover border border-border rounded-full px-4 py-2.5 text-[14px] text-text outline-none focus:border-gold/40 transition-colors"
                disabled={dmLoading}
              />
              <button
                onClick={handleSendDm}
                disabled={!dmInput.trim() || dmLoading}
                className="w-10 h-10 rounded-full flex items-center justify-center border-none cursor-pointer disabled:opacity-30 transition-colors"
                style={{ backgroundColor: p.color, color: '#080a0f' }}
              >
                {dmLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
