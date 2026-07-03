// Wave-5 Task 4: with create_group_chat's placeholder row, GET
// /messages/groups/{id} can now succeed (200) with status:'generating'
// well before the synthesis is done — isGroupChatDone is the pure helper
// usePollTask's isDone consults to tell "still generating" apart from a
// genuinely terminal result. This repo has no @testing-library/react (see
// usePollTask.ts), so this pure function is extracted and tested directly
// rather than rendering GroupChatView, same pattern as
// PostCard.compare.test.ts's arePostsEqual.
import { describe, it, expect } from 'vitest'
import { isGroupChatDone } from './GroupChatView'
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
