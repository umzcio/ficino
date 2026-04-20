import { useEffect, useRef } from 'react'

/**
 * Returns a ref to attach to an input / textarea. When the on-screen
 * keyboard opens (visualViewport shrinks by >100 px), the element
 * scrolls itself into view so iOS/Android don't cover it.
 *
 * No-op on desktop and on browsers without visualViewport.
 *
 * Usage (single input):
 *   const ref = useKeyboardAwareInput<HTMLTextAreaElement>()
 *   return <textarea ref={ref} ... />
 */
export function useKeyboardAwareInput<T extends HTMLElement>() {
  const ref = useRef<T>(null)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    // Track the largest seen viewport height so we measure keyboard
    // shrinkage independent of orientation changes.
    let maxHeight = vv.height

    const onResize = () => {
      if (vv.height > maxHeight) {
        maxHeight = vv.height
        return
      }
      const shrunk = maxHeight - vv.height
      if (shrunk < 100) return
      if (document.activeElement === ref.current) {
        ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }

    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  return ref
}

/**
 * Document-level variant: mount this hook once near the top of the tree,
 * and any focused input/textarea inside the page will scroll into view
 * when the keyboard opens. Useful for forms that swap inputs based on
 * state (e.g. the login page's mode-driven form), where individual refs
 * are awkward to thread through.
 */
export function useKeyboardAwarePage() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    let maxHeight = vv.height

    const onResize = () => {
      if (vv.height > maxHeight) {
        maxHeight = vv.height
        return
      }
      const shrunk = maxHeight - vv.height
      if (shrunk < 100) return
      const focused = document.activeElement as HTMLElement | null
      if (!focused) return
      if (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA') return
      focused.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])
}
