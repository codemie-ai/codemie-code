import { OtlpHookBatchRequest } from '@/providers/plugins/sso/proxy/plugins/otlp.plugin.js';
import { readState } from '../../cli/commands/proxy/daemon-manager.js';
import { logger } from '../../utils/logger.js';

const FORWARD_TIMEOUT_MS = 3_000;

function isConnectionRefused(err: unknown): boolean {
  const code = (error: unknown): unknown => (typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined);
  return code(err) === 'ECONNREFUSED' || (err instanceof Error && code(err.cause) === 'ECONNREFUSED');
}

/**
 * Forward one hook invocation's complete, wire-ready events to the local proxy daemon's
 * analytics spool endpoint, as a single batch so the outcome is all-or-nothing.
 *
 * - Calls readState() to get the daemon URL and gateway key
 * - POSTs { agentName, hookEvents } to /v1/analytics/hooks
 * - Returns true for an empty list or a 2xx response; false for a missing daemon, a thrown
 *   error, an abort, or a non-2xx status
 * - Fixed 3s abort timeout. Never throws, never affects the hook's exit code.
 */
export async function forwardOtlpEventsToSpool(
  events: Record<string, unknown>[],
  agentName: string,
  opts?: { evidenceV?: 1; evidenceLoss?: { sessionId: string; reason: string; events: number }; undelivered?: { value: boolean } }
): Promise<boolean> {
  if (events.length === 0 && !opts?.evidenceLoss) {
    return true;
  }

  try {
    const state = await readState();

    if (!state) {
      logger.debug('forwardOtlpEventsToSpool: daemon unavailable, skipping forward');
      if (opts?.undelivered) opts.undelivered.value = true;
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

    const body: OtlpHookBatchRequest = { agentName, hookEvents: events, ...(opts?.evidenceV ? { evidence_v: 1 } : {}), ...(opts?.evidenceLoss ? { evidence_loss: { session_id: opts.evidenceLoss.sessionId, reason: opts.evidenceLoss.reason, events: opts.evidenceLoss.events } } : {}) };

    try {
      const response = await fetch(`${state.url}/v1/analytics/hooks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.gatewayKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.debug(`forwardOtlpEventsToSpool: daemon responded ${response.status}`);
      }
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Only a refused connection proves nothing was sent; a timeout or a reset may come after the daemon spooled the batch.
    if (opts?.undelivered && isConnectionRefused(err)) opts.undelivered.value = true;
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : err instanceof Error ? err.message : String(err);
    logger.debug(`forwardOtlpEventsToSpool: ${reason}`);
    return false;
  }
}
