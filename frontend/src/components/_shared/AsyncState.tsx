// R10 DUP-9: the loading spinner + "No X yet" empty panel were hand-rolled
// at 7+ view components (Bookmarks, Alerts, ReadingLists x2, Inbox,
// Settings, Explore), with two competing spinner treatments — Loader2 vs
// AlertsView's hand-rolled CSS border spinner — plus drifted size/color/
// padding. One Spinner + EmptyState primitive; every call site's visual
// output is unchanged except AlertsView, whose CSS spinner is replaced by
// the shared Loader2 treatment used everywhere else.
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Loader2 } from 'lucide-react'

export function Spinner({ size = 24, className = 'text-gold animate-spin' }: {
  size?: number
  className?: string
}) {
  return <Loader2 size={size} className={className} />
}

export function EmptyState({ icon: Icon, title, hint, children }: {
  icon: LucideIcon
  title: string
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-text-muted">
      <Icon size={48} strokeWidth={1} className="mb-4 text-gold/30" />
      <p className="text-lg font-semibold text-text-mid mb-2">{title}</p>
      {hint}
      {children}
    </div>
  )
}
