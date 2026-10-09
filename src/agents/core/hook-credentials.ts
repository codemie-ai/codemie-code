import { readState } from '@/cli/commands/proxy/daemon-manager.js';
import type { SSOCredentials } from '@/providers/core/types.js';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { logger } from '@/utils/logger.js';

/**
 * Credentials the OTLP forwarder daemon will use, resolved in the short-lived hook process
 * so identity fields can be stamped at hook time.
 *
 * Mirrors the daemon's choice in `SSOProxy` (`sso.proxy.ts`): the analytics-sync credentials
 * first, then the target API credentials (`syncCredentials || credentials`). Daemon state
 * carries both URLs; `inspect-desktop.ts` uses the same `syncCodeMieUrl || targetUrl` pairing.
 * Keep the three in step. Only SSO is reachable here: the OTLP daemon is spawned without
 * `--auth-method`, so it always runs as `sso`.
 *
 * Side effect: `getStoredCredentials` clears expired SSO credentials, as it does at daemon start.
 *
 * Never throws; `null` makes identity fall through to the git, codemie_cli and os tiers.
 */
export async function resolveHookCredentials(): Promise<SSOCredentials | null> {
  try {
    const state = await readState();
    const sso = new CodeMieSSO();
    const syncCredentials = state?.syncCodeMieUrl ? await sso.getStoredCredentials(state.syncCodeMieUrl) : null;
    if (syncCredentials) {
      return syncCredentials;
    }
    return state?.targetUrl ? await sso.getStoredCredentials(state.targetUrl) : null;
  } catch (error) {
    logger.debug(`[hook-credentials] credential lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
