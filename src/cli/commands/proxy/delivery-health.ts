import chalk from 'chalk';
import { getAnalyticsPlatformSource, getPlatformUrl, getStoredAnalyticsCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { withVerifiedOwner } from '@/providers/core/credential-owner.js';
import { applicableAuthMarker } from '@/providers/plugins/sso/sso.auth-gate.js';
import { summarizeSpoolDelivery } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import { forwarderIdentity } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { advertisesContract, getPolicyState, type PolicyState } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { logger } from '@/utils/logger.js';
import type { DaemonState } from './daemon-manager.js';

export type DeliveryReason =
  | 'credentials_expired'
  | 'auth_rejected'
  | 'identity_mismatch'
  | 'send_failed'
  | 'classification_unreachable'
  | 'classification_unsupported';

export interface DeliveryHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  reason?: DeliveryReason;
  pendingBytes: number;
}

/**
 * Label and remedy per reason; keyed by `Record` so a new code without a label fails to compile.
 * `identity_mismatch` and `send_failed` come from the spool, which is shared by the whole machine,
 * so their labels say so. `classification_unreachable` and `classification_unsupported` are
 * deliberately written for a non-technical reader instead — plain wording over machine-scope
 * precision — and neither has a `run`: there is nothing the CLI can do locally — the first clears
 * on its own once the server responds, the second needs a CodeMie administrator to enable the
 * feature server-side.
 *
 * Known limitation: `classification_unreachable`/`classification_unsupported` read the active
 * profile's capability against every session in the shared spool (see `SpoolDeliverySummary`'s
 * docstring) — a session still pending from a profile the user has since switched away from is
 * judged by the wrong capability until it drains or is lost to retention.
 */
export const DELIVERY_REASONS: Record<DeliveryReason, { label: string; run?: string }> = {
  credentials_expired: { label: 'credentials expired', run: 'codemie profile login' },
  auth_rejected: { label: 'analytics auth rejected', run: 'codemie profile login' },
  identity_mismatch: { label: 'analytics identity mismatch on this machine', run: 'codemie proxy restart' },
  send_failed: { label: 'sending to analytics failed on this machine' },
  classification_unreachable: { label: 'waiting for the CodeMie server to respond' },
  classification_unsupported: { label: "the CodeMie server isn't set up to accept this data yet — contact your CodeMie administrator" },
};

const UNKNOWN: DeliveryHealth = { status: 'unknown', pendingBytes: 0 };

/**
 * The cached classification-policy state for the active profile's namespace, read from the on-disk
 * stored credential — never the daemon's live one. Run through `withVerifiedOwner`, the same owner
 * lookup the daemon's own tick applies before it writes the policy cache (`otlp.plugin.ts`'s
 * `tick`), so a login with no `codemie_access_token` claim (oauth2-proxy) resolves to the same
 * namespace key the daemon actually cached under, instead of always falling back to an unresolved
 * state. `withVerifiedOwner` may probe the backend once and then cache the result on disk, bounded
 * by its own timeout and failure cooldown. `null` is the safe fallback whenever no NamespaceId can
 * be resolved (or the read fails), so an unresolved identity can never produce a false
 * `classification_unreachable`/`classification_unsupported` (spec AC3) — only a genuinely resolved
 * `PolicyState` ever drives a reason. Never throws, for the same reason: a credential-read failure
 * here must not blank out the other signals `collectDeliveryHealth` already computed.
 */
async function resolvePolicyState(state: DaemonState): Promise<PolicyState | null> {
  try {
    const stored = await getStoredAnalyticsCredentials(state.syncCodeMieUrl, {}, {
      provider: state.provider,
      baseUrl: state.targetUrl,
    });
    if (!stored) return null;
    const identity = forwarderIdentity(await withVerifiedOwner(stored.credentials));
    if (!identity) return null;
    return await getPolicyState({ ...identity, profile: state.profile });
  } catch (error) {
    logger.debug('[delivery-health] Could not resolve analytics capability:', error);
    return null;
  }
}

/**
 * Whether analytics reach CodeMie, judged from the daemon's `/health` reply, the auth marker and the
 * OTLP spool. Makes no request; the auth marker is matched against the daemon's recorded profile,
 * never the calling process's. Never throws: any failure reads as `unknown`.
 */
export async function collectDeliveryHealth(
  state: DaemonState,
  reply?: AnalyticsHealthReply
): Promise<DeliveryHealth> {
  try {
    const source = getAnalyticsPlatformSource(
      state.syncCodeMieUrl,
      {},
      { provider: state.provider, baseUrl: state.targetUrl }
    );
    // The spool scan touches different data than capability resolution (credential read, possibly
    // an owner-verification probe), so all three run concurrently instead of the scan waiting on it.
    const [marker, policyState, spool] = await Promise.all([
      applicableAuthMarker(source, [state.targetUrl, state.syncApiUrl, getPlatformUrl(source)]),
      resolvePolicyState(state),
      summarizeSpoolDelivery(),
    ]);

    const reason: DeliveryReason | undefined =
      reply?.credentials === 'stale' ? 'credentials_expired'
      : marker ? 'auth_rejected'
      : spool.mismatchHeld ? 'identity_mismatch'
      : spool.sendFailed ? 'send_failed'
      // Capability is a single resolved value, so at most one of these three ever applies. `evidence`
      // means the backend answered with a usable policy but one that still does not advertise the
      // negotiated publication contract — a stalled session under it is just as stuck as under
      // `legacy`, it just means "answered, but still missing the capability" rather than "never answered".
      : spool.classificationStalled && policyState?.capability === 'unknown' ? 'classification_unreachable'
      : spool.classificationStalled && policyState?.capability === 'legacy' ? 'classification_unsupported'
      : spool.classificationStalled && policyState?.capability === 'evidence' && !advertisesContract(policyState) ? 'classification_unsupported'
      : undefined;

    if (reason) {
      return { status: 'unhealthy', reason, pendingBytes: spool.pendingBytes };
    }
    return { status: reply?.credentials === 'ok' ? 'healthy' : 'unknown', pendingBytes: spool.pendingBytes };
  } catch (error) {
    logger.debug('[delivery-health] Could not collect delivery health:', error);
    return UNKNOWN;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * The shared `Delivery:` headline with its indented `Pending:` and `Run:` details. `null` means the
 * proxy is not running, so there is nothing to detail.
 */
export function formatDeliveryLines(health: DeliveryHealth | null): string[] {
  if (!health) {
    return [`Delivery: ${chalk.dim('proxy not running')}`];
  }

  const lines: string[] = [];
  let run: string | undefined;
  if (health.status === 'healthy') {
    lines.push(`Delivery: ${chalk.green('healthy')}`);
  } else if (health.status === 'unhealthy') {
    const entry = health.reason ? DELIVERY_REASONS[health.reason] : undefined;
    lines.push(`Delivery: ${chalk.yellow(`unhealthy${entry ? ` (${entry.label})` : ''}`)}`);
    run = entry?.run;
  } else {
    lines.push(`Delivery: ${chalk.dim('unknown (restart the proxy to enable all checks)')}`);
  }

  if (health.pendingBytes > 0) {
    lines.push(`  Pending: ${formatBytes(health.pendingBytes)} (all sessions on this machine)`);
  }
  if (run) {
    lines.push(`  Run: ${run}`);
  }
  return lines;
}
