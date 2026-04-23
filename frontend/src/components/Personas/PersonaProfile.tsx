import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Loader2, Send, MessagesSquare, Trash2 } from 'lucide-react'
import { usePersonas } from '../../hooks/usePersonas'
import { getPersonaStats, getPersonaDm, sendPersonaDm, deletePersonaDmMessage, clearPersonaDm, getPersonaReplies, listUserPosts, type ReplyMessage, type PersonaReplyItem, type UserPost } from '../../lib/api'
import type { FeedPost } from '../../types'
import { PostCard } from '../Feed/PostCard'
import { Md } from '../Feed/_shared/Md'
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
  // Ref on the scroll CONTAINER itself. Previously we had a sentinel
  // <div> at the bottom and called `scrollIntoView` on it — that scrolls
  // the nearest scrollable ancestor, which on this page ends up being
  // the document/main, so a long persona reply yanked the whole page
  // to its end instead of just scrolling within the message list. Now
  // we set `scrollTop = scrollHeight` on this container directly so the
  // viewport stays put and only the messages pane moves.
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const scrollMessagesToBottom = () => {
    const el = messagesContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

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
        // Scroll the INTERNAL messages container to its bottom (shows
        // the most recent message). Does not touch viewport scroll.
        setTimeout(scrollMessagesToBottom, 100)
      }).catch(() => setDmLoaded(true))
      // preventScroll: true blocks the browser's default behaviour of
      // yanking the viewport to reveal the focused input. Without this,
      // clicking the Messages tab made the whole page jump to the
      // bottom to bring the DM input into view — the user lost their
      // place on the profile above. With preventScroll the page stays
      // anchored at whatever position the tab click left it at.
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 200)
    }
  }, [tab, personaKey, dmLoaded])

  // When the user switches TO the DM tab, also bring the tab panel to
  // the top of the viewport so they land on the conversation rather
  // than somewhere in the middle of the profile banner above it. Uses
  // a plain scrollIntoView at block:start — in contrast to the focus()
  // scroll-to-reveal, this is a ONE-shot intentional motion right at
  // tab-switch time, and it targets the panel wrapper rather than the
  // DM input.
  const dmPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tab !== 'dm') return
    const el = dmPanelRef.current
    if (!el) return
    // One animation frame delay so the panel is mounted before we
    // measure its position. `block: 'start'` anchors the panel's top
    // to the top of the viewport (modulo the sticky header above).
    requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [tab])

  const handleSendDm = async () => {
    if (!dmInput.trim() || dmLoading) return
    setDmLoading(true)
    try {
      const data = await sendPersonaDm(personaKey, dmInput.trim())
      setDmMessages(data.messages)
      setDmInput('')
      setTimeout(scrollMessagesToBottom, 100)
    } catch {
      // ignore
    } finally {
      setDmLoading(false)
    }
  }

  const handleDeleteMessage = async (messageIndex: number) => {
    // Optimistic update so the bubble vanishes immediately; if the
    // DELETE fails we refetch from the server (catch branch below).
    const previous = dmMessages
    setDmMessages(msgs => msgs.filter((_, i) => i !== messageIndex))
    try {
      const data = await deletePersonaDmMessage(personaKey, messageIndex)
      setDmMessages(data.messages)
    } catch {
      setDmMessages(previous)
    }
  }

  const handleClearDm = async () => {
    if (dmMessages.length === 0) return
    if (!window.confirm(`Clear entire conversation with ${p?.name ?? 'this persona'}? This can't be undone.`)) return
    const previous = dmMessages
    setDmMessages([])
    try {
      await clearPersonaDm(personaKey)
    } catch {
      setDmMessages(previous)
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
          ref={dmPanelRef}
          role="tabpanel"
          id="persona-panel-dm"
          aria-labelledby="persona-tab-dm"
          tabIndex={0}
          className="flex flex-col scroll-mt-[60px]"
          // Constrain to a real height so the inner messages container
          // can actually scroll internally instead of pushing the whole
          // page down on new messages. 100dvh accounts for mobile
          // browser chrome; the subtractions cover the sticky header
          // plus the profile banner + tab bar above.
          // scroll-mt-[60px] keeps the sticky persona header from
          // covering the top of the panel when scrollIntoView fires on
          // tab-switch.
          style={{ height: 'calc(100dvh - 340px)', minHeight: '360px' }}
        >
          {/* DM conversation — Twitter-style bubbles. User messages
              right-aligned on a gold pill; persona messages left-aligned
              on a color-tinted pill. No per-message avatars or name
              labels — the persona is identified by the header at the
              top of this profile, matching iMessage / Twitter DM feel. */}
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto">
            {/* Conversation toolbar — visible only when there ARE messages.
                Gives a one-click escape hatch for starting fresh. */}
            {dmLoaded && dmMessages.length > 0 && (
              <div className="sticky top-0 z-10 flex justify-end px-3 py-1.5 bg-bg/90 backdrop-blur-[12px] border-b border-border">
                <button
                  type="button"
                  onClick={handleClearDm}
                  aria-label="Clear conversation"
                  className="text-[12px] text-text-muted hover:text-persona-skeptic bg-transparent border-none cursor-pointer px-2 py-1 rounded-md flex items-center gap-1 transition-colors"
                >
                  <Trash2 size={12} />
                  <span>Clear conversation</span>
                </button>
              </div>
            )}
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
              <div className="py-3 px-3 flex flex-col">
                {dmMessages.map((msg, i) => {
                  const isUser = msg.role === 'user'
                  const prev = i > 0 ? dmMessages[i - 1] : undefined
                  // Messages from the SAME sender stack with tight spacing
                  // (like iMessage). When the sender flips the next bubble
                  // gets extra top padding so the conversation breathes.
                  const sameAsPrev = prev && prev.role === msg.role
                  const spacingClass = sameAsPrev ? 'mt-1' : 'mt-4'
                  // "Tail" corner — the one corner on the bubble that
                  // stays sharper, giving the iMessage/Twitter DM feel.
                  // User tail = bottom-right; persona tail = bottom-left.
                  const bubbleClass = isUser
                    ? 'bg-gold text-bg rounded-2xl rounded-br-md'
                    : 'text-text rounded-2xl rounded-bl-md'
                  const bubbleStyle: React.CSSProperties = isUser
                    ? {}
                    : {
                        backgroundColor: `color-mix(in srgb, ${p.color} 18%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${p.color} 28%, transparent)`,
                      }
                  // The flex row wraps bubble + hover-delete button. The
                  // row's justify-end/start positions the bubble on the
                  // correct side; the group-hover trash sits just outside
                  // the bubble on the free-side gutter.
                  return (
                    <div
                      key={i}
                      className={`group relative flex items-center gap-1 ${spacingClass} ${isUser ? 'justify-end' : 'justify-start'}`}
                    >
                      {isUser && (
                        <button
                          type="button"
                          onClick={() => handleDeleteMessage(i)}
                          aria-label="Delete message"
                          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity w-7 h-7 rounded-full bg-transparent border-none cursor-pointer flex items-center justify-center text-text-muted hover:text-persona-skeptic hover:bg-bg-hover"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                      <div
                        className={`${bubbleClass} max-w-[78%] px-4 py-2 text-[14px] leading-relaxed break-words`}
                        style={bubbleStyle}
                      >
                        <Md text={msg.content} />
                      </div>
                      {!isUser && (
                        <button
                          type="button"
                          onClick={() => handleDeleteMessage(i)}
                          aria-label="Delete message"
                          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity w-7 h-7 rounded-full bg-transparent border-none cursor-pointer flex items-center justify-center text-text-muted hover:text-persona-skeptic hover:bg-bg-hover"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  )
                })}
                {dmLoading && (
                  // Typing indicator: a left-aligned persona bubble with
                  // three pulsing dots while the LLM is responding. Makes
                  // the wait feel like a real DM rather than dead air.
                  <div
                    className="self-start text-text rounded-2xl rounded-bl-md px-4 py-2.5 flex items-center gap-1 mt-4"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${p.color} 18%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${p.color} 28%, transparent)`,
                    }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '300ms' }} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* DM input pinned inside the flex container (not sticky to
              viewport) — shrink-0 keeps it at its natural height while
              flex-1 on the messages pane soaks up the rest. */}
          <div className="shrink-0 border-t border-border bg-bg px-4 py-3">
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
                aria-label="Send message"
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
