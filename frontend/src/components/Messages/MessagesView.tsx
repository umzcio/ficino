import { useState, useEffect } from 'react'
import { Inbox } from './Inbox'
import { PaperChat } from './PaperChat'
import { GroupChatView } from './GroupChatView'

type View =
  | { type: 'inbox' }
  | { type: 'paper'; paperId: string }
  | { type: 'group'; groupId: string }

interface MessagesViewProps {
  onOpenThread?: (feedId: string, postIndex: number) => void
  initialPaperId?: string | null
  onInitialPaperConsumed?: () => void
}

export function MessagesView({ onOpenThread, initialPaperId, onInitialPaperConsumed }: MessagesViewProps = {}) {
  const [view, setView] = useState<View>(
    initialPaperId ? { type: 'paper', paperId: initialPaperId } : { type: 'inbox' }
  )

  useEffect(() => {
    if (initialPaperId) {
      setView({ type: 'paper', paperId: initialPaperId })
      onInitialPaperConsumed?.()
    }
  }, [initialPaperId])

  if (view.type === 'paper') {
    return (
      <PaperChat
        paperId={view.paperId}
        onBack={() => setView({ type: 'inbox' })}
      />
    )
  }

  if (view.type === 'group') {
    return (
      <GroupChatView
        groupId={view.groupId}
        onBack={() => setView({ type: 'inbox' })}
      />
    )
  }

  return (
    <Inbox
      onOpenPaper={(paperId) => setView({ type: 'paper', paperId })}
      onOpenGroup={(groupId) => setView({ type: 'group', groupId })}
      onNewGroup={() => {
        // TODO: group creation modal
        alert('Group chat creation coming soon!')
      }}
      onOpenThread={onOpenThread}
    />
  )
}
