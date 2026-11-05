import { describe, expect, it } from 'vitest';
import { feedStatusFromJob, isStuckJobState, summaryStatusFromJob } from '../../src/feed/status.js';
import type { JobState } from '../../src/jobs/queue.js';

const T = 'task-1';
const st = (state: JobState['state'], progress: JobState['progress'] = null, output: unknown = null): JobState => ({
  queue: 'generate_feed', state, progress, output,
});

describe('feedStatusFromJob', () => {
  it.each(['missing', 'created'] as const)('%s -> pending', (s) => {
    expect(feedStatusFromJob(T, st(s))).toEqual({ status: 'pending', task_id: T });
  });
  it('retry', () => expect(feedStatusFromJob(T, st('retry'))).toEqual({ status: 'retry', task_id: T }));
  it('active with progress -> generating + meta', () => {
    const meta = { step: 'scoping', feed_id: 'f' };
    expect(feedStatusFromJob(T, st('active', meta))).toEqual({ status: 'generating', task_id: T, meta });
  });
  it('active without progress -> started', () => {
    expect(feedStatusFromJob(T, st('active'))).toEqual({ status: 'started', task_id: T });
  });
  it('completed reads feed_id/post_count/duration_ms from output', () => {
    expect(feedStatusFromJob(T, st('completed', null, { feed_id: 'f', post_count: 3, duration_ms: 9, x: 1 }))).toEqual({
      status: 'complete', task_id: T, feed_id: 'f', post_count: 3, duration_ms: 9,
    });
  });
  it('completed with missing or non-object output -> nulls', () => {
    const nulls = { status: 'complete', task_id: T, feed_id: null, post_count: null, duration_ms: null };
    expect(feedStatusFromJob(T, st('completed', null, null))).toEqual(nulls);
    expect(feedStatusFromJob(T, st('completed', null, 5))).toEqual(nulls);
    expect(feedStatusFromJob(T, st('completed', null, { feed_id: 'f' }))).toEqual({ ...nulls, feed_id: 'f' });
  });
  it('failed -> error is the serialized error message only', () => {
    expect(feedStatusFromJob(T, st('failed', null, { name: 'ValueError', message: 'boom', stack: 's' }))).toEqual({
      status: 'error', task_id: T, error: 'boom',
    });
  });
  it('the all-chunks-excluded embed mismatch message reaches error verbatim', () => {
    const message =
      'No chunks embedded with ollama:qwen3-embedding:latest@1024: 40 chunks in scope use a different embedding model. Re-process your papers or switch the embedding model back.';
    expect(feedStatusFromJob(T, st('failed', null, { name: 'Error', message }))).toEqual({
      status: 'error', task_id: T, error: message,
    });
  });
  it('failed with a non-string message or non-object output falls back to String()', () => {
    expect(feedStatusFromJob(T, st('failed', null, 'plain')).error).toBe('plain');
    expect(feedStatusFromJob(T, st('failed', null, null)).error).toBe('');
    expect(feedStatusFromJob(T, st('failed', null, { message: 5 })).error).toBe('[object Object]');
  });
  it('cancelled -> revoked', () => {
    expect(feedStatusFromJob(T, st('cancelled'))).toEqual({ status: 'revoked', task_id: T });
  });
});

describe('summaryStatusFromJob', () => {
  const P = 'paper-1';
  const states = ['created', 'retry', 'active', 'completed', 'cancelled', 'failed', 'missing'] as const;
  it.each(states)('%s', (s) => {
    const out = summaryStatusFromJob(P, st(s, null, s === 'failed' ? { message: 'boom' } : null));
    if (s === 'completed') expect(out).toEqual({ status: 'complete', paper_id: P });
    else if (s === 'failed') expect(out).toEqual({ status: 'error', error: 'boom' });
    else expect(out).toEqual({ status: 'generating' });
  });
  it('failed with a non-object output stringifies it', () => {
    expect(summaryStatusFromJob(P, st('failed', null, 'x'))).toEqual({ status: 'error', error: 'x' });
  });
});

describe('isStuckJobState', () => {
  it('is true for exactly failed, cancelled and missing', () => {
    const all = ['created', 'retry', 'active', 'completed', 'cancelled', 'failed', 'missing'] as const;
    expect(all.filter((s) => isStuckJobState(s))).toEqual(['cancelled', 'failed', 'missing']);
  });
});
