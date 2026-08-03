import { useState, useEffect, useCallback, useRef } from 'react'
import { getSettings, updateSettings } from '../lib/api'
import { cacheSettings, getCachedSettings } from '../lib/offline-cache'

// Extracted for unit testing (no @testing-library/react in this repo —
// same pattern as usePollTask's startPoll).
export async function putSettings(
  partial: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    return await updateSettings(partial)
  } catch {
    return null
  }
}

// Plan 026: Settings sliders fire update() on every input event (one drag ≈
// 14 PUTs), and concurrent responses could be applied out of order — an
// earlier write's response landing last snapped the slider back to a stale
// value while the server held a different one. createSettingsUpdater owns
// the fix in one framework-free place (same testable-extraction philosophy
// as usePollTask's startPoll): trailing-edge debounce coalesces rapid calls
// into one PUT of the merged partial, sends are sequenced so a response is
// only applied when it belongs to the most recently SENT PUT, and every
// caller's promise resolves with the outcome of the PUT that actually
// carried its partial (preserving plan 025's boolean contract).
export interface SettingsUpdater {
  update: (partial: Record<string, unknown>) => Promise<boolean>
  /** Immediately send any pending merged partial; resolves with its outcome. */
  flush: () => Promise<boolean>
  /** Drop pending writes and clear the timer (unmount). */
  cancel: () => void
}

export interface SettingsUpdaterOptions {
  /** Receives the response body of the most recently sent PUT only. */
  apply: (data: Record<string, unknown>) => void
  /** Trailing-edge debounce window. Default 400 ms. */
  debounceMs?: number
}

export function createSettingsUpdater({
  apply,
  debounceMs = 400,
}: SettingsUpdaterOptions): SettingsUpdater {
  let pending: Record<string, unknown> | null = null
  // Callers whose partials are still waiting for a PUT; each entry is
  // resolved with the outcome of the PUT that carries its partial.
  let waiters: Array<(ok: boolean) => void> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlightCount = 0
  // Incremented per send; a response is applied only when no newer PUT has
  // been sent since (an overlapping flush() can otherwise resolve last with
  // an earlier write's body and snap state back to a stale value).
  let sendCounter = 0

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  async function send(): Promise<boolean> {
    const body = pending!
    const mine = waiters
    pending = null
    waiters = []
    clearTimer()
    inFlightCount += 1
    const mySend = ++sendCounter
    const data = await putSettings(body)
    inFlightCount -= 1
    const ok = data !== null
    if (data !== null && mySend === sendCounter) apply(data)
    // Fan out BEFORE any follow-up send: these callers were carried by THIS
    // PUT, so they resolve with its outcome, not the follow-up's.
    for (const resolve of mine) resolve(ok)
    // Partials accumulated while this PUT was in flight fire immediately —
    // no extra debounce window. Awaited only so flush() callers observe a
    // settled chain; the follow-up has its own waiters.
    if (inFlightCount === 0 && pending !== null) await send()
    return ok
  }

  function update(partial: Record<string, unknown>): Promise<boolean> {
    pending = { ...pending, ...partial }
    const result = new Promise<boolean>((resolve) => waiters.push(resolve))
    // While a PUT is in flight the follow-up fires on its resolution, so no
    // timer is needed; otherwise (re)arm the trailing-edge window once.
    if (inFlightCount === 0 && timer === null) {
      timer = setTimeout(() => {
        timer = null
        if (pending !== null) void send()
      }, debounceMs)
    }
    return result
  }

  async function flush(): Promise<boolean> {
    if (pending === null) return true
    // Deliberate escape hatch: sends immediately even if a PUT is already
    // in flight (blur-critical controls). The send counter above keeps
    // response application latest-only across that overlap.
    return send()
  }

  function cancel(): void {
    clearTimer()
    pending = null
    const mine = waiters
    waiters = []
    // Resolve rather than leave dangling promises on unmount.
    for (const resolve of mine) resolve(false)
  }

  return { update, flush, cancel }
}

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  // setState functions are stable, so the updater can be created once and
  // held in a ref; unmount drops any pending debounced write.
  const updaterRef = useRef<SettingsUpdater | null>(null)
  if (updaterRef.current === null) {
    updaterRef.current = createSettingsUpdater({ apply: setSettings })
  }

  const refresh = useCallback(async () => {
    try {
      const data = await getSettings()
      cacheSettings(data).catch(() => {})
      setSettings(data)
    } catch {
      try {
        const cached = await getCachedSettings()
        if (cached) setSettings(cached)
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const updater = updaterRef.current!
    return () => updater.cancel()
  }, [])

  // Debounced + sequenced by the updater; resolves true/false with the
  // outcome of the PUT that carried this partial (plan 025 contract:
  // callers that care — ApiKeyInput, destructive settings — surface false;
  // fire-and-forget callers may ignore the return).
  const update = useCallback(
    (partial: Record<string, unknown>): Promise<boolean> => updaterRef.current!.update(partial),
    [],
  )

  return { settings, loading, update, refresh }
}
