import { readConnectionRecord, readState } from '@/cli/commands/proxy/daemon-manager.js';
import { ConfigLoader } from '@/utils/config.js';
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
 * With no daemon state (a daemon still starting, or one that has not written it yet) the same two URLs come from the
 * profile `proxy connect` recorded in proxy-connection.json — the profile a hook cold start brings the daemon up on —
 * so the login that daemon will use is the one stamped here.
 *
 * Carries the signed-in email (`withVerifiedOwner`) so oauth2-proxy logins have an owner.
 *
 * Never throws; `null` makes identity fall through to the git, codemie_cli and os tiers.
 */
export async function resolveHookCredentials(): Promise<SSOCredentials | null> {
  try {
    const state = (await readState()) ?? (await urlsOfRecordedProfile());
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

/** The URLs the daemon of the recorded profile starts with (`config.codeMieUrl` for sync, `config.baseUrl` for the target). */
async function urlsOfRecordedProfile(): Promise<{ syncCodeMieUrl?: string; targetUrl?: string } | null> {
  const record = await readConnectionRecord();
  if (!record) return null;
  // A name the configs do not know loads as another profile: then there is nothing to name.
  const config = await ConfigLoader.load(process.cwd(), { name: record.profile });
  return config.name === record.profile ? { syncCodeMieUrl: config.codeMieUrl, targetUrl: config.baseUrl } : null;
}
