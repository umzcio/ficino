import { useDrag } from '@use-gesture/react'
import type { ReactNode } from 'react'

/**
 * Wraps tabbed content so a horizontal swipe inside the wrapper
 * advances / retreats the active tab. Additive — the tab bar above
 * still works by tap.
 *
 * Commit rule: drag distance > 80 px AND velocity > 0.2. Tuned for
 * positive-feel without false-positives during a user's vertical
 * scroll flick. Axis is locked so a steep vertical drag won't register.
 */
export function SwipeableTabs({
  activeIndex,
  tabCount,
  onChange,
  children,
}: {
  activeIndex: number
  tabCount: number
  /** Called with the next tab index. Already clamped to [0, tabCount-1] before firing. */
  onChange: (next: number) => void
  children: ReactNode
}) {
  const bind = useDrag(
    ({ movement: [mx], velocity: [vx], last, canceled }) => {
      if (!last || canceled) return
      if (Math.abs(mx) < 80 || Math.abs(vx) < 0.2) return
      const dir = mx < 0 ? 1 : -1
      const next = activeIndex + dir
      if (next < 0 || next >= tabCount) return
      onChange(next)
    },
    { axis: 'lock', filterTaps: true },
  )

  return (
    <div {...bind()} className="touch-pan-y">
      {children}
    </div>
  )
}
