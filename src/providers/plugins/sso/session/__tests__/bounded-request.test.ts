import { describe, it, expect } from 'vitest';
import {
  attemptNotServed,
  attemptOutcome,
  boundedRequest,
  classifyAnswer,
  classifyError,
  isExpiredCredentialAnswer,
  isFailingServerAnswer,
  newRequestGroup,
  requestNeverLeft,
  type RequestGroup,
} from '../bounded-request.js';

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

describe('classifyAnswer', () => {
  it.each([
    [200, true, true, 'ok'],
    [401, true, false, 'auth'], [401, false, false, 'auth'],
    [403, true, false, 'auth'], [403, false, false, 'auth'],
    [400, true, false, 'rejected'], [422, true, false, 'rejected'],
    [404, true, false, 'counted'], [408, true, false, 'counted'], [413, true, false, 'counted'],
    [200, true, false, 'counted'],
    [500, true, false, 'outage'], [503, false, false, 'outage'], [429, true, false, 'outage'],
    [404, false, false, 'outage'], [400, false, false, 'outage'],
    [502, true, false, 'outage'], [504, true, false, 'outage'],
  ])('status %i, JSON body %s, success %s → %s', (status, bodyIsJson, success, expected) => {
    expect(classifyAnswer(status, bodyIsJson, success)).toBe(expected);
  });
});

describe('classifyError', () => {
  it('a connection that never opened, an own timeout and a reset after send are outages', () => {
    expect(classifyError(refused(), undefined)).toBe('outage');
    expect(classifyError(new Error('Request timeout after 10000ms'), undefined)).toBe('outage');
    expect(classifyError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), undefined)).toBe('outage');
  });

  it('a stop by the caller is not an attempt', () => {
    expect(classifyError(new Error('aborted'), 'deadline')).toBe('not-attempt');
    expect(classifyError(new Error('aborted'), 'aborted')).toBe('not-attempt');
  });
});

describe('attemptOutcome', () => {
  const noted = (signal: AbortSignal, outcome: unknown | [number, boolean, boolean]) => {
    const request = boundedRequest(30_000, { abortSignal: signal });
    const result = Array.isArray(outcome)
      ? request.noteAnswer(...(outcome as [number, boolean, boolean]))
      : request.noteOutcome(outcome);
    request.dispose();
    return result;
  };

  it('is undefined before anything is noted', () => {
    expect(attemptOutcome(new AbortController().signal)).toBeUndefined();
  });

  it('returns the outcome of each note and records the worst one under the signal', () => {
    const signal = new AbortController().signal;
    expect(noted(signal, refused())).toBe('outage');
    expect(attemptOutcome(signal)).toBe('outage');
    expect(noted(signal, [404, true, false])).toBe('counted');
    expect(attemptOutcome(signal)).toBe('counted');
    expect(noted(signal, [401, true, false])).toBe('auth');
    expect(attemptOutcome(signal)).toBe('auth');
    // A permission denial outranks a counted failure whichever came first
    expect(noted(signal, [404, true, false])).toBe('counted');
    expect(attemptOutcome(signal)).toBe('auth');
    expect(noted(signal, [400, true, false])).toBe('rejected');
    expect(attemptOutcome(signal)).toBe('rejected');
    expect(noted(signal, [503, true, false])).toBe('outage');
    expect(attemptOutcome(signal)).toBe('rejected');
  });

  it('three in-request retries under one signal give one outcome, the worst', () => {
    const signal = new AbortController().signal;
    noted(signal, [503, true, false]);
    noted(signal, [200, true, true]);
    noted(signal, [401, true, false]);
    expect(attemptOutcome(signal)).toBe('auth');
  });

  it('the tries of one logical request note only the last try outcome; other requests under the signal keep theirs', () => {
    const signal = new AbortController().signal;
    const tryOf = (group: RequestGroup, status: number, success: boolean) => {
      const request = boundedRequest(30_000, { abortSignal: signal }, group);
      request.noteAnswer(status, true, success);
      request.dispose();
    };
    const first = newRequestGroup();
    tryOf(first, 503, false);
    expect(attemptOutcome(signal)).toBe('outage');
    tryOf(first, 200, true);
    expect(attemptOutcome(signal)).toBeUndefined();

    const second = newRequestGroup();
    tryOf(second, 503, false);
    tryOf(second, 503, false);
    expect(attemptOutcome(signal)).toBe('outage');
    // Another logical request that succeeds does not erase the outage of the one that failed
    tryOf(newRequestGroup(), 200, true);
    expect(attemptOutcome(signal)).toBe('outage');
  });

  it('a stop is the weakest outcome and a success records nothing', () => {
    const stopped = AbortSignal.abort();
    const request = boundedRequest(30_000, { abortSignal: stopped });
    request.noteOutcome(new Error('x'));
    request.dispose();
    expect(attemptOutcome(stopped)).toBe('not-attempt');

    const ok = new AbortController().signal;
    expect(noted(ok, [200, true, true])).toBe('ok');
    expect(attemptOutcome(ok)).toBeUndefined();
  });
});

describe('isExpiredCredentialAnswer', () => {
  it.each([[401, true, true], [401, false, true], [403, true, true], [403, false, true], [404, true, false], [429, false, false], [500, true, false], [200, true, false]])(
    'status %i, JSON body %s → %s',
    (status, bodyIsJson, expected) => {
      expect(isExpiredCredentialAnswer(status, bodyIsJson, undefined)).toBe(expected);
    },
  );
});

describe('requestNeverLeft', () => {
  it('counts a never-left code inside an AggregateError with no code of its own', () => {
    expect(requestNeverLeft(new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }]))).toBe(true);
  });
});
