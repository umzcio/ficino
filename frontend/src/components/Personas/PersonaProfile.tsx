import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Loader2, Send, MessagesSquare } from 'lucide-react'
import { usePersonas } from '../../hooks/usePersonas'
import { getPersonaStats, getPersonaDm, sendPersonaDm, getPersonaReplies, listUserPosts, type ReplyMessage, type PersonaReplyItem, type UserPost } from '../../lib/api'
import type { FeedPost } from '../../types'
import { PostCard, InlineMd } from '../Feed/PostCard'
import { UserPostCard } from '../Feed/UserPostCard'
import { SwipeBackEdge } from '../_shared/SwipeBackEdge'

interface PersonaProfileProps {
  personaKey: string
  onBack: () => void
  posts?: FeedPost[]
  feedId?: string | null
  onGenerateTake?: (personaKey: string) => void
  generating?: boolean
  canGenerate?: boolean
}

export function PersonaProfile({ personaKey, onBack, posts, feedId, onGenerateTake, generating, canGenerate }: PersonaProfileProps) {
  const personas = usePersonas()
  const p = personas[personaKey]
  const [tab, setTab] = useState<'posts' | 'replies' | 'dm'>('posts')
  const [stats, setStats] = useState<{ reply_threads: number } | null>(null)
  const [dmMessages, setDmMessages] = useState<ReplyMessage[]>([])
  const [dmInput, setDmInput] = useState('')
  const [dmLoading, setDmLoading] = useState(false)
  const [dmLoaded, setDmLoaded] = useState(false)
  // Interjections this persona made across the user's feeds — the
  // "jumped in" messages that don't show under the Posts tab because
  // they aren't top-level posts.
  const [replies, setReplies] = useState<PersonaReplyItem[]>([])
  const [repliesLoaded, setRepliesLoaded] = useState(false)
  // The Archivist is reply-only + not feed-eligible, so its standard
  // Posts tab is always empty. Instead, surface the user's Ask-Your-
  // Corpus posts (user_posts with inline Archivist replies) — that's
  // the work the Archivist actually does.
  const isArchivist = personaKey === 'archivist'
  const [corpusPosts, setCorpusPosts] = useState<UserPost[]>([])
  const [corpusPostsLoaded, setCorpusPostsLoaded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getPersonaStats(personaKey).then(setStats).catch(() => {})
  }, [personaKey])

  // NOTE: per-persona local state (repliesLoaded, dmLoaded, drafts, etc.)
  // is reset by a `key={personaKey}` at the parent in App.tsx. That makes
  // React remount this subtree on every persona switch, so there is no
  // need for manual reset effects here — and no class of "forgot to
  // reset flag X when personaKey changed" bugs.

  // Lazy-load replies the first time the user opens the Replies tab. Avoids
  // paying the extra SQL pass for users who never view the tab.
  useEffect(() => {
    if (tab === 'replies' && !repliesLoaded) {
      getPersonaReplies(personaKey)
        .then(setReplies)
        .catch(() => setReplies([]))
        .finally(() => setRepliesLoaded(true))
    }
  }, [tab, personaKey, repliesLoaded])

  // Lazy-load corpus Q&A for the Archivist's Posts tab.
  useEffect(() => {
    if (isArchivist && tab === 'posts' && !corpusPostsLoaded) {
      listUserPosts()
        .then(setCorpusPosts)
        .catch(() => setCorpusPosts([]))
        .finally(() => setCorpusPostsLoaded(true))
    }
  }, [isArchivist, tab, corpusPostsLoaded])

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

  // Build the persona's posts list and an id→original-index map in
  // one pass instead of calling posts.indexOf() per iteration inside
  // the render map below (which was O(N×M): 50 posts × 20 of this
  // persona = 1000 linear scans per re-render).
  const personaPosts: FeedPost[] = []
  const originalIndexByPost = new Map<FeedPost, number>()
  if (posts) {
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i]
      if (post.persona === personaKey && !post.deleted) {
        personaPosts.push(post)
        originalIndexByPost.set(post, i)
      }
    }
  }

  return (
    <div>
      <SwipeBackEdge onBack={onBack} />
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
          {/* Get their take button — generates 3 posts from this persona,
              appended to current feed. Hidden for the Archivist because the
              Archivist is reply-only / feed_eligible=false; its "work" is
              answering corpus questions, not publishing posts. */}
          {onGenerateTake && !isArchivist && (
            <button
              onClick={() => onGenerateTake(personaKey)}
              disabled={generating || !canGenerate}
              className="mt-1 px-4 py-2 rounded-full flex items-center gap-1.5 border cursor-pointer hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[13px] font-semibold"
              style={{
                borderColor: p.color + '40',
                backgroundColor: p.color + '10',
                color: p.color,
              }}
              aria-label={`Get a take from ${p.name}`}
              title={canGenerate ? `Generate 3 posts from ${p.name} on your corpus` : 'Upload papers first'}
            >
              {generating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <MessagesSquare size={14} />
              )}
              <span>{generating ? 'Generating...' : 'Get their take'}</span>
            </button>
          )}
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
      <PersonaTabs active={tab} onSelect={setTab} accentColor={p.color} isArchivist={isArchivist} />

      {/* Content */}
      {tab === 'posts' && (
        <div
          role="tabpanel"
          id="persona-panel-posts"
          aria-labelledby="persona-tab-posts"
          tabIndex={0}
        >
          {isArchivist ? (
            !corpusPostsLoaded ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin" style={{ color: p.color }} />
              </div>
            ) : corpusPosts.length === 0 ? (
              <div className="py-16 text-center text-text-muted text-sm">
                No corpus questions yet. Use the compose box on the feed to ask {p.name} a question.
              </div>
            ) : (
              corpusPosts.map((post) => (
                <UserPostCard
                  key={post.id}
                  post={post}
                  userDisplayName="You"
                  userHandle="@you"
                />
              ))
            )
          ) : personaPosts.length === 0 ? (
            <div className="py-16 text-center text-text-muted text-sm">
              No posts from {p.name} in the current feed.
            </div>
          ) : (
            personaPosts.map((post, i) => {
              const originalIndex = originalIndexByPost.get(post) ?? i
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
      )}
      {tab === 'replies' && (
        <div
          role="tabpanel"
          id="persona-panel-replies"
          aria-labelledby="persona-tab-replies"
          tabIndex={0}
        >
          {!repliesLoaded ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin" style={{ color: p.color }} />
            </div>
          ) : replies.length === 0 ? (
            <div className="py-16 text-center text-text-muted text-sm">
              {p.name} hasn't jumped into any conversations yet.
            </div>
          ) : (
            replies.map((r) => {
              // Twitter-style profile replies: render the parent post AND the
              // interjection using the SAME PostCard the rest of the app uses.
              // The interjection is wrapped as a synthetic FeedPost with
              // post_type='reply' and a replying_to pointer, so PostCard's
              // existing "Replying to …" styling kicks in naturally.
              const parentPersona = r.parent_post.persona ? personas[r.parent_post.persona] : null
              const parentHandle = parentPersona?.handle || `@${r.parent_post.persona ?? 'unknown'}`
              const syntheticReply: FeedPost = {
                // Synthetic id scoped to the thread position so React keys
                // stay stable across re-renders. Encodes post_index and
                // message_index; not used as a DB key anywhere.
                id: r.post_index * 10000 + r.message_index,
                persona: personaKey,
                post_type: 'reply',
                content: r.content,
                paper_ref: r.parent_post.paper_ref ?? null,
                replying_to: parentHandle,
                time: '',
                likes: 0,
                retweets: 0,
                replies: 0,
                bookmarks: 0,
              }
              return (
                <div key={`${r.feed_id}-${r.post_index}-${r.message_index}`}>
                  {/* Twitter-chained: the parent renders a thread-connector
                      rail from just under its avatar to its bottom edge, and
                      the reply continues that rail from its top edge up to
                      its avatar. The two rails meet across the border
                      between the cards to read as a single vertical line —
                      exactly like Twitter's profile Replies tab. */}
                  <PostCard
                    post={r.parent_post}
                    feedId={r.feed_id}
                    postIndex={r.post_index}
                    threadConnector="below"
                  />
                  <PostCard
                    post={syntheticReply}
                    feedId={r.feed_id}
                    threadConnector="above"
                  />
                </div>
              )
            })
          )}
        </div>
      )}
      {tab === 'dm' && (
        <div
          role="tabpanel"
          id="persona-panel-dm"
          aria-labelledby="persona-tab-dm"
          tabIndex={0}
          className="flex flex-col"
          style={{ minHeight: 'calc(100vh - 350px)' }}
        >
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
                aria-label={`Message ${p.name}`}
                className="flex-1 bg-bg-hover border border-border rounded-full px-4 py-2.5 text-[14px] text-text outline-none focus:border-gold/40 transition-colors"
                disabled={dmLoading}
              />
              <button
                onClick={handleSendDm}
                disabled={!dmInput.trim() || dmLoading}
                className="w-10 h-10 rounded-full flex items-center justify-center border-none cursor-pointer disabled:opacity-30 transition-colors"
                style={{ backgroundColor: p.color, color: 'var(--color-bg)' }}
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

const PERSONA_TABS: { key: 'posts' | 'replies' | 'dm'; label: string }[] = [
  { key: 'posts', label: 'Posts' },
  { key: 'replies', label: 'Replies' },
  { key: 'dm', label: 'Messages' },
]

// Archivist doesn't write top-level posts or jump into threads, so
// re-label "Posts" as "Corpus Q&A" (the actual content that tab shows)
// and hide Replies entirely.
const ARCHIVIST_TABS: { key: 'posts' | 'replies' | 'dm'; label: string }[] = [
  { key: 'posts', label: 'Corpus Q&A' },
  { key: 'dm', label: 'Messages' },
]

function PersonaTabs({ active, onSelect, accentColor, isArchivist }: {
  active: 'posts' | 'replies' | 'dm'
  onSelect: (tab: 'posts' | 'replies' | 'dm') => void
  accentColor: string
  isArchivist: boolean
}) {
  const tabs = isArchivist ? ARCHIVIST_TABS : PERSONA_TABS
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (index + dir + tabs.length) % tabs.length
    const nextKey = tabs[nextIndex].key
    onSelect(nextKey)
    tabRefs.current[nextKey]?.focus()
  }

  return (
    <div className="flex border-b border-border" role="tablist" aria-label="Persona sections">
      {tabs.map(({ key, label }, i) => (
        <button
          key={key}
          ref={(el) => { tabRefs.current[key] = el }}
          role="tab"
          id={`persona-tab-${key}`}
          aria-selected={active === key}
          aria-controls={`persona-panel-${key}`}
          tabIndex={active === key ? 0 : -1}
          onClick={() => onSelect(key)}
          onKeyDown={(e) => handleKeyDown(e, i)}
          className="flex-1 py-3 border-none bg-transparent cursor-pointer text-[15px] transition-all"
          style={{
            color: active === key ? 'var(--color-tab-active)' : 'var(--color-tab-inactive)',
            fontWeight: active === key ? 700 : 400,
            borderBottom: active === key ? `2px solid ${accentColor}` : '2px solid transparent',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
