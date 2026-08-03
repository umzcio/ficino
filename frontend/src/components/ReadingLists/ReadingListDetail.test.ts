// The reading-list ordering poll waits on GET /reading-lists/{id} returning
// papers with rationale. usePollTask's maxAttempts only bounds consecutive
// REJECTIONS — a healthy 200 without rationale resets its attempt counter,
// so an ordering task that faults server-side before writing rationale
// (worker OOM, LLM failure) would poll forever. These pure helpers bound
// that wait, mirroring GroupChatView's generating-streak bound — see
// GroupChatView.isDone.test.ts for the pattern (this repo has no
// @testing-library/react, so the helpers are tested directly).
import { describe, it, expect } from 'vitest'
import { hasOrderingRationale, nextOrderingStreak, isOrderingStreakExhausted } from './ReadingListDetail'
import type { ReadingListDetail, ReadingListPaper } from '../../lib/api'

function baseList(overrides: Partial<ReadingListDetail>): ReadingListDetail {
  return {
    id: 'list-1',
    name: 'Test list',
    corpus_id: null,
    papers: [],
    chapters: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function paper(rationale: string): ReadingListPaper {
  return { id: 'p1', title: 'A paper', authors: [], year: null, rationale }
}

const noRationale = baseList({ papers: [paper('')] })
const withRationale = baseList({ papers: [paper(''), paper('read this first')] })

describe('hasOrderingRationale', () => {
  it('is false while no paper has rationale (ordering not applied yet)', () => {
    expect(hasOrderingRationale(baseList({ papers: [] }))).toBe(false)
    expect(hasOrderingRationale(noRationale)).toBe(false)
  })

  it('is true once any paper has rationale', () => {
    expect(hasOrderingRationale(withRationale)).toBe(true)
  })
})

describe('ordering-streak bound', () => {
  it('increments the streak on consecutive no-rationale responses', () => {
    expect(nextOrderingStreak(0, noRationale)).toBe(1)
    expect(nextOrderingStreak(1, noRationale)).toBe(2)
    expect(nextOrderingStreak(39, noRationale)).toBe(40)
  })

  it('resets the streak once rationale arrives', () => {
    expect(nextOrderingStreak(39, withRationale)).toBe(0)
  })

  it('exhausts at exactly 40 ticks (40 x 3s = 2 min), not before', () => {
    expect(isOrderingStreakExhausted(39)).toBe(false)
    expect(isOrderingStreakExhausted(40)).toBe(true)
    expect(isOrderingStreakExhausted(41)).toBe(true)
  })

  it('a server-side-faulted ordering task cannot poll unboundedly (streak monotonically reaches the bound)', () => {
    let streak = 0
    let ticks = 0
    while (!isOrderingStreakExhausted(streak) && ticks < 1000) {
      streak = nextOrderingStreak(streak, noRationale)
      ticks += 1
    }
    expect(ticks).toBe(40) // bounded at the 2-minute window, not 1000
  })
})
