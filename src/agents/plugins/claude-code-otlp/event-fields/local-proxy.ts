import { isDaemonAlive, readState } from '@/cli/commands/proxy/daemon-manager.js';
import { logger } from '@/utils/logger.js';
import type { LocalProxy } from '@/agents/core/evidence/routing.js';

/**
 * The running CodeMie proxy daemon's listener URL and upstream target, read from its state file only
 * when the daemon is alive. Any failure yields undefined, which leaves routing unproven (fail closed).
 * Never calls checkStatus (it deletes the state file) and never logs URLs or the gateway key.
 */
export async function resolveLocalProxy(): Promise<LocalProxy | undefined> {
  try {
    const state = await readState();
    if (!state || typeof state.url !== 'string') return undefined;
    if (!(await isDaemonAlive(state))) return undefined;
    return {
      url: state.url,
      targetUrl: typeof state.targetUrl === 'string' ? state.targetUrl : undefined,
      profile: typeof state.profile === 'string' ? state.profile : undefined,
    };
  } catch {
    logger.debug('[claude-code-otlp] local proxy state unavailable');
    return undefined;
  }
}
