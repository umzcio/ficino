import { useDrag } from '@use-gesture/react'
import { Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

/**
 * Pull-to-refresh wrapper. Active only when the window is scrolled to
 * the top (scrollY === 0); a drag-down past `threshold` pixels fires
 * `onRefresh`. A small gold spinner rotates with pull progress and
 * spins freely while the refresh promise resolves.
 *
 * Designed for the mobile feed; desktop keyboard users get no affordance
 * and the gesture is a no-op if they're not at scrollY=0 anyway.
 */
export function PullToRefresh({
  onRefresh,
  threshold = 70,
  children,
}: {
  onRefresh: () => void | Promise<void>
  threshold?: number
  children: ReactNode
}) {
  const [pullPx, setPullPx] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const bind = useDrag(
    async ({ movement: [, my], down, canceled, event }) => {
      // Only engage when at the very top of the window. If the user
      // started the drag mid-scroll, ignore — Virtuoso handles vertical
      // movement for normal scrolling.
      if (window.scrollY > 0) {
        setPullPx(0)
        return
      }
      if (my < 0) {
        setPullPx(0)
        return
      }
      // Prevent the browser's own scroll-up bounce from fighting us.
      if (event.cancelable) event.preventDefault()

      if (down) {
        // Rubber-band: diminishing returns past threshold so the pull
        // has a natural ceiling.
        const eased = my < threshold ? my : threshold + (my - threshold) * 0.3
        setPullPx(eased)
      } else if (!canceled && my > threshold && !refreshing) {
        setRefreshing(true)
        setPullPx(threshold)
        try {
          await onRefresh()
        } finally {
          setRefreshing(false)
          setPullPx(0)
        }
      } else {
        setPullPx(0)
      }
    },
    { axis: 'y', filterTaps: true, eventOptions: { passive: false } },
  )

  const progress = Math.min(pullPx / threshold, 1)

  return (
    <div {...bind()} className="touch-pan-y relative">
      {/* Spinner track, pinned to the top edge, opacity + rotation follow pull */}
      <div
        aria-hidden={!refreshing && progress < 0.5}
        className="flex items-center justify-center pointer-events-none absolute top-0 left-0 right-0 z-20"
        style={{
          height: pullPx,
          opacity: Math.max(progress, refreshing ? 1 : 0),
          transition: refreshing ? 'none' : 'opacity 120ms ease',
        }}
      >
        <Loader2
          size={22}
          className={refreshing ? 'animate-spin' : ''}
          style={{
            color: 'var(--color-gold)',
            transform: refreshing ? undefined : `rotate(${progress * 360}deg)`,
            transition: refreshing ? 'none' : 'transform 40ms linear',
          }}
        />
      </div>
      {/* Content is pushed down by the pull so the spinner feels anchored to the top of the feed, not floating. */}
      <div
        style={{
          transform: `translateY(${pullPx}px)`,
          transition: refreshing || pullPx > 0 ? 'none' : 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        {children}
      </div>
    </div>
  )
}
