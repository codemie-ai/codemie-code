import { OtlpHookBatchRequest } from '@/providers/plugins/sso/proxy/plugins/otlp.plugin.js';
import { readState } from '../../cli/commands/proxy/daemon-manager.js';
import { logger } from '../../utils/logger.js';

const FORWARD_TIMEOUT_MS = 3_000;

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
  agentName: string
): Promise<boolean> {
  if (events.length === 0) {
    return true;
  }

  try {
    const state = await readState();

    if (!state) {
      logger.debug('forwardOtlpEventsToSpool: daemon unavailable, skipping forward');
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

    const body: OtlpHookBatchRequest = { agentName, hookEvents: events };

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
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : err instanceof Error ? err.message : String(err);
    logger.debug(`forwardOtlpEventsToSpool: ${reason}`);
    return false;
  }
}
