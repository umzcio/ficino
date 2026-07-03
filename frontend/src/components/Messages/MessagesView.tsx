import { useState, useEffect } from 'react'
import { Inbox } from './Inbox'
import { PaperChat } from './PaperChat'
import { GroupChatView } from './GroupChatView'
import { NewGroupChatModal } from './NewGroupChatModal'

type View =
  | { type: 'inbox' }
  | { type: 'paper'; paperId: string }
  | { type: 'group'; groupId: string }

interface MessagesViewProps {
  workspaceId?: string
  onOpenThread?: (feedId: string, postIndex: number) => void
  initialPaperId?: string | null
  onInitialPaperConsumed?: () => void
}

export function MessagesView({ workspaceId, onOpenThread, initialPaperId, onInitialPaperConsumed }: MessagesViewProps = {}) {
  const [view, setView] = useState<View>(
    initialPaperId ? { type: 'paper', paperId: initialPaperId } : { type: 'inbox' }
  )
  const [showNewGroupModal, setShowNewGroupModal] = useState(false)

  // Render-time state sync (React's endorsed alternative to "setState
  // inside an effect" for adjusting state when a prop changes — see
  // react.dev "Adjusting some state when a prop changes"). Swaps to the
  // paper view the instant a new one-shot `initialPaperId` arrives from
  // the parent without the cascading-render effect the lint rule flags.
  const [consumedPaperId, setConsumedPaperId] = useState<string | null | undefined>(initialPaperId)
  if (initialPaperId && initialPaperId !== consumedPaperId) {
    setConsumedPaperId(initialPaperId)
    setView({ type: 'paper', paperId: initialPaperId })
  }

  // onInitialPaperConsumed is intentionally omitted from the deps below:
  // it's a fresh inline closure from the parent every render, so including
  // it would re-fire this effect on every render while initialPaperId is
  // still set (before the parent clears it), not just once per new value.
  useEffect(() => {
    if (initialPaperId) {
      onInitialPaperConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <>
      <Inbox
        workspaceId={workspaceId}
        onOpenPaper={(paperId) => setView({ type: 'paper', paperId })}
        onOpenGroup={(groupId) => setView({ type: 'group', groupId })}
        onNewGroup={() => setShowNewGroupModal(true)}
        onOpenThread={onOpenThread}
      />
      {showNewGroupModal && (
        <NewGroupChatModal
          workspaceId={workspaceId}
          onClose={() => setShowNewGroupModal(false)}
          onCreated={(synthesisId) => {
            setShowNewGroupModal(false)
            setView({ type: 'group', groupId: synthesisId })
          }}
        />
      )}
    </>
  )
}
