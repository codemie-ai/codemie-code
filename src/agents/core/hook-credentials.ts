import { readConnectionRecord, readState } from '@/cli/commands/proxy/daemon-manager.js';
import type { SSOCredentials } from '@/providers/core/types.js';
import { withVerifiedOwner } from '@/providers/core/credential-owner.js';
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
 * With no daemon state (a daemon still starting) and only for a caller that asks (`recordedProfile`: the fresh-session
 * recovery of a start the daemon cannot take yet), the same two URLs come from the profile the hook cold start brings the
 * daemon up on, selected by the cold start's own `resolveColdStartProfile`, so the login stamped here is the one that daemon uses.
 *
 * Carries the signed-in email (`withVerifiedOwner`) so oauth2-proxy logins have an owner.
 *
 * Never throws; `null` makes identity fall through to the git, codemie_cli and os tiers.
 */
export async function resolveHookCredentials(opts: { recordedProfile?: boolean } = {}): Promise<SSOCredentials | null> {
  try {
    const state = (await readState()) ?? (opts.recordedProfile ? await urlsOfRecordedProfile() : null);
    const sso = new CodeMieSSO();
    const syncCredentials = state?.syncCodeMieUrl ? await sso.getStoredCredentials(state.syncCodeMieUrl) : null;
    const credentials =
      syncCredentials ?? (state?.targetUrl ? await sso.getStoredCredentials(state.targetUrl) : null);
    return credentials ? await withVerifiedOwner(credentials) : null;
  } catch (error) {
    logger.debug(`[hook-credentials] credential lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The URLs the daemon of the profile the hook cold start uses starts with (`config.codeMieUrl` for sync, `config.baseUrl`
 * for the target): the recorded profile, or with no connection record the working directory's profile, as the cold start does.
 */
async function urlsOfRecordedProfile(): Promise<{ syncCodeMieUrl?: string; targetUrl?: string } | null> {
  const record = await readConnectionRecord();
  // Lazy: the cold start pulls in the whole connect machinery, which ordinary hooks never need.
  const coldStart = await import('@/cli/commands/proxy/otlp-cold-start.js');
  const config = record
    ? (await coldStart.resolveColdStartProfile(record.profile)).config
    : await coldStart.loadWorkingDirectoryProfile();
  // A blank baseUrl starts no daemon, so there is no login to name.
  return config?.baseUrl?.trim() ? { syncCodeMieUrl: config.codeMieUrl, targetUrl: config.baseUrl } : null;
}
