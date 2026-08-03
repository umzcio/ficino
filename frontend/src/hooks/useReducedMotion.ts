import { useEffect, useState } from 'react'

/**
 * Subscribes to `prefers-reduced-motion: reduce`. Use to branch JS-driven
 * motion (inline transforms, rAF loops) that the CSS media query cannot
 * reach — CSS-driven motion is already handled by the global rule in
 * index.css.
 */
export function useReducedMotion(): boolean {
  // Lazy initializer reads the media query once, at mount — the same
  // sanctioned pattern React docs use for useState(() => window.innerWidth)
  // — instead of always starting `false` and flipping it synchronously
  // inside the effect below (which the set-state-in-effect lint rule
  // flags). The effect then only *subscribes*; its setState call lives
  // inside the 'change' event callback, not the effect body itself.
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}
