/**
 * Caller bounds (abort signal, deadline) for the analytics API clients' retries and requests.
 */

import {
  getSyncStopReason,
  SyncStoppedError,
  type SyncBounds,
  type SyncStopReason,
} from '@/agents/core/session/BaseProcessor.js';

function remainingMs(bounds: SyncBounds): number {
  return bounds.deadlineMs !== undefined ? bounds.deadlineMs - Date.now() : Infinity;
}

/** Throws {@link SyncStoppedError} when the caller aborted or the deadline passed. */
export function throwIfStopped(bounds: SyncBounds): void {
  const reason = getSyncStopReason(bounds);
  if (reason) {
    throw new SyncStoppedError(reason);
  }
}

/**
 * A backoff sleep that ends early at the deadline and wakes at once on abort; throws
 * {@link SyncStoppedError} instead of returning when either stopped it.
 */
export async function backoffWithin(ms: number, bounds: SyncBounds): Promise<void> {
  throwIfStopped(bounds);
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bounds.abortSignal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, Math.min(ms, remainingMs(bounds))));
    bounds.abortSignal?.addEventListener('abort', done, { once: true });
  });
  throwIfStopped(bounds);
}

const signalsThatSent = new WeakSet<AbortSignal>();

/**
 * Records that a send ran under `signal`: a request started, or the send found no credentials.
 * Lets a caller that owns the signal tell an attempt that reached the server from one stopped before it.
 */
export function noteSendAttempt(signal: AbortSignal | undefined): void {
  if (signal) signalsThatSent.add(signal);
}

/** Whether a send ran under `signal` (see {@link noteSendAttempt}). */
export function sendWasAttempted(signal: AbortSignal): boolean {
  return signalsThatSent.has(signal);
}

export interface BoundedRequest {
  /** Aborts on the request's own timeout (capped by the deadline) or on the caller's abort */
  signal: AbortSignal;
  /** Set when the caller's abort or deadline (not the request's own timeout) aborted the request */
  stopReason(): SyncStopReason | undefined;
  /** Clears the timer and the abort listener */
  dispose(): void;
}

/** The signal for one request: its own `timeoutMs`, capped by the remaining budget, plus the caller's abort. */
export function boundedRequest(timeoutMs: number, bounds: SyncBounds): BoundedRequest {
  noteSendAttempt(bounds.abortSignal);
  const controller = new AbortController();
  const remaining = remainingMs(bounds);
  const cappedByDeadline = remaining < timeoutMs;
  let reason: SyncStopReason | undefined;

  const timer = setTimeout(() => {
    if (cappedByDeadline) reason = 'deadline';
    controller.abort();
  }, Math.max(0, Math.min(timeoutMs, remaining)));
  const onAbort = () => {
    reason = 'aborted';
    controller.abort();
  };
  bounds.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (bounds.abortSignal?.aborted) onAbort();

  return {
    signal: controller.signal,
    stopReason: () => reason,
    dispose: () => {
      clearTimeout(timer);
      bounds.abortSignal?.removeEventListener('abort', onAbort);
    },
  };
}
