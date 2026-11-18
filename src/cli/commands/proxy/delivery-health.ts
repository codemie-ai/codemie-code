import chalk from 'chalk';
import { getAnalyticsPlatformSource, getPlatformUrl, getStoredAnalyticsCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { withVerifiedOwner } from '@/providers/core/credential-owner.js';
import { ORG_ENCODING_V1 } from '@/agents/core/evidence/org-encoding.js';
import { applicableAuthMarker } from '@/providers/plugins/sso/sso.auth-gate.js';
import { summarizeSpoolDelivery, type LatestDrop, type SendFailure } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import { forwarderIdentity } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { advertisesContract, getPolicyState, type PolicyState } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { logger } from '@/utils/logger.js';
import type { DaemonState } from './daemon-manager.js';
import { formatReportRows, type ReportRow } from './analytics-report.js';
import { renderHint } from '@/utils/hint.js';

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
  /** The part of `pendingBytes` held in sessions that are not sent for now; absent when none, or when `pendingBytes` is. */
  heldBytes?: number;
  /** The spool could not be read completely and no failure was found in what was read, so delivery cannot be judged. */
  incomplete?: true;
  /** When the next send is due and why the last one failed; set only when `reason` is `send_failed`. */
  sendFailure?: SendFailure;
  /** The newest drop the spool records; informational, it never changes `status`. */
  latestDrop?: LatestDrop;
}

/**
 * Label and remedy per reason; keyed by `Record` so a new code without a label fails to compile.
 * Every label is written for a non-technical reader, and calls the service "CodeMie". Only
 * `identity_mismatch` states its machine-wide scope in the label, because it comes from the spool,
 * which is shared by the whole machine; the `Unsent data` row states that scope for the rest.
 * `send_failed`, `classification_unreachable` and `classification_unsupported` have no `run`: there is
 * nothing the CLI can do locally — the first two clear on their own once CodeMie responds, the last
 * needs a CodeMie administrator to enable the feature on the backend.
 *
 * Known limitation: `classification_unreachable`/`classification_unsupported` read the active
 * profile's capability against every session in the shared spool (see `SpoolDeliverySummary`'s
 * docstring) — a session still pending from a profile the user has since switched away from is
 * judged by the wrong capability until it drains or is lost to retention.
 */
export const DELIVERY_REASONS: Record<DeliveryReason, { label: string; command?: string }> = {
  credentials_expired: { label: 'CodeMie sign-in has expired', command: 'codemie profile login' },
  auth_rejected: { label: 'CodeMie asked you to sign in again', command: 'codemie profile login' },
  identity_mismatch: {
    label: "analytics destination doesn't match your signed-in account — affects all sessions on this computer",
    command: 'codemie proxy restart',
  },
  send_failed: { label: 'last send to CodeMie failed, retrying' },
  classification_unreachable: { label: 'waiting for CodeMie to respond' },
  classification_unsupported: { label: "CodeMie isn't set up to accept this data yet — contact your CodeMie administrator" },
};

const UNKNOWN: DeliveryHealth = { status: 'unknown' };

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
 * OTLP spool. Sends no analytics request. For a login without an owner claim, resolving the namespace
 * may make one bounded `GET /v1/user` (5 s timeout, then cached per login) and write the owner record,
 * as the daemon's tick does. The auth marker is matched against the daemon's recorded profile,
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
      : spool.sendFailure ? 'send_failed'
      // Capability is a single resolved value, so at most one of the capability branches ever applies.
      // `evidence` means the backend answered with a usable policy but one that still does not advertise
      // the negotiated publication contract — a stalled session under it is just as stuck as under
      // `legacy`, it just means "answered, but still missing the capability" rather than "never answered".
      // A contract stall clears once the contract is advertised, so an advertising backend stays quiet; an
      // organization-encoding stall does not, so it is judged by the encodings the last policy advertised,
      // which stay readable after the policy expires: an expired cache is an outage, not a missing encoding.
      : spool.classificationStalled && policyState?.capability === 'unknown' ? 'classification_unreachable'
      : spool.classificationStalled && policyState?.capability === 'legacy' ? 'classification_unsupported'
      : spool.classificationStalled && policyState?.capability === 'evidence' && !advertisesContract(policyState) ? 'classification_unsupported'
      : spool.organizationEncodingStalled && policyState?.capability === 'evidence' && !policyState.organizationEncodings?.includes(ORG_ENCODING_V1)
        ? 'classification_unsupported'
      : undefined;

    const drop = spool.latestDrop ? { latestDrop: spool.latestDrop } : {};
    const pending = spool.incomplete ? {} : { pendingBytes: spool.pendingBytes, ...(spool.heldBytes ? { heldBytes: spool.heldBytes } : {}) };
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

/**
 * A time in the user's time zone as `YYYY-MM-DD HH:mm:ss +HH:MM` (the offset in force at that moment); a time read
 * from a status file outside the date range is printed as stored, not thrown on.
 */
function formatTime(ms: number): string {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return String(ms);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const offset = `${sign}${pad(Math.trunc(Math.abs(offsetMinutes) / 60))}:${pad(Math.trunc(Math.abs(offsetMinutes) % 60))}`;
  const date = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return `${date} ${time} ${offset}`;
}

/** The `Last dropped:` row of the newest recorded drop, with the remedy of a session without a project. */
export function describeDrop(drop: LatestDrop | undefined): ReportRow | undefined {
  if (!drop) return undefined;
  const where = drop.stream ? `${drop.stream}, ` : '';
  return {
    message: `Last dropped: ${drop.reason} (${where}${formatTime(drop.at)})`,
    ...(drop.reason === 'no_project'
      ? { hint: renderHint({ reason: 'Sessions without a project are not sent', action: 'set a CodeMie project for the folder (codemie setup)' }) }
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
      ...(entry?.command ? { hint: renderHint({ reason: entry.label, command: entry.command }) } : {}),
    };
  }
  return { message: `Delivery: ${chalk.yellow(`unknown (${unknownHint(health)})`)}` };
}

/** Why delivery cannot be judged: an unreadable spool is not fixed by a restart, a missing health reply is. */
export function unknownHint(health: DeliveryHealth): string {
  return health.incomplete ? 'local analytics data could not be read' : 'restart the proxy to enable all checks';
}

/** An amount that could not be read is `unknown`, never `none`. The part held in sessions that are not sent for now is named after it. */
function unsentDataMessage(pendingBytes: number | undefined, heldBytes?: number): string {
  if (pendingBytes === undefined) return 'Unsent data: unknown';
  if (pendingBytes <= 0) return 'Unsent data: none';
  const held = heldBytes ? `, ${formatBytes(heldBytes)} of it on hold` : '';
  return `Unsent data: ${formatBytes(pendingBytes)} (all sessions on this machine)${held}`;
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
    { message: unsentDataMessage(health.pendingBytes, health.heldBytes) },
  ];
  if (health.sendFailure) {
    // The daemon retries on its next tick, so a time that has come reads as due, never as a past date.
    const { nextAt } = health.sendFailure;
    rows.push({ message: `Next retry: ${nextAt <= Date.now() ? 'due now' : formatTime(nextAt)}` });
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
