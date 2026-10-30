import { describe, it, expect } from 'vitest';
import {
  STUB_USER_ID, DEFAULT_WORKSPACE_ID, SIGNED_URL_DEFAULT_TTL, MEDIA_URL_TTL, LIMITS,
} from '../../src/shared/constants.js';

describe('constants', () => {
  it('test_sentinel_ids_are_stable', () => {
    expect(STUB_USER_ID).toBe('00000000-0000-0000-0000-000000000000');
    expect(DEFAULT_WORKSPACE_ID).toBe('00000000-0000-0000-0000-000000000001');
  });
  it('TTLs and list caps match the contract', () => {
    expect(SIGNED_URL_DEFAULT_TTL).toBe(600);
    expect(MEDIA_URL_TTL).toBe(86400);
    expect(LIMITS).toEqual({
      FEEDS: 20, CONTENT: 50, ALERTS: 50, ACTIVITY: 100, PAPER_SUMMARIES: 200,
      LIBRARY: 500, ANNOTATIONS: 1000, SEARCH: 10, SEARCH_CHUNKS: 15,
    });
  });
});
