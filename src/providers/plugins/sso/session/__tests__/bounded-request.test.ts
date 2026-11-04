import { describe, it, expect } from 'vitest';
import { attemptNeverReached, boundedRequest, requestNeverLeft } from '../bounded-request.js';

/** A fetch failure whose connection never opened, as Node's undici reports it. */
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

describe('boundedRequest', () => {
  it('is aborted at once with reason aborted when the caller signal is already aborted', () => {
    const request = boundedRequest(30_000, { abortSignal: AbortSignal.abort() });

    expect(request.signal.aborted).toBe(true);
    expect(request.stopReason()).toBe('aborted');
    request.dispose();
  });

  it('an attempt never reached the server only while every outcome noted on its signal never left', () => {
    const signal = new AbortController().signal;
    const settled = (error?: unknown) => {
      const request = boundedRequest(30_000, { abortSignal: signal });
      request.noteOutcome(error);
      request.dispose();
    };
    expect(attemptNeverReached(signal)).toBe(false);

    settled(refused());
    expect(attemptNeverReached(signal)).toBe(true);

    settled(new Error('Request timeout after 10000ms'));
    expect(attemptNeverReached(signal)).toBe(false);

    settled(refused());
    expect(attemptNeverReached(signal)).toBe(false);
  });

  it('an answered request marks its attempt as reached', () => {
    const signal = new AbortController().signal;
    const request = boundedRequest(30_000, { abortSignal: signal });
    request.noteOutcome();
    request.dispose();

    expect(attemptNeverReached(signal)).toBe(false);
    const retry = boundedRequest(30_000, { abortSignal: signal });
    retry.noteOutcome(refused());
    retry.dispose();
    expect(attemptNeverReached(signal)).toBe(false);
  });
});

describe('requestNeverLeft', () => {
  it('counts a never-left code inside an AggregateError with no code of its own', () => {
    expect(requestNeverLeft(new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }]))).toBe(true);
  });
});
