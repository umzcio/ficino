// R10 BP-9: getApiErrorDetail is the pure helper AuthContext uses to pull a
// FastAPI { detail: "..." } message out of a thrown ApiError (from
// request()) so setError() can show the server's actual message instead of
// a generic fallback — same behavior the old per-site raw-fetch code got by
// manually parsing res.json().detail.
import { describe, it, expect } from 'vitest'
import { ApiError, getApiErrorDetail, isNotFoundError } from './api'

describe('getApiErrorDetail', () => {
  it('extracts a string detail from an ApiError JSON body', () => {
    const err = new ApiError(401, 'API error 401: {"detail":"Invalid credentials"}', { detail: 'Invalid credentials' })
    expect(getApiErrorDetail(err, 'fallback')).toBe('Invalid credentials')
  })

  it('falls back when the ApiError body has no detail field', () => {
    const err = new ApiError(500, 'API error 500: {"other":"x"}', { other: 'x' })
    expect(getApiErrorDetail(err, 'fallback')).toBe('fallback')
  })

  it('falls back when the ApiError body is undefined (non-JSON response text)', () => {
    const err = new ApiError(502, 'API error 502: <html>Bad Gateway</html>', undefined)
    expect(getApiErrorDetail(err, 'fallback')).toBe('fallback')
  })

  it('falls back when detail is present but not a string', () => {
    const err = new ApiError(422, 'API error 422: {"detail":[{"msg":"bad"}]}', { detail: [{ msg: 'bad' }] })
    expect(getApiErrorDetail(err, 'fallback')).toBe('fallback')
  })

  it('falls back for a plain Error (network-level failure, not an ApiError)', () => {
    const err = new TypeError('Failed to fetch')
    expect(getApiErrorDetail(err, 'Network error — check your connection.')).toBe('Network error — check your connection.')
  })

  it('falls back for a non-Error thrown value', () => {
    expect(getApiErrorDetail('boom', 'fallback')).toBe('fallback')
  })

  it('preserves the original message format on the thrown ApiError itself', () => {
    const err = new ApiError(404, 'API error 404: {"detail":"Not found"}', { detail: 'Not found' })
    expect(err.message).toBe('API error 404: {"detail":"Not found"}')
    expect(err.status).toBe(404)
    expect(err).toBeInstanceOf(Error)
  })
})

// R10 wave-3 final-review Minor 5 (carried): PersonaProfile's handleClearDm
// optimistically clears local DM state before the DELETE resolves; if the
// thread was already cleared server-side (e.g. from another tab) the
// DELETE 404s. isNotFoundError lets that catch branch tell "already gone"
// (treat as success) apart from a real failure (roll back).
describe('isNotFoundError', () => {
  it('is true for an ApiError with status 404', () => {
    const err = new ApiError(404, 'API error 404: {"detail":"Not found"}', { detail: 'Not found' })
    expect(isNotFoundError(err)).toBe(true)
  })

  it('is false for an ApiError with a different status', () => {
    const err = new ApiError(500, 'API error 500: server exploded', undefined)
    expect(isNotFoundError(err)).toBe(false)
  })

  it('is false for a plain Error (network-level failure, not an ApiError)', () => {
    expect(isNotFoundError(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('is false for a non-Error thrown value', () => {
    expect(isNotFoundError('boom')).toBe(false)
  })
})
