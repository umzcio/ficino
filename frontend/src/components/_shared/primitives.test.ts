// Plan 024: DangerButton's confirm handler must surface failures instead of
// wedging in the Confirm/Cancel state with an unhandled rejection.
// runDangerConfirm is the extracted, testable half of that behavior.
import { describe, it, expect } from 'vitest'
import { runDangerConfirm } from './primitives'

describe('runDangerConfirm', () => {
  it('returns "done" when onConfirm resolves', async () => {
    await expect(runDangerConfirm(async () => {})).resolves.toBe('done')
  })

  it('returns "failed" when onConfirm rejects, containing the rejection', async () => {
    await expect(runDangerConfirm(async () => { throw new Error('API error 500') })).resolves.toBe('failed')
  })

  it('returns "done" for a plain sync onConfirm (the void arm of the type)', async () => {
    await expect(runDangerConfirm(() => {})).resolves.toBe('done')
  })
})
