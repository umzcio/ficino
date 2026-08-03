// Plan 025: useSettings().update used to swallow PUT failures (`catch {
// // ignore }`), so ApiKeyInput showed its green "saved" check even when the
// save failed. putSettings is the extracted, framework-free PUT wrapper (same
// pattern as usePollTask's startPoll — no @testing-library/react in this
// repo) that converts the throw into a null return so callers can surface
// the failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { putSettings, createSettingsUpdater } from './useSettings'
import { updateSettings } from '../lib/api'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, updateSettings: vi.fn() }
})

const mockedUpdateSettings = vi.mocked(updateSettings)

describe('putSettings', () => {
  beforeEach(() => {
    mockedUpdateSettings.mockReset()
  })

  it('returns the server data on success', async () => {
    const server = { theme: 'dark', anthropic_api_key: 'set' }
    mockedUpdateSettings.mockResolvedValue(server)

    await expect(putSettings({ theme: 'dark' })).resolves.toBe(server)
    expect(mockedUpdateSettings).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('returns null on rejection (contained — does not throw)', async () => {
    mockedUpdateSettings.mockRejectedValue(new Error('API error 401'))

    await expect(putSettings({ anthropic_api_key: 'sk-ant-x' })).resolves.toBeNull()
  })
})

// Plan 026: createSettingsUpdater is the framework-free debounce/sequencing
// core behind useSettings().update (same extraction philosophy as
// usePollTask's startPoll), driven here with vitest fake timers. The
// contract under test: rapid update() calls coalesce into ONE trailing-edge
// PUT of the merged partial (400 ms); at most one PUT per debounce chain is
// in flight — a partial that arrives mid-flight fires as a follow-up the
// moment the in-flight PUT resolves; a response is applied only when it
// belongs to the most recently SENT PUT; every caller's promise resolves
// with the outcome of the PUT that carried its partial (plan 025's boolean
// contract).
describe('createSettingsUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedUpdateSettings.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces 5 rapid update() calls within 400 ms into ONE PUT of the merged partial', async () => {
    mockedUpdateSettings.mockResolvedValue({ merged: true })
    const apply = vi.fn()
    const updater = createSettingsUpdater({ apply })

    const p1 = updater.update({ a: 1 })
    const p2 = updater.update({ b: 2 })
    const p3 = updater.update({ c: 3 })
    const p4 = updater.update({ a: 5 }) // later key wins on merge
    const p5 = updater.update({ d: 4 })

    // Nothing fires before the trailing edge.
    await vi.advanceTimersByTimeAsync(399)
    expect(mockedUpdateSettings).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(1)
    expect(mockedUpdateSettings).toHaveBeenCalledWith({ a: 5, b: 2, c: 3, d: 4 })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ merged: true })

    // Every coalesced caller resolves with the merged flush's outcome.
    await expect(Promise.all([p1, p2, p3, p4, p5])).resolves.toEqual([true, true, true, true, true])

    // Trailing edge, not trailing burst: nothing further fires.
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(1)
  })

  it('fires a follow-up PUT immediately when update() arrives while a PUT is in flight (no extra 400 ms wait)', async () => {
    let resolveFirst!: (v: Record<string, unknown>) => void
    mockedUpdateSettings
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue({ second: true })
    const apply = vi.fn()
    const updater = createSettingsUpdater({ apply })

    const p1 = updater.update({ a: 1 })
    await vi.advanceTimersByTimeAsync(400)
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(1)

    // Arrives mid-flight: must wait for PUT_1, then fire immediately.
    const p2 = updater.update({ b: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(1) // still waiting, no timer fired it

    resolveFirst({ first: true })
    await vi.advanceTimersByTimeAsync(0) // microtasks only — no timer wait
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(2)
    expect(mockedUpdateSettings).toHaveBeenLastCalledWith({ b: 2 })

    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)
    // In-order responses are both applied, PUT_1's first.
    expect(apply).toHaveBeenNthCalledWith(1, { first: true })
    expect(apply).toHaveBeenNthCalledWith(2, { second: true })
  })

  it('applies ONLY the most recently sent PUT\u2019s response when responses arrive out of order', async () => {
    // flush() is the explicit send-now escape hatch and can overlap an
    // in-flight PUT — the only way two sends overlap — which is exactly
    // where the send-counter guard matters: PUT_1 (older) resolves LAST
    // and must not be applied over PUT_2's newer response.
    const resolvers: Array<(v: Record<string, unknown>) => void> = []
    mockedUpdateSettings.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve) }),
    )
    const apply = vi.fn()
    const updater = createSettingsUpdater({ apply })

    const p1 = updater.update({ a: 1 })
    await vi.advanceTimersByTimeAsync(400) // PUT_1 sent, in flight
    const p2 = updater.update({ b: 2 })    // accumulates mid-flight
    const pf = updater.flush()             // sends PUT_2 immediately (overlap)
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(2)

    // PUT_2 (the later send) resolves first.
    resolvers[1]({ latest: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ latest: true })

    // PUT_1 resolves late — its stale response must never be applied.
    resolvers[0]({ stale: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(1)

    // Both PUTs succeeded server-side, so both callers still resolve true —
    // the boolean contract is about the write's outcome, not application.
    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)
    await expect(pf).resolves.toBe(true)
  })

  it('flush() sends the pending partial immediately without waiting for the debounce window', async () => {
    mockedUpdateSettings.mockResolvedValue({ flushed: true })
    const apply = vi.fn()
    const updater = createSettingsUpdater({ apply })

    const p = updater.update({ a: 1 })
    const f = updater.flush()

    expect(mockedUpdateSettings).toHaveBeenCalledTimes(1) // no timer wait
    expect(mockedUpdateSettings).toHaveBeenCalledWith({ a: 1 })
    await expect(f).resolves.toBe(true)
    await expect(p).resolves.toBe(true)
    expect(apply).toHaveBeenCalledWith({ flushed: true })

    // The flushed timer is cleared — nothing fires at the trailing edge.
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(1)
  })

  it('cancel() after update() drops the pending write — no PUT — and resolves callers false', async () => {
    const apply = vi.fn()
    const updater = createSettingsUpdater({ apply })

    const p = updater.update({ a: 1 })
    updater.cancel()

    await vi.advanceTimersByTimeAsync(5000)
    expect(mockedUpdateSettings).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    await expect(p).resolves.toBe(false)
  })

  it('resolves false for ALL coalesced callers when the flush fails', async () => {
    mockedUpdateSettings.mockRejectedValue(new Error('API error 500'))
    const apply = vi.fn()
    const updater = createSettingsUpdater({ apply })

    const p1 = updater.update({ a: 1 })
    const p2 = updater.update({ b: 2 })
    const p3 = updater.update({ c: 3 })

    await vi.advanceTimersByTimeAsync(400)
    expect(mockedUpdateSettings).toHaveBeenCalledTimes(1)
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([false, false, false])
    expect(apply).not.toHaveBeenCalled()
  })
})
