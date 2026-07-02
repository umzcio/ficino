// R10 DUP-8: one relative-time helper replaces six drifted copies that
// rendered the same timestamp as 'just now' / '0m ago' / '0m' depending on
// screen. Boundaries + both suffix modes.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { timeAgo } from './timeAgo'

const NOW = new Date('2026-07-02T12:00:00.000Z').getTime()

function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString()
}

describe('timeAgo', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders "just now" up to 59s', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(timeAgo(ago(0))).toBe('just now')
    expect(timeAgo(ago(59))).toBe('just now')
  })

  it('renders "1m ago" at the 60s boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(timeAgo(ago(60))).toBe('1m ago')
  })

  it('renders "59m ago" / "1h ago" across the 60-minute boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(timeAgo(ago(59 * 60))).toBe('59m ago')
    expect(timeAgo(ago(60 * 60))).toBe('1h ago')
  })

  it('renders "23h ago" / "1d ago" across the 24-hour boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(timeAgo(ago(23 * 60 * 60))).toBe('23h ago')
    expect(timeAgo(ago(24 * 60 * 60))).toBe('1d ago')
  })

  it('accepts a Date instance as well as an ISO string', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(timeAgo(new Date(ago(60 * 60)))).toBe('1h ago')
  })

  it('defaults to suffixed output ({ suffix: true } implicit)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(timeAgo(ago(5 * 60), { suffix: true })).toBe('5m ago')
  })

  it('omits the " ago" suffix when { suffix: false } (Inbox/UserPostCard compact mode)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(timeAgo(ago(0), { suffix: false })).toBe('just now')
    expect(timeAgo(ago(5 * 60), { suffix: false })).toBe('5m')
    expect(timeAgo(ago(5 * 60 * 60), { suffix: false })).toBe('5h')
    expect(timeAgo(ago(5 * 24 * 60 * 60), { suffix: false })).toBe('5d')
  })
})
