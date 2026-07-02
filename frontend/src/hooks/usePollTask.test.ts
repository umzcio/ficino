// R10 DUP-11 / FE-6: usePollTask replaces seven hand-rolled "poll until
// terminal status" loops. The scheduling/cancellation/backoff contract
// lives in `startPoll` — a framework-free function usePollTask wraps with
// a mounted ref — so it can be driven directly with vitest fake timers
// without a React render context (no @testing-library/react in this repo).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startPoll } from './usePollTask'

describe('startPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('chains setTimeout, not setInterval, while pending', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const fn = vi.fn().mockResolvedValue({ status: 'pending' })
    const onDone = vi.fn()

    startPoll({ fn, isDone: (r: { status: string }) => r.status === 'done', onDone, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(fn).toHaveBeenCalledTimes(3)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('stops the chain once isDone is true, calling onDone with the terminal result', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'done', value: 42 })
    const onDone = vi.fn()

    startPoll({ fn, isDone: (r: { status: string }) => r.status === 'done', onDone, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000) // first tick: pending, reschedules
    await vi.advanceTimersByTimeAsync(1000) // second tick: done
    await vi.advanceTimersByTimeAsync(5000) // nothing further should fire

    expect(fn).toHaveBeenCalledTimes(2)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith({ status: 'done', value: 42 })
  })

  it('stops the chain when the caller reports inactive (unmount), even mid-flight', async () => {
    let mounted = true
    const fn = vi.fn().mockResolvedValue({ status: 'pending' })
    const onDone = vi.fn()

    startPoll(
      { fn, isDone: () => false, onDone, intervalMs: 1000 },
      () => mounted,
    )

    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(1)

    mounted = false // simulate unmount
    await vi.advanceTimersByTimeAsync(5000)

    // No further fn() calls scheduled after the "unmount" flips isActive false.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not call fn again after unmount even if a tick was already in flight', async () => {
    let mounted = true
    let resolveFn: (v: { status: string }) => void
    const fn = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveFn = resolve }),
    )
    const onDone = vi.fn()

    startPoll(
      { fn, isDone: (r: { status: string }) => r.status === 'done', onDone, intervalMs: 1000 },
      () => mounted,
    )

    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(1)

    mounted = false
    resolveFn!({ status: 'done' })
    await vi.advanceTimersByTimeAsync(0)

    // The in-flight tick resolved after "unmount" — onDone must not fire.
    expect(onDone).not.toHaveBeenCalled()
  })

  it('re-schedules on a thrown/rejected fn() instead of dying, and calls onError', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ status: 'done' })
    const onDone = vi.fn()
    const onError = vi.fn()

    startPoll({ fn, isDone: (r: { status: string }) => r.status === 'done', onDone, onError, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000) // errors
    expect(onError).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000) // retries, succeeds
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onDone).toHaveBeenCalledWith({ status: 'done' })
  })

  it('re-schedules on error even with no onError supplied (default: retry, transient blips do not kill the chain)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ status: 'done' })
    const onDone = vi.fn()

    startPoll({ fn, isDone: (r: { status: string }) => r.status === 'done', onDone, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(onDone).toHaveBeenCalledWith({ status: 'done' })
  })

  it('applies a custom backoff to the error-retry delay (not the success cadence)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce({ status: 'done' })
    const onDone = vi.fn()
    const backoff = vi.fn((attempt: number, base: number) => base * attempt)

    startPoll({ fn, isDone: (r: { status: string }) => r.status === 'done', onDone, backoff, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000) // attempt 1 fails -> next delay = 1000*1 = 1000
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000) // attempt 2 fails -> next delay = 1000*2 = 2000
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000) // not yet — backoff pushed it to 2000
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000) // now it fires
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onDone).toHaveBeenCalledWith({ status: 'done' })
    expect(backoff).toHaveBeenCalledWith(1, 1000)
    expect(backoff).toHaveBeenCalledWith(2, 1000)
  })

  it('gives up after maxAttempts consecutive errors instead of retrying forever', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'))
    const onDone = vi.fn()
    const onError = vi.fn()

    startPoll({ fn, isDone: () => false, onDone, onError, intervalMs: 1000, maxAttempts: 2 })

    await vi.advanceTimersByTimeAsync(1000) // attempt 1
    await vi.advanceTimersByTimeAsync(1000) // attempt 2 -> gives up
    await vi.advanceTimersByTimeAsync(10000) // no more attempts

    expect(fn).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('honors a distinct initialDelayMs for the first tick vs. intervalMs for subsequent ticks', async () => {
    const fn = vi.fn().mockResolvedValue({ status: 'pending' })
    const onDone = vi.fn()

    startPoll({ fn, isDone: () => false, onDone, intervalMs: 2000, initialDelayMs: 500 })

    await vi.advanceTimersByTimeAsync(500)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('stop() cancels the pending timer and prevents any further fn() calls', async () => {
    const fn = vi.fn().mockResolvedValue({ status: 'pending' })
    const onDone = vi.fn()

    const controller = startPoll({ fn, isDone: () => false, onDone, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(1)

    controller.stop()
    await vi.advanceTimersByTimeAsync(10000)

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('stop() called mid-flight (after fn() resolves) suppresses onDone', async () => {
    let resolveFn: (v: { status: string }) => void
    const fn = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveFn = resolve }),
    )
    const onDone = vi.fn()

    const controller = startPoll({ fn, isDone: (r: { status: string }) => r.status === 'done', onDone, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    controller.stop()
    resolveFn!({ status: 'done' })
    await vi.advanceTimersByTimeAsync(0)

    expect(onDone).not.toHaveBeenCalled()
  })
})
