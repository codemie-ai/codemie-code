import { readState, isProcessAlive } from '../../../cli/commands/proxy/daemon-manager.js';
import { logger } from '../../../utils/logger.js';

interface OtlpEventPayload {
  agentName: string;
  timestamp: string;
  raw: string;
}

/**
 * Fire-and-forget forward of a raw cursor-ide hook event to the local proxy daemon.
 *
 * - Calls readState() to get daemon URL and gateway key
 * - If no daemon or process is dead, logs at debug and returns (no error)
 * - POSTs { agentName, timestamp, raw: rawInput } to daemon's /v1/otlp/hook-events route
 * - Uses 1500ms timeout and swallows all errors (network, non-2xx status)
 * - Never throws, never blocks cursor's exit, never affects hook's exit code
 */
export async function forwardOtlpEvent(rawInput: string, agentName: string): Promise<void> {
  try {
    const state = await readState();
    if (!state) {
      logger.debug('forwardOtlpEvent: no daemon state found');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      logger.debug(`forwardOtlpEvent: daemon pid ${state.pid} not alive`);
      return;
    }

    const payload: OtlpEventPayload = {
      agentName,
      timestamp: new Date().toISOString(),
      raw: rawInput,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(`${state.url}/v1/otlp/hook-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.gatewayKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.debug(`forwardOtlpEvent: received status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Swallow all errors: network failure, timeout, JSON errors, etc.
    // Never let a POST failure affect cursor's exit or the hook's behavior
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`forwardOtlpEvent: ${msg}`);
  }
}
