// R10 DUP-11 — seven hand-rolled "poll until terminal status" loops
// (useFeed, PaperChat, ListenView x2, ReadingListDetail x2, UserPostCard,
// useUserPosts), two of which had shipped race/cleanup bugs by Round 9,
// plus FE-6's wedged-forever ReadingListDetail chapter poll (no unmount
// cleanup, no error handling — a single transient network blip during
// chapter generation permanently disabled the "Generate Chapter" button).
//
// The scheduling/cancellation/backoff contract lives in `startPoll`, a
// plain function with no React dependency — that's what's under test.
// `usePollTask` is a thin hook wrapper: it tracks whether the owning
// component is still mounted and stops every poller it started when it
// isn't, so call sites don't have to hand-roll that bookkeeping (the
// exact thing that went missing in FE-6 and DUP-11's other casualties).
import { useCallback, useEffect, useRef } from 'react'

export interface PollController {
  stop: () => void
}

export interface PollOptions<T> {
  /** Fetch one status snapshot. Rejections are treated as transient. */
  fn: () => Promise<T>
  /** True when `result` is a terminal state — the chain stops here. */
  isDone: (result: T) => boolean
  /** Called once, with the terminal result, when isDone(result) is true. */
  onDone: (result: T) => void
  /**
   * Called on every rejected fn(). Optional — if omitted, a rejection is
   * silently treated as transient and the chain just retries. Either way
   * the chain re-schedules unless maxAttempts is exceeded.
   */
  onError?: (error: unknown) => void
  /** Delay between a non-terminal tick and the next one. Default 2000. */
  intervalMs?: number
  /**
   * Delay before the *first* tick. Defaults to intervalMs (matching
   * setInterval's semantics — the sites that used setInterval need no
   * override). A handful of sites want a different first delay (a
   * shorter warm-up, or an immediate first check) and pass this
   * explicitly.
   */
  initialDelayMs?: number
  /**
   * Computes the delay before retrying after a rejected fn(), given the
   * number of *consecutive* errors so far (attempt) and the base
   * intervalMs. Only consulted on the error path — the success-path
   * cadence is always intervalMs. Defaults to a flat intervalMs retry
   * (no growth).
   */
  backoff?: (attempt: number, base: number) => number
  /**
   * Give up after this many consecutive errors (onError still fires for
   * each) instead of retrying forever. Omit for infinite retries.
   */
  maxAttempts?: number
}

/**
 * Framework-free poll scheduler: chains setTimeout (never setInterval, so
 * a slow tick can't stack calls on top of itself). `isActive` is consulted
 * before every fn() call, before dispatching isDone/onDone/onError, and
 * before every reschedule — pass a live "am I still mounted" check (the
 * default is always-active, for callers outside React). Exported
 * standalone so the scheduling/backoff/cancellation contract can be unit
 * tested directly with vitest fake timers, independent of React's hook
 * dispatcher (this repo has no @testing-library/react to render a hook).
 */
