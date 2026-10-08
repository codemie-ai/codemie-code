import { OtlpHookSpoolData } from '@/providers/plugins/sso/proxy/plugins/otlp.plugin.js';
import { readState } from '../../cli/commands/proxy/daemon-manager.js';
import { logger } from '../../utils/logger.js';

/**
 * Fire-and-forget forward of a raw hook event to the local proxy
 * daemon's analytics spool endpoint.
 *
 * - Calls readState() to get daemon URL and gateway key
 * - POSTs { agentName, timestamp, raw: rawInput } to /v1/analytics/hooks
 * - Uses 1000ms timeout and swallows all errors
 * - Never throws, never affects hook's exit code
 */
export async function forwardOtlpEventToSpool(rawEvent: string, agentName: string): Promise<void> {
  try {
    const state = await readState();

    if (!state) {
      logger.debug('forwardOtlpEventToSpool: daemon unavailable, skipping forward');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);

    const body: OtlpHookSpoolData = {
      agentName,
      timestamp: Date.now(),
      raw: rawEvent
    }

    try {
      await fetch(`${state.url}/v1/analytics/hooks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.gatewayKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : err instanceof Error ? err.message : String(err);
    logger.debug(`forwardOtlpEventToSpool: ${reason}`);
  }
}
