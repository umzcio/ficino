import { describe, it, expect } from 'vitest'
import { isApiKeyConfigured } from './apiKey'

describe('isApiKeyConfigured', () => {
  it('is true for the server redaction marker "set"', () => {
    expect(isApiKeyConfigured('set')).toBe(true)
  })

  it('is false for an empty string (no key configured)', () => {
    expect(isApiKeyConfigured('')).toBe(false)
  })

  it('is false for a real-looking key value (never actually round-trips, but guard anyway)', () => {
    expect(isApiKeyConfigured('sk-ant-abc123')).toBe(false)
  })

  it('is false for any other string, including near-misses of the marker', () => {
    expect(isApiKeyConfigured('Set')).toBe(false)
    expect(isApiKeyConfigured('set ')).toBe(false)
  })
})
