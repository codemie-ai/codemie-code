import chalk from 'chalk';
import { getAnalyticsPlatformSource, getPlatformUrl, getStoredAnalyticsCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { withVerifiedOwner } from '@/providers/core/credential-owner.js';
import { applicableAuthMarker } from '@/providers/plugins/sso/sso.auth-gate.js';
import { summarizeSpoolDelivery } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import { forwarderIdentity } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { getPolicyState, type Capability } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { logger } from '@/utils/logger.js';
import type { DaemonState } from './daemon-manager.js';

export type DeliveryReason =
  | 'credentials_expired'
  | 'auth_rejected'
  | 'identity_mismatch'
  | 'send_failed'
  | 'classification_unreachable';

export interface DeliveryHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  reason?: DeliveryReason;
  pendingBytes: number;
}

/**
 * Label and remedy per reason; keyed by `Record` so a new code without a label fails to compile.
 * `identity_mismatch`, `send_failed` and `classification_unreachable` come from the spool, which is
 * shared by the whole machine, so their labels say so.
 */
export const DELIVERY_REASONS: Record<DeliveryReason, { label: string; run?: string }> = {
  credentials_expired: { label: 'credentials expired', run: 'codemie profile login' },
  auth_rejected: { label: 'analytics auth rejected', run: 'codemie profile login' },
  identity_mismatch: { label: 'analytics identity mismatch on this machine', run: 'codemie proxy restart' },
  send_failed: { label: 'sending to analytics failed on this machine' },
  classification_unreachable: { label: 'analytics backend has never answered for a pending session on this machine' },
};

const UNKNOWN: DeliveryHealth = { status: 'unknown', pendingBytes: 0 };

/**
 * The backend capability for the active profile's namespace, read from the on-disk stored
 * credential — never the daemon's live one. Run through `withVerifiedOwner`, the same owner
 * lookup the daemon's own tick applies before it writes the policy cache (`otlp.plugin.ts`'s
 * `tick`), so a login with no `codemie_access_token` claim (oauth2-proxy) resolves to the same
 * namespace key the daemon actually cached under, instead of always falling back to `'evidence'`.
 * `withVerifiedOwner` may probe the backend once and then cache the result on disk, bounded by
 * its own timeout and failure cooldown. `'evidence'` is also the safe fallback whenever no
 * NamespaceId can be resolved, so an unresolved identity can never produce a false
 * `classification_unreachable` (spec AC3). Never throws, for the same reason: a credential-read
 * failure here must not blank out the other signals `collectDeliveryHealth` already computed.
 */
async function resolveCapability(state: DaemonState): Promise<Capability> {
  try {
    const stored = await getStoredAnalyticsCredentials(state.syncCodeMieUrl, {}, {
      provider: state.provider,
      baseUrl: state.targetUrl,
    });
    if (!stored) return 'evidence';
    const identity = forwarderIdentity(await withVerifiedOwner(stored.credentials));
    if (!identity) return 'evidence';
    const policy = await getPolicyState({ ...identity, profile: state.profile });
    return policy.capability;
  } catch (error) {
    logger.debug('[delivery-health] Could not resolve analytics capability:', error);
    return 'evidence';
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
    const [marker, capability] = await Promise.all([
      applicableAuthMarker(source, [state.targetUrl, state.syncApiUrl, getPlatformUrl(source)]),
      resolveCapability(state),
    ]);
    const spool = await summarizeSpoolDelivery(capability);

    const reason: DeliveryReason | undefined =
      reply?.credentials === 'stale' ? 'credentials_expired'
      : marker ? 'auth_rejected'
      : spool.mismatchHeld ? 'identity_mismatch'
      : spool.sendFailed ? 'send_failed'
      : spool.classificationUnreachable ? 'classification_unreachable'
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
