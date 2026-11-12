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
 * Records that a request started under `signal`.
 * Lets a caller that owns the signal tell an attempt that made a request from one stopped before any.
 */
export function noteSendAttempt(signal: AbortSignal | undefined): void {
  if (signal) signalsThatSent.add(signal);
}

/** Whether a send ran under `signal` (see {@link noteSendAttempt}). */
export function sendWasAttempted(signal: AbortSignal): boolean {
  return signalsThatSent.has(signal);
}

const signalsRejected = new WeakSet<AbortSignal>();

/**
 * Records that the server rejected the credentials of a request under `signal` (401, or an HTML
 * SSO login page): the caller that owns the signal does not count it as a delivery attempt.
 */
export function noteAuthFailure(signal: AbortSignal | undefined): void {
  if (signal) signalsRejected.add(signal);
}

/** Whether a request under `signal` met rejected credentials (see {@link noteAuthFailure}). */
export function authWasRejected(signal: AbortSignal): boolean {
  return signalsRejected.has(signal);
}

const signalsAwaitingDestination = new WeakSet<AbortSignal>();

/**
 * Records that a legacy metric under `signal` was withheld while the backend's answer on the session's destination is
 * still to come (EPMCDME-17054 `destination-unconfirmed` / `destination-pending`): nothing was tried, so the caller
 * that owns the signal does not count it as a delivery attempt.
 */
export function noteAwaitingDestination(signal: AbortSignal | undefined): void {
  if (signal) signalsAwaitingDestination.add(signal);
}

/** Whether a legacy metric under `signal` waits for the destination's confirmation (see {@link noteAwaitingDestination}). */
export function awaitingDestination(signal: AbortSignal): boolean {
  return signalsAwaitingDestination.has(signal);
}

/** Node system error codes of a connection that never opened: the request was never sent. */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/**
 * Whether `error`, along its `cause` chain and the `errors` of an `AggregateError` (one per address tried), is a
 * connection-level failure before the request left: no server can have served it. An HTTP answer, a timeout, a
 * reset after the send and any other error are not.
 */
export function requestNeverLeft(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (NEVER_SENT_CODES.has((current as { code?: unknown }).code as string)) return true;
    pending.push((current as { cause?: unknown }).cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

const signalsReached = new WeakSet<AbortSignal>();
const signalsNeverLeft = new WeakSet<AbortSignal>();
const signalsFailingServer = new WeakSet<AbortSignal>();

/**
 * Whether an answer is a failing server's: a 5xx, a 429, or a 4xx whose body is not JSON (a proxy's or WAF's own
 * page). A 401 is rejected credentials whatever its body; a JSON 4xx is the application's verdict on the request.
 */
export function isFailingServerAnswer(status: number, bodyIsJson: boolean): boolean {
  if (status >= 500 || status === 429) return true;
  return status >= 400 && status !== 401 && !bodyIsJson;
}

/**
 * Records that a request under `signal` ended in a counted failure: a server may have served it — it timed out, failed
 * after its connection opened (a reset after the send, a body that could not be read), or got an answer that is
 * neither a success nor a failing server's (see {@link isFailingServerAnswer}).
 */
export function noteServerReached(signal: AbortSignal | undefined): void {
  if (signal) signalsReached.add(signal);
}

/** Records that a request under `signal` failed before its connection opened (see {@link requestNeverLeft}). */
export function noteNeverLeft(signal: AbortSignal | undefined): void {
  if (signal) signalsNeverLeft.add(signal);
}

/** Records that a request under `signal` got a failing server's answer (see {@link isFailingServerAnswer}). */
export function noteFailingServer(signal: AbortSignal | undefined): void {
  if (signal) signalsFailingServer.add(signal);
}

/** Whether a request under `signal` got a failing server's answer (see {@link noteFailingServer}). */
export function failingServerAnswered(signal: AbortSignal): boolean {
  return signalsFailingServer.has(signal);
}

/**
 * Whether no request under `signal` was served: one failed before its connection opened or got a failing server's
 * answer, and none ended in a counted failure (see {@link noteNeverLeft}, {@link noteFailingServer},
 * {@link noteServerReached}). A successful request does not change it.
 */
export function attemptNotServed(signal: AbortSignal): boolean {
  return (signalsNeverLeft.has(signal) || signalsFailingServer.has(signal)) && !signalsReached.has(signal);
}

export interface BoundedRequest {
  /** Aborts on the request's own timeout (capped by the deadline) or on the caller's abort */
  signal: AbortSignal;
  /** Set when the caller's abort or deadline (not the request's own timeout) aborted the request */
  stopReason(): SyncStopReason | undefined;
  /** Clears the timer and the abort listener */
  dispose(): void;
  /**
   * Notes on the caller's signal a request that got no usable answer: an `error` that never left notes
   * {@link noteNeverLeft}, any other (a timeout, a reset, a body that could not be read, the caller's abort)
   * {@link noteServerReached}.
   */
  noteOutcome(error: unknown): void;
  /**
   * Notes on the caller's signal an answered request once its status and body kind are known: a success notes
   * nothing, a failing server's answer {@link noteFailingServer}, any other {@link noteServerReached}.
   */
  noteAnswer(status: number, bodyIsJson: boolean, success: boolean): void;
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
    noteOutcome: (error: unknown) => {
      if (requestNeverLeft(error)) noteNeverLeft(bounds.abortSignal);
      else noteServerReached(bounds.abortSignal);
    },
    noteAnswer: (status: number, bodyIsJson: boolean, success: boolean) => {
      if (success) return;
      if (isFailingServerAnswer(status, bodyIsJson)) noteFailingServer(bounds.abortSignal);
      else noteServerReached(bounds.abortSignal);
    },
  };
}
