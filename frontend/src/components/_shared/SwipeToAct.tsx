import { useDrag } from '@use-gesture/react'
import { useEffect, useState, type ReactNode } from 'react'
import { Heart, MessageCircle } from 'lucide-react'
import { haptic } from '../../hooks/useHaptic'

/**
 * Touch-primary detection: the swipe-to-act gesture should only be
 * live on devices where horizontal swipe is the natural interaction.
 * On desktop, useDrag catches trackpad two-finger side-scrolls and
 * accidental mouse drags, which feels intrusive — the user explicitly
 * called this out. `(hover: none) and (pointer: coarse)` matches
 * touch-primary devices (phones, tablets in touch mode); everything
 * else (mouse, trackpad, stylus-over-screen) short-circuits to
 * gesture-less passthrough.
 */
function useTouchDevice(): boolean {
  // Lazy initializer reads the media query once, at mount — the same
  // sanctioned pattern React docs use for useState(() => window.innerWidth)
  // — instead of always starting `false` and flipping it synchronously
  // inside the effect below (which the set-state-in-effect lint rule
  // flags). The effect then only *subscribes*; its setState call lives
  // inside the 'change' event callback, not the effect body itself.
  const [isTouch, setIsTouch] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)')
    const onChange = (e: MediaQueryListEvent) => setIsTouch(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isTouch
}

/**
 * Wraps a list row (feed post, message, etc.) so horizontal swipes
 * reveal a colored action gutter and commit when the user releases
 * past the threshold.
 *
 * Left-swipe (finger moves left, gutter appears on the right):
 *   fires `onSwipeLeft` — typical use: Like.
 * Right-swipe (finger moves right, gutter appears on the left):
 *   fires `onSwipeRight` — typical use: Reply.
 *
 * Critical design choices:
 *   - axis:'lock' — @use-gesture locks to whichever axis the user
 *     starts with. Vertical scroll wins when the first motion is
 *     downward; horizontal swipe wins only if the user intends it.
 *   - 8 px dead-zone — the card doesn't translate until drag distance
 *     exceeds 8 px. Prevents jittery nudges while scrolling.
 *   - filterTaps — single taps pass through to the child's click
 *     handlers rather than being consumed as zero-distance drags.
 *
 * Accessibility: swipe is additive. Every action it fires is also
 * reachable via the 3-dot menu, so keyboard + screen-reader users
 * aren't penalized for not gesturing.
 */
export function SwipeToAct({
  onSwipeLeft,
  onSwipeRight,
  threshold = 80,
  disabled = false,
  children,
}: {
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  threshold?: number
  disabled?: boolean
  children: ReactNode
}) {
  const isTouch = useTouchDevice()
  const [dx, setDx] = useState(0)
  const [committing, setCommitting] = useState<'left' | 'right' | null>(null)

  // Effective disabled flag includes the touch-device check. On desktop
  // we short-circuit the drag handler and render children bare — no
  // transform wrapper, no gutter overlays, no useDrag listeners
  // catching trackpad scrolls.
  const effectivelyDisabled = disabled || !isTouch

  const bind = useDrag(
    ({ movement: [mx], down, last, canceled }) => {
      if (effectivelyDisabled) return
      // Dead-zone: ignore the first 8 px so a small hand tremor or
      // start-of-scroll doesn't produce a visible translate.
      const effective = Math.abs(mx) < 8 ? 0 : mx - Math.sign(mx) * 8
      if (down) {
        setDx(effective)
        return
      }
      if (last && !canceled) {
        if (mx <= -threshold && onSwipeLeft) {
          setCommitting('left')
          haptic(15)
          onSwipeLeft()
        } else if (mx >= threshold && onSwipeRight) {
          setCommitting('right')
          haptic(15)
          onSwipeRight()
        }
        setDx(0)
        // Clear the commit flash after the spring-back animation.
        setTimeout(() => setCommitting(null), 220)
      }
    },
    { axis: 'lock', filterTaps: true },
  )

  // On desktop, render children directly. This completely removes the
  // gesture binding + overflow-hidden wrapper — trackpad scrolls and
  // mouse drags behave as if SwipeToAct wasn't there at all. No
  // accidental triggers, no phantom transforms.
  if (effectivelyDisabled) {
    return <>{children}</>
  }

  // Gutter intensity follows drag progress so the colored pad "fills in"
  // as the user reaches the threshold.
  const progress = Math.min(Math.abs(dx) / threshold, 1)
  const showLeftGutter = dx < 0 || committing === 'left'
  const showRightGutter = dx > 0 || committing === 'right'

  return (
    <div className="relative overflow-hidden">
      {/* Right-edge gutter — revealed when swiping left, shows Like */}
      {onSwipeLeft && showLeftGutter && (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 flex items-center justify-end pr-6 pointer-events-none"
          style={{
            backgroundColor: 'var(--color-like)',
            opacity: progress * 0.9 + 0.1,
            width: Math.max(Math.abs(dx), 40),
          }}
        >
          <Heart size={22} className="text-white" fill={progress > 0.8 ? 'white' : 'none'} />
        </div>
      )}
      {/* Left-edge gutter — revealed when swiping right, shows Reply */}
      {onSwipeRight && showRightGutter && (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 flex items-center justify-start pl-6 pointer-events-none"
          style={{
            backgroundColor: 'var(--color-persona-practitioner)',
            opacity: progress * 0.9 + 0.1,
            width: Math.max(dx, 40),
          }}
        >
          <MessageCircle size={22} className="text-white" />
        </div>
      )}
      <div
        {...bind()}
        className="touch-pan-y"
        style={{
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  )
}
