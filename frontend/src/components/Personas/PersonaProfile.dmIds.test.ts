// R10 FE-21: PersonaProfile used to key DM bubbles on array index
// (`dmMessages.map((msg, i) => <div key={i}>`), which is unsafe on a
// mid-list-deletable list — a deleted bubble's key gets reused by whatever
// message shifts into its old slot. withDmIds stamps every message with a
// module-counter-backed client id every time a fresh array comes back from
// the server, so keys stay tied to the message that's actually there.
import { describe, it, expect } from 'vitest'
import { withDmIds, type DmMessage } from './PersonaProfile'
import type { ReplyMessage } from '../../lib/api'

describe('withDmIds', () => {
  it('assigns a unique _id to every message in the array', () => {
    const messages: ReplyMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'persona', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ]
    const stamped = withDmIds(messages)
    const ids = stamped.map((m) => m._id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('preserves message content/role while adding the id', () => {
    const messages: ReplyMessage[] = [{ role: 'user', content: 'hi', persona: undefined }]
    const [stamped] = withDmIds(messages)
    expect(stamped.role).toBe('user')
    expect(stamped.content).toBe('hi')
    expect(typeof stamped._id).toBe('number')
  })

  it('never reuses an id across separate calls (simulates re-fetch after delete)', () => {
    const first = withDmIds([
      { role: 'user', content: 'a' },
      { role: 'persona', content: 'b' },
      { role: 'user', content: 'c' },
    ])
    // Simulate deleting the middle message and the server returning the
    // remaining two — a fresh call, not a filter of `first`.
    const second: DmMessage[] = withDmIds([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'c' },
    ])
    const firstIds = new Set(first.map((m) => m._id))
    for (const m of second) {
      expect(firstIds.has(m._id)).toBe(false)
    }
  })
})
