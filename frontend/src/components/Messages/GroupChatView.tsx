import { useState, useEffect } from 'react'
import { ArrowLeft, Users, FileText, Loader2, Zap, AlertTriangle, HelpCircle } from 'lucide-react'
import type { GroupChat, SummaryMessage } from '../../types'
import { getGroupChat } from '../../lib/api'

interface GroupChatViewProps {
  groupId: string
  onBack: () => void
}

const ROLE_CONFIG: Record<string, { icon: typeof FileText; color: string; label: string }> = {
  intro: { icon: FileText, color: 'var(--color-gold)', label: 'Paper' },
  finding: { icon: Zap, color: 'var(--color-persona-gradstudent)', label: 'Finding' },
  agreement: { icon: FileText, color: 'var(--color-persona-practitioner)', label: 'Agreement' },
  contradiction: { icon: AlertTriangle, color: 'var(--color-persona-skeptic)', label: 'Tension' },
  gap: { icon: HelpCircle, color: 'var(--color-persona-hype)', label: 'Gap' },
  summary: { icon: FileText, color: 'var(--color-persona-methodologist)', label: 'Synthesis' },
}

function SynthesisMessage({ message }: { message: SummaryMessage }) {
  const config = ROLE_CONFIG[message.type] || ROLE_CONFIG.summary
  const Icon = config.icon
  const isPaperSpeaking = message.role === 'paper'

  return (
    <div className={`flex gap-3 px-4 py-2 ${isPaperSpeaking ? '' : 'bg-bg-hover/50'}`}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1"
        style={{ backgroundColor: config.color + '18', border: `1.5px solid ${config.color}40` }}
      >
        {isPaperSpeaking ? (
          <FileText size={14} style={{ color: config.color }} />
        ) : (
          <Icon size={14} style={{ color: config.color }} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wide uppercase" style={{ color: config.color }}>
            {isPaperSpeaking ? (message.paper_ref || 'Paper') : config.label}
          </span>
        </div>
        <p className="text-[14px] text-text leading-relaxed mt-0.5 whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    </div>
  )
}

export function GroupChatView({ groupId, onBack }: GroupChatViewProps) {
  const [chat, setChat] = useState<GroupChat | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const data = await getGroupChat(groupId)
      setChat(data)
      setLoading(false)
    }
    load()
  }, [groupId])

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg/90 backdrop-blur-[12px] border-b border-border px-4 py-3 flex items-center gap-3">
        <button
          onClick={onBack}
          aria-label="Go back"
          className="w-10 h-10 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover transition-colors"
        >
          <ArrowLeft size={18} className="text-text" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] text-text truncate">
            {chat?.name || 'Loading...'}
          </div>
          {chat?.papers && (
            <div className="text-xs text-text-muted">
              {Object.keys(chat.papers).length} papers
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={28} className="text-gold animate-spin" />
        </div>
      ) : chat?.messages && chat.messages.length > 0 ? (
        <div className="py-3 space-y-2">
          {/* Participants card */}
          <div className="mx-4 p-3 bg-bg-hover border border-border rounded-xl mb-3">
            <div className="flex items-center gap-2 mb-2">
              <Users size={14} className="text-persona-methodologist" />
              <span className="text-xs font-semibold text-persona-methodologist tracking-wide uppercase">
                Papers in this conversation
              </span>
            </div>
            <div className="space-y-1">
              {Object.entries(chat.papers).map(([id, title]) => (
                <div key={id} className="flex items-center gap-2">
                  <FileText size={11} className="text-text-muted" />
                  <span className="text-[13px] text-text-mid">{title}</span>
                </div>
              ))}
            </div>
          </div>

          {chat.messages.map((msg, i) => (
            <SynthesisMessage key={i} message={msg} />
          ))}

          <div className="px-4 py-3 text-center">
            <span className="text-xs text-text-subtle">End of synthesis</span>
          </div>
        </div>
      ) : (
        <div className="py-16 text-center text-text-muted text-sm">
          No synthesis available.
        </div>
      )}
    </div>
  )
}
