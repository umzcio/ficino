import { WifiOff } from 'lucide-react'
import { useIsOnline } from '../../lib/online-context'

export function OfflineBanner() {
  const isOnline = useIsOnline()

  if (isOnline) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-gold/5 text-text-secondary text-sm">
      <WifiOff size={15} className="text-gold shrink-0" />
      <span>You're offline &mdash; showing cached data</span>
    </div>
  )
}
