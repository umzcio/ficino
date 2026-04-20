/**
 * Thin wrapper around navigator.vibrate. Silently no-ops on browsers
 * that don't support the Vibration API (notably iOS Safari), so callers
 * can fire it unconditionally without feature-sniffing.
 *
 * Convention:
 *   - tap/confirm: 10ms
 *   - swipe commit: 15ms
 *   - heavy / error: 40ms
 * Kept short; long vibrations feel aggressive and drain battery.
 */
export function haptic(ms: number = 10) {
  if (typeof navigator === 'undefined') return
  navigator.vibrate?.(ms)
}
