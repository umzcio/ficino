import { useState, useEffect } from 'react'
import { FileText, Users, MessageCircle, ChevronRight, Loader2 } from 'lucide-react'
import type { PaperConversation, GroupChatPreview } from '../../types'
import { listPaperConversations, listGroupChats, listReplyConversations, type ReplyConversation } from '../../lib/api'
import { usePersonas } from '../../hooks/usePersonas'

interface InboxProps {
  onOpenPaper: (paperId: string) => void
  onOpenGroup: (groupId: string) => void
  onNewGroup: () => void
  onOpenThread?: (feedId: string, postIndex: number) => void
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export function Inbox({ onOpenPaper, onOpenGroup, onNewGroup, onOpenThread }: InboxProps) {
  const personas = usePersonas()
  const [tab, setTab] = useState<'papers' | 'groups' | 'threads'>('papers')
  const [papers, setPapers] = useState<PaperConversation[]>([])
  const [groups, setGroups] = useState<GroupChatPreview[]>([])
  const [threads, setThreads] = useState<ReplyConversation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [p, g, t] = await Promise.all([listPaperConversations(), listGroupChats(), listReplyConversations()])
      setPapers(p)
      setGroups(g)
      setThreads(t)
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3.5">
        <h1 className="text-xl font-bold text-text">Messages</h1>
        <p className="text-xs text-text-muted mt-0.5">Paper summaries & corpus synthesis</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {([
          { key: 'papers' as const, icon: FileText, label: 'Papers' },
          { key: 'groups' as const, icon: Users, label: 'Groups' },
          { key: 'threads' as const, icon: MessageCircle, label: 'Threads' },
        ]).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex-1 py-3 border-none bg-transparent cursor-pointer text-[15px] flex items-center justify-center gap-2 transition-all"
            style={{
              color: tab === key ? '#e8eaf0' : '#555d6e',
              fontWeight: tab === key ? 700 : 400,
              borderBottom: tab === key ? '2px solid #c8a96e' : '2px solid transparent',
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="text-gold animate-spin" />
        </div>
      ) : tab === 'papers' ? (
        <div>
          {papers.length === 0 ? (
            <div className="py-16 text-center text-text-muted text-sm">
              No papers yet. Upload a paper to get started.
            </div>
          ) : (
            papers.map((p) => (
              <button
                key={p.paper_id}
                onClick={() => onOpenPaper(p.paper_id)}
                className="w-full text-left px-4 py-3 flex gap-3 items-start border-b border-border bg-transparent border-x-0 border-t-0 cursor-pointer hover:bg-bg-hover transition-colors"
              >
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center shrink-0 mt-0.5">
                  <FileText size={18} className="text-gold" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-text truncate">{p.title}</span>
                    <span className="text-xs text-text-muted shrink-0">{timeAgo(p.uploaded_at)}</span>
                  </div>
                  {p.authors.length > 0 && (
                    <div className="text-xs text-text-muted truncate">{p.authors.slice(0, 2).join(', ')}</div>
                  )}
                  <div className="text-[13px] text-text-mid mt-0.5 truncate">
                    {p.has_summary ? (
                      p.last_message_preview
                    ) : (
                      <span className="text-text-muted italic">Tap to generate summary</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-[11px] text-text-muted">{p.chunk_count} chunks</span>
                    {p.has_summary && (
                      <span className="text-[11px] text-gold">{p.message_count} messages</span>
                    )}
                  </div>
                </div>
                <ChevronRight size={16} className="text-text-muted mt-3 shrink-0" />
              </button>
            ))
          )}
        </div>
      ) : tab === 'threads' ? (
        <div>
          {threads.length === 0 ? (
            <div className="py-16 text-center text-text-muted text-sm">
              No conversations yet. Reply to a persona in your feed to start one.
            </div>
          ) : (
            threads.map((t) => {
              const persona = personas[t.persona_key]
              return (
                <button
                  key={t.id}
                  onClick={() => onOpenThread?.(t.feed_id, t.post_index)}
                  className="w-full text-left px-4 py-3 flex gap-3 items-start border-b border-border bg-transparent border-x-0 border-t-0 cursor-pointer hover:bg-bg-hover transition-colors"
                >
                  {persona ? (
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 mt-0.5"
                      style={{
                        backgroundColor: persona.color + '22',
                        border: `1.5px solid ${persona.color}50`,
                        color: persona.color,
                      }}
                    >
                      {persona.initials}
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-persona-practitioner/10 flex items-center justify-center shrink-0 mt-0.5">
                      <MessageCircle size={18} className="text-persona-practitioner" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm text-text">
                        {persona?.name || t.persona_key}
                      </span>
                      <span className="text-xs text-text-muted shrink-0">{timeAgo(t.updated_at)}</span>
                    </div>
                    <div className="text-xs text-text-muted">{persona?.handle}</div>
                    {t.last_persona_message && (
                      <div className="text-[13px] text-text-mid mt-0.5 truncate">
                        {t.last_persona_message}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-text-muted">{t.message_count} messages</span>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-text-muted mt-3 shrink-0" />
                </button>
              )
            })
          )}
        </div>
      ) : (
        <div>
          {groups.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-text-muted text-sm mb-3">No group chats yet</p>
              <button
                onClick={onNewGroup}
                className="bg-transparent border border-gold/30 rounded-[20px] text-gold px-4 py-2 text-sm font-semibold cursor-pointer hover:bg-gold/5 transition-colors"
              >
                Create Group Chat
              </button>
            </div>
          ) : (
            <>
              {groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => onOpenGroup(g.id)}
                  className="w-full text-left px-4 py-3 flex gap-3 items-start border-b border-border bg-transparent border-x-0 border-t-0 cursor-pointer hover:bg-bg-hover transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-persona-methodologist/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Users size={18} className="text-persona-methodologist" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm text-text">{g.name}</span>
                      <span className="text-xs text-text-muted shrink-0">{timeAgo(g.generated_at)}</span>
                    </div>
                    <div className="text-xs text-text-muted">{g.paper_count} papers</div>
                    {g.last_message_preview && (
                      <div className="text-[13px] text-text-mid mt-0.5 truncate">{g.last_message_preview}</div>
                    )}
                  </div>
                  <ChevronRight size={16} className="text-text-muted mt-3 shrink-0" />
                </button>
              ))}
              <div className="p-4">
                <button
                  onClick={onNewGroup}
                  className="w-full bg-transparent border border-gold/30 rounded-[20px] text-gold py-2 text-sm font-semibold cursor-pointer hover:bg-gold/5 transition-colors"
                >
                  New Group Chat
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
