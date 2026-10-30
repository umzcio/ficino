import { describe, it, expect } from 'vitest';
import {
  resolveSigningKey, signResource, signWithExpiry, verifyToken,
} from '../../src/shared/signedUrl.js';

const key = Buffer.from('unit-test-key');

describe('signedUrl', () => {
  it('test_sign_verify_roundtrip', () => {
    const token = signResource(key, 'figure-123', 60);
    expect(verifyToken(key, 'figure-123', token)).toBe(true);
  });
  it('test_verify_rejects_wrong_resource', () => {
    const token = signResource(key, 'figure-123', 60);
    expect(verifyToken(key, 'figure-456', token)).toBe(false);
  });
  it('test_expired_token_rejected', () => {
    const token = signResource(key, 'figure-123', -1);
    expect(verifyToken(key, 'figure-123', token)).toBe(false);
  });
  it('test_fail_closed_in_production', () => {
    expect(() => resolveSigningKey({ ENVIRONMENT: 'production' })).toThrow();
  });
  it('production with SIGNED_URL_KEY resolves', () => {
    expect(resolveSigningKey({ ENVIRONMENT: 'production', SIGNED_URL_KEY: ' k ' }).toString()).toBe('k');
  });
  it('token is byte-identical to Python', () => {
    expect(signWithExpiry(Buffer.from('test-key'), 'fig-1', 2000000000))
      .toBe('2000000000.AFF06qp-_kWq9M6fI43du8jwGsZU9hm9K6-VvkruPKY');
  });
  it('derived dev key is the sha256 HEX string of DATABASE_URL + salt', () => {
    expect(resolveSigningKey({ DATABASE_URL: 'postgresql://ficino:ficino@postgres:5432/ficino' }).toString())
      .toBe('c27b48c7063ad7df644530ed189b3dff81db07b2a66982173dfd3287f5160193');
  });
  it('expiry equal to now is still valid', () => {
    const k = Buffer.from('k'); const t = signWithExpiry(k, 'r', 100);
    expect(verifyToken(k, 'r', t, () => 100)).toBe(true);
    expect(verifyToken(k, 'r', t, () => 101)).toBe(false);
  });
  it('malformed, tampered and wrong-length tokens are rejected', () => {
    const t = signWithExpiry(key, 'r', 2000000000);
    expect(verifyToken(key, 'r', 'nodot', () => 0)).toBe(false);
    expect(verifyToken(key, 'r', 'abc.def', () => 0)).toBe(false);
    expect(verifyToken(key, 'r', t + 'x', () => 0)).toBe(false);
    expect(verifyToken(key, 'r', t.slice(0, -2), () => 0)).toBe(false);
    expect(verifyToken(key, 'r', t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), () => 0)).toBe(false);
    expect(verifyToken(key, 'r', t, () => 0)).toBe(true);
  });
});
