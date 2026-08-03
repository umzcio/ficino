import { useDrag } from '@use-gesture/react'

/**
 * Invisible 20px-wide edge strip along the left side of a detail view
 * that fires `onBack` when the user drags rightward past a threshold.
 * Matches iOS-native "swipe from left edge to pop" behaviour so users'
 * muscle memory works in the PWA.
 *
 * Usage: drop `<SwipeBackEdge onBack={onBack} />` as a sibling to the
 * rest of the view; it positions itself absolutely and doesn't affect
 * layout. The edge is transparent — no visual chrome — but `z-50`
 * keeps it above the content so it wins the pointer event.
 *
 * Horizontal axis is locked by @use-gesture's axis:'lock' so a user
 * swiping down (scroll) from near the edge doesn't accidentally pop.
 */
export function SwipeBackEdge({
  onBack,
  threshold = 100,
}: {
  onBack: () => void
  /** Distance in px the user must drag right before the back fires. */
  threshold?: number
}) {
  const bind = useDrag(
    ({ movement: [mx], velocity: [vx], last, canceled }) => {
      if (!last || canceled) return
      // Distance commit as before, or a fast rightward flick (iOS pops on
      // flick, not just travel). 0.2 px/ms matches SwipeableTabs; 24 px
      // minimum travel filters tap artifacts on the narrow edge strip.
      if (mx > threshold || (vx >= 0.2 && mx >= 24)) onBack()
    },
    { axis: 'lock', filterTaps: true },
  )

  return (
    <div
      {...bind()}
      aria-hidden="true"
      className="fixed top-0 left-0 bottom-0 w-5 z-50 touch-none md:hidden"
    />
  )
}
