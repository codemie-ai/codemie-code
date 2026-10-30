import { describe, it, expect } from 'vitest';
import { boundedRequest } from '../bounded-request.js';

describe('boundedRequest', () => {
  it('is aborted at once with reason aborted when the caller signal is already aborted', () => {
    const request = boundedRequest(30_000, { abortSignal: AbortSignal.abort() });

    expect(request.signal.aborted).toBe(true);
    expect(request.stopReason()).toBe('aborted');
    request.dispose();
  });
});
