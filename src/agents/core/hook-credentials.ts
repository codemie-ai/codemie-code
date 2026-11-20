import { readState } from '@/cli/commands/proxy/daemon-manager.js';
import { withVerifiedOwner } from '@/providers/core/credential-owner.js';
import { resolveSSOAuthForUrl } from '@/providers/plugins/sso/auth/index.js';
import type { SSOAuth } from '@/providers/plugins/sso/auth/types.js';
import { logger } from '@/utils/logger.js';

/**
 * Credentials the OTLP forwarder daemon will use, resolved in the short-lived hook process
 * so identity fields can be stamped at hook time.
 *
 * Mirrors the daemon's choice in `SSOProxy` (`sso.proxy.ts`): the analytics-sync credentials
 * first, then the target API credentials (`syncCredentials || credentials`). Daemon state
 * carries both URLs; `inspect-desktop.ts` uses the same `syncCodeMieUrl || targetUrl` pairing.
 * Keep the three in step. Only SSO is reachable here: the OTLP daemon is spawned without
 * `--auth-method`, so it always runs as `sso`. Both stored SSO credential types resolve here:
 * cookies, and the JWT a reverse proxy in front of the backend issued instead.
 *
 * Side effect: the resolver clears expired SSO credentials, as it does at daemon start.
 *
 * Carries the signed-in email (`withVerifiedOwner`) so oauth2-proxy logins have an owner.
 *
 * Never throws; `null` makes identity fall through to the git, codemie_cli and os tiers.
 */
export async function resolveHookCredentials(): Promise<SSOAuth | null> {
  try {
    const state = await readState();
    const syncAuth = state?.syncCodeMieUrl ? await resolveSSOAuthForUrl(state.syncCodeMieUrl) : null;
    const auth = syncAuth ?? (state?.targetUrl ? await resolveSSOAuthForUrl(state.targetUrl) : null);
    return auth ? await withVerifiedOwner(auth) : null;
  } catch (error) {
    logger.debug(`[hook-credentials] credential lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
