import { describe, it, expect } from 'vitest';
import { attemptNotServed, boundedRequest, isFailingServerAnswer, requestNeverLeft } from '../bounded-request.js';

/** A fetch failure whose connection never opened, as Node's undici reports it. */
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

describe('boundedRequest', () => {
  it('is aborted at once with reason aborted when the caller signal is already aborted', () => {
    const request = boundedRequest(30_000, { abortSignal: AbortSignal.abort() });

    expect(request.signal.aborted).toBe(true);
    expect(request.stopReason()).toBe('aborted');
    request.dispose();
  });

  /** One request under `signal` whose outcome is an error (no usable answer) or an answer (status, JSON body, success). */
  const settled = (signal: AbortSignal, outcome: unknown | [number, boolean, boolean]) => {
    const request = boundedRequest(30_000, { abortSignal: signal });
    if (Array.isArray(outcome)) request.noteAnswer(...(outcome as [number, boolean, boolean]));
    else request.noteOutcome(outcome);
    request.dispose();
  };

  it('an attempt is not served only while no outcome noted on its signal is a counted failure', () => {
    const signal = new AbortController().signal;
    expect(attemptNotServed(signal)).toBe(false);

    settled(signal, refused());
    expect(attemptNotServed(signal)).toBe(true);

    settled(signal, new Error('Request timeout after 10000ms'));
    expect(attemptNotServed(signal)).toBe(false);

    settled(signal, refused());
    expect(attemptNotServed(signal)).toBe(false);
  });

  it('a successful answer leaves the attempt without a mark', () => {
    const signal = new AbortController().signal;
    settled(signal, [200, true, true]);
    expect(attemptNotServed(signal)).toBe(false);

    settled(signal, refused());
    expect(attemptNotServed(signal)).toBe(true);
  });

  it('a failing server\'s answer leaves the attempt not served until a counted failure; a success beside it changes nothing', () => {
    const counted = new AbortController().signal;
    settled(counted, [503, true, false]);
    expect(attemptNotServed(counted)).toBe(true);
    settled(counted, [403, true, false]);
    expect(attemptNotServed(counted)).toBe(false);

    const mixed = new AbortController().signal;
    settled(mixed, [503, true, false]);
    settled(mixed, [200, true, true]);
    expect(attemptNotServed(mixed)).toBe(true);
  });
});

describe('isFailingServerAnswer', () => {
  it.each([
    [500, true, true], [502, false, true], [503, true, true], [429, true, true], [429, false, true],
    [403, false, true], [413, false, true], [404, false, true],
    [401, true, false], [401, false, false], [403, true, false], [400, true, false], [422, true, false],
    [200, true, false], [200, false, false], [302, false, false],
  ])('status %i, JSON body %s → %s', (status, bodyIsJson, expected) => {
    expect(isFailingServerAnswer(status, bodyIsJson)).toBe(expected);
  });
});

describe('requestNeverLeft', () => {
  it('counts a never-left code inside an AggregateError with no code of its own', () => {
    expect(requestNeverLeft(new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }]))).toBe(true);
  });
});
