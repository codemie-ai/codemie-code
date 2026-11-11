import chalk from 'chalk';
import { getAnalyticsPlatformSource, getPlatformUrl, getStoredAnalyticsCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { withVerifiedOwner } from '@/providers/core/credential-owner.js';
import { applicableAuthMarker } from '@/providers/plugins/sso/sso.auth-gate.js';
import { summarizeSpoolDelivery, type LatestDrop, type SendFailure } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import { forwarderIdentity } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { getPolicyState, type Capability } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { logger } from '@/utils/logger.js';
import type { DaemonState } from './daemon-manager.js';
import { formatReportRows, type ReportRow } from './analytics-report.js';

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
  /** Unsent bytes across all sessions; absent when the spool could not be read, which is not the same as none. */
  pendingBytes?: number;
  /** The spool could not be read completely and no failure was found in what was read, so delivery cannot be judged. */
  incomplete?: true;
  /** When the next send is due and why the last one failed; set only when `reason` is `send_failed`. */
  sendFailure?: SendFailure;
  /** The newest drop the spool records; informational, it never changes `status`. */
  latestDrop?: LatestDrop;
}

/**
 * Label and remedy per reason; keyed by `Record` so a new code without a label fails to compile.
 * `identity_mismatch`, `send_failed`, `classification_unreachable` and `classification_unsupported`
 * come from the spool, which is shared by the whole machine, so their labels say so. Neither
 * `classification_unreachable` nor `classification_unsupported` has a `run`: there is nothing the
 * CLI can do locally — the first may clear on its own, the second needs the backend upgraded.
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
  classification_unreachable: { label: 'analytics backend has never answered for a pending session on this machine' },
  classification_unsupported: { label: 'analytics backend does not support classification for a pending session on this machine; it will be discarded' },
};

const UNKNOWN: DeliveryHealth = { status: 'unknown' };

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
    // The spool scan touches different data than capability resolution (credential read, possibly
    // an owner-verification probe), so all three run concurrently instead of the scan waiting on it.
    const [marker, capability, spool] = await Promise.all([
      applicableAuthMarker(source, [state.targetUrl, state.syncApiUrl, getPlatformUrl(source)]),
      resolveCapability(state),
      summarizeSpoolDelivery(),
    ]);

    const reason: DeliveryReason | undefined =
      reply?.credentials === 'stale' ? 'credentials_expired'
      : marker ? 'auth_rejected'
      : spool.mismatchHeld ? 'identity_mismatch'
      : spool.sendFailure ? 'send_failed'
      // Capability is a single resolved value, so at most one of these two ever applies.
      : spool.classificationStalled && capability === 'unknown' ? 'classification_unreachable'
      : spool.classificationStalled && capability === 'legacy' ? 'classification_unsupported'
      : undefined;

    const drop = spool.latestDrop ? { latestDrop: spool.latestDrop } : {};
    const pending = spool.incomplete ? {} : { pendingBytes: spool.pendingBytes };
    if (reason) {
      const failure = reason === 'send_failed' && spool.sendFailure ? { sendFailure: spool.sendFailure } : {};
      return { status: 'unhealthy', reason, ...pending, ...failure, ...drop };
    }
    if (spool.incomplete) {
      return { status: 'unknown', incomplete: true, ...drop };
    }
    return { status: reply?.credentials === 'ok' ? 'healthy' : 'unknown', ...pending, ...drop };
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

/** An ISO time; a time read from a status file outside the date range is printed as stored, not thrown on. */
function formatTime(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? String(ms) : at.toISOString();
}

/** The `Last dropped:` row of the newest recorded drop, with the remedy of a session without a project. */
export function describeDrop(drop: LatestDrop | undefined): ReportRow | undefined {
  if (!drop) return undefined;
  const where = drop.stream ? `${drop.stream}, ` : '';
  return {
    message: `Last dropped: ${drop.reason} (${where}${formatTime(drop.at)})`,
    ...(drop.reason === 'no_project'
      ? { hint: 'Run: set a CodeMie project for the folder (codemie setup) — sessions without a project are not sent' }
      : {}),
  };
}

/** The drop as indented lines for `proxy status`: the message, then the remedy when there is one. */
export function formatDropLines(drop: LatestDrop | undefined): string[] {
  const row = describeDrop(drop);
  return row ? [`  ${row.message}`, ...(row.hint ? [`  ${row.hint}`] : [])] : [];
}

/** The `Delivery:` row; only the status text is colored: green when healthy, yellow otherwise. */
function deliveryRow(health: DeliveryHealth): ReportRow {
  if (health.status === 'healthy') {
    return { message: `Delivery: ${chalk.green('healthy')}` };
  }
  if (health.status === 'unhealthy') {
    const entry = health.reason ? DELIVERY_REASONS[health.reason] : undefined;
    return {
      message: `Delivery: ${chalk.yellow(`unhealthy${entry ? ` (${entry.label})` : ''}`)}`,
      ...(entry?.run ? { hint: `Run: ${entry.run}` } : {}),
    };
  }
  return { message: `Delivery: ${chalk.yellow(`unknown (${unknownHint(health)})`)}` };
}

/** Why delivery cannot be judged: an unreadable spool is not fixed by a restart, a missing health reply is. */
export function unknownHint(health: DeliveryHealth): string {
  return health.incomplete ? 'the spool could not be read' : 'restart the proxy to enable all checks';
}

/** An amount that could not be read is `unknown`, never `none`. */
function unsentDataMessage(pendingBytes: number | undefined): string {
  if (pendingBytes === undefined) return 'Unsent data: unknown';
  return pendingBytes > 0
    ? `Unsent data: ${formatBytes(pendingBytes)} (all sessions on this machine)`
    : 'Unsent data: none';
}

/** The error code of a failed send; no HTTP response at all reads as the backend being unreachable. */
function describeError(detail: string): string {
  return detail === 'request_error' ? 'backend unreachable' : detail;
}

/**
 * The rows above the connector section of `proxy analytics status`, with no heading: Delivery and Unsent
 * data as separate rows, the next retry and error code of a failing send, and the newest drop. `null`
 * means the proxy is not running, so there is nothing else to show.
 */
export function formatDeliveryLines(health: DeliveryHealth | null): string[] {
  if (!health) {
    return formatReportRows([{ message: `Delivery: ${chalk.yellow('proxy not running')}` }]);
  }

  const rows: ReportRow[] = [
    deliveryRow(health),
    { message: unsentDataMessage(health.pendingBytes) },
  ];
  if (health.sendFailure) {
    rows.push({ message: `Next retry: ${formatTime(health.sendFailure.nextAt)}` });
    if (health.sendFailure.detail) {
      rows.push({ message: `Error: ${describeError(health.sendFailure.detail)}` });
    }
  }
  const drop = describeDrop(health.latestDrop);
  if (drop) {
    rows.push(drop);
  }
  return formatReportRows(rows);
}
