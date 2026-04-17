import { useEffect, useRef } from 'react'

/**
 * Trap focus inside `containerRef` while `active` is true.
 * - Saves the currently-focused element on activation and restores it on deactivation.
 * - Focuses the first focusable element inside the container on activation.
 * - Wraps Tab / Shift+Tab within the focusable set.
 *
 * Escape handling is left to callers (most dialogs already own their own Escape logic).
 */
export function useFocusTrap(
  active: boolean,
  containerRef: React.RefObject<HTMLElement | null>
) {
  const returnTargetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return

    const container = containerRef.current
    if (!container) return

    // Save the element to restore focus to on deactivation.
    returnTargetRef.current = (document.activeElement as HTMLElement | null) ?? null

    const selector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

    const getFocusable = (): HTMLElement[] => {
      const nodes = Array.from(
        container.querySelectorAll<HTMLElement>(selector)
      )
      return nodes.filter(
        (el) =>
          !el.hasAttribute('disabled') &&
          el.getAttribute('aria-hidden') !== 'true' &&
          // Skip elements that aren't visible (offsetParent === null for display:none)
          (el.offsetParent !== null || el === document.activeElement)
      )
    }

    // Focus first focusable on activation.
    const initial = getFocusable()
    if (initial.length > 0) {
      initial[0].focus()
    } else {
      // Fallback: make the container itself focusable so focus lives somewhere inside.
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1')
      container.focus()
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeEl = document.activeElement as HTMLElement | null

      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (activeEl === last || !container.contains(activeEl)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      const target = returnTargetRef.current
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        target.focus()
      }
      returnTargetRef.current = null
    }
  }, [active, containerRef])
}