export function startPoll<T>(
  opts: PollOptions<T>,
  isActive: () => boolean = () => true,
): PollController {
  const { fn, isDone, onDone, onError, intervalMs = 2000, initialDelayMs, backoff, maxAttempts } = opts
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0

  const schedule = (delay: number) => {
    if (stopped || !isActive()) return
    timer = setTimeout(tick, delay)
  }

  async function tick() {
    timer = null
    if (stopped || !isActive()) return
    try {
      const result = await fn()
      if (stopped || !isActive()) return
      if (isDone(result)) {
        // The poll is DONE at this point — a rejection out of onDone (many
        // adopters pass an async body that does further awaited work, e.g.
        // fetching the full resource once a status flips to "complete") is
        // surfaced via onError, not retried: there is no more polling left
        // to reschedule. Without this, an async onDone's rejection was an
        // unhandled promise rejection and the caller's own state (loading
        // spinners, disabled buttons) never got a chance to unwind (R10
        // wave-4 final-review finding).
        try {
          await Promise.resolve(onDone(result))
        } catch (err) {
          if (onError) onError(err)
          else console.warn('poll onDone failed', err)
        }
        return
      }
      attempt = 0
      schedule(intervalMs)
    } catch (err) {
      if (stopped || !isActive()) return
      attempt += 1
      onError?.(err)
      if (stopped || !isActive()) return
      if (maxAttempts !== undefined && attempt >= maxAttempts) return
      schedule(backoff ? backoff(attempt, intervalMs) : intervalMs)
    }
  }

  schedule(initialDelayMs ?? intervalMs)

  return {
    stop: () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/**
 * Framework-free core behind usePollTask: tracks every inner startPoll
 * controller in a Set (so unmount can stop them all) and removes each one
 * the moment it reaches a terminal state, not just on explicit stop().
 *
 * Before this, a controller stayed in the Set forever once its poll
 * finished on its own (onDone fired, or maxAttempts was exhausted) — for a
 * long-lived component that starts many short-lived pollers over its
 * lifetime (e.g. one per user action) rather than unmounting between them,
 * the Set only ever grew, holding dead controllers whose `stop()` is a
 * no-op. Harmless individually, but an unbounded leak for the component's
 * lifetime. Exported standalone (mirrors startPoll itself) so the
 * cleanup-on-terminal behavior is unit testable without rendering React —
 * this repo has no @testing-library/react.
 */
export interface PollTracker {
  poll: <T>(opts: PollOptions<T>) => PollController
  stopAll: () => void
  setActive: (v: boolean) => void
  controllers: Set<PollController>
}

export function createPollTracker(): PollTracker {
  let active = true
  const controllers = new Set<PollController>()

  function poll<T>(opts: PollOptions<T>): PollController {
    // A plain mutable box (not a `let` reassigned once) so `cleanup` can
    // close over the eventual controller without tripping prefer-const —
    // `inner` genuinely never gets reassigned, only `inner.current` does.
    const inner: { current: PollController | null } = { current: null }
    let errorCount = 0
    const cleanup = () => { if (inner.current) controllers.delete(inner.current) }

    const wrapped: PollOptions<T> = {
      ...opts,
      onDone: (result) => {
        cleanup()
        return opts.onDone(result)
      },
      onError: (err) => {
        errorCount += 1
        opts.onError?.(err)
        // Mirrors startPoll's own give-up check: when maxAttempts is
        // exhausted, the chain stops itself without ever calling onDone,
        // so this is the only terminal signal that path produces.
        if (opts.maxAttempts !== undefined && errorCount >= opts.maxAttempts) {
          cleanup()
        }
      },
    }

    inner.current = startPoll(wrapped, () => active)
    controllers.add(inner.current)
    return {
      stop: () => {
        inner.current?.stop()
        cleanup()
      },
    }
  }

  function stopAll() {
    controllers.forEach((c) => c.stop())
    controllers.clear()
  }

  function setActive(v: boolean) {
    active = v
  }

  return { poll, stopAll, setActive, controllers }
}

/**
 * React hook wrapper around createPollTracker. Every poller started via the
 * returned `poll()` is auto-stopped on unmount, so call sites don't need
 * their own mountedRef plumbing just to avoid a setState-after-unmount —
 * they still get an explicit PollController.stop() back for cancelling on
 * a dependency change (mode switch, id change) before unmount.
 */
export function usePollTask() {
  const trackerRef = useRef<PollTracker | null>(null)
  if (trackerRef.current === null) trackerRef.current = createPollTracker()

  useEffect(() => {
    const tracker = trackerRef.current!
    tracker.setActive(true)
    return () => {
      tracker.setActive(false)
      tracker.stopAll()
    }
  }, [])

  return useCallback(<T,>(opts: PollOptions<T>): PollController => trackerRef.current!.poll(opts), [])
}
