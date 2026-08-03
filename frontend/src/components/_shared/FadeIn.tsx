import { useEffect, useState, type ReactNode } from 'react'

/**
 * Fades children in on mount: renders at opacity 0, then flips a
 * `data-mounted` attribute after one animation frame so the CSS
 * transition carries opacity to 1 over 150ms. Opacity ONLY — no
 * transform — so the fade is comprehension-aiding feedback that survives
 * reduced-motion rules (audit §6); no motion-reduce handling needed.
 *
 * Uses the data-mounted fallback (audit §4) instead of @starting-style
 * for older iOS Safari in the PWA audience.
 *
 * Keyed remount: when the content identity changes (new feed, new tab,
 * refresh), the CALL SITE must put a `key` on <FadeIn> so React remounts
 * it and the fade replays per load.
 */
export function FadeIn({ children, className }: {
  children: ReactNode
  className?: string
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // The setState lives inside the rAF callback, not synchronously in
    // the effect body — the set-state-in-effect lint rule flags the
    // synchronous form. One frame at opacity 0 is required or the
    // transition has nothing to interpolate from.
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div data-mounted={mounted || undefined} className={`fade-in${className ? ` ${className}` : ''}`}>
      <style>{`
        .fade-in { opacity: 0; transition: opacity 150ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1)); }
        .fade-in[data-mounted] { opacity: 1; }
      `}</style>
      {children}
    </div>
  )
}
