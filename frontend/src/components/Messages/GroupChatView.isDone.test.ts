// Wave-5 Task 4: with create_group_chat's placeholder row, GET
// /messages/groups/{id} can now succeed (200) with status:'generating'
// well before the synthesis is done — isGroupChatDone is the pure helper
// usePollTask's isDone consults to tell "still generating" apart from a
// genuinely terminal result. This repo has no @testing-library/react (see
// usePollTask.ts), so this pure function is extracted and tested directly
// rather than rendering GroupChatView, same pattern as
// PostCard.compare.test.ts's arePostsEqual.
import { describe, it, expect } from 'vitest'
import { isGroupChatDone, nextGeneratingStreak, isGeneratingStreakExhausted } from './GroupChatView'
import type { GroupChat } from '../../types'

function baseChat(overrides: Partial<GroupChat>): GroupChat {
  return {
    id: 'synth-1',
    name: 'Test synth',
    papers: {},
    messages: [],
    generated_at: '2026-01-01T00:00:00Z',
    status: 'complete',
    ...overrides,
  }
}

describe('isGroupChatDone', () => {
  it('is NOT done while status is generating (fast path, no more 404s)', () => {
    expect(isGroupChatDone(baseChat({ status: 'generating', task_id: 'task-1' }))).toBe(false)
  })

  it('is done when status is error (finally distinguishable from slow)', () => {
    expect(isGroupChatDone(baseChat({ status: 'error' }))).toBe(true)
  })

  it('is done when status is complete', () => {
    expect(isGroupChatDone(baseChat({ status: 'complete', messages: [{ role: 'synthesis', type: 'summary', content: 'x' }] }))).toBe(true)
  })
})

// R10 wave-5 follow-up: startPoll's maxAttempts only bounds consecutive
// REJECTIONS — a 200 {status:'generating'} resets its attempt counter, so
// a hard-stuck row (worker OOM-killed before its except block could mark
// status='error') would poll forever on the fast path. Pre-fix, the same
// stuck synthesis 404'd into the bounded ~100s window, so unbounded here
// would be strictly worse. The streak helpers bound the generating fast
// path with the SAME window as the 404 fallback.
describe('generating-streak bound (R10 wave-5 follow-up)', () => {
  it('increments the streak on consecutive generating responses', () => {
    const generating = baseChat({ status: 'generating', task_id: 'task-1' })
    expect(nextGeneratingStreak(0, generating)).toBe(1)
    expect(nextGeneratingStreak(1, generating)).toBe(2)
    expect(nextGeneratingStreak(24, generating)).toBe(25)
  })

  it('resets the streak on any non-generating response', () => {
    expect(nextGeneratingStreak(24, baseChat({ status: 'complete' }))).toBe(0)
    expect(nextGeneratingStreak(24, baseChat({ status: 'error' }))).toBe(0)
  })

  it('exhausts at the same window as the 404 path (25 x 4s ≈ 100s), not before', () => {
    expect(isGeneratingStreakExhausted(24)).toBe(false)
    expect(isGeneratingStreakExhausted(25)).toBe(true)
    expect(isGeneratingStreakExhausted(26)).toBe(true)
  })

  it('a stuck-generating row cannot poll unboundedly (streak monotonically reaches the bound)', () => {
    const generating = baseChat({ status: 'generating', task_id: 'dead-task' })
    let streak = 0
    let ticks = 0
    while (!isGeneratingStreakExhausted(streak) && ticks < 1000) {
      streak = nextGeneratingStreak(streak, generating)
      ticks += 1
    }
    expect(ticks).toBe(25) // bounded at the 404 window's equivalent, not 1000
  })
})
