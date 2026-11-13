import chalk from 'chalk';
import { getAnalyticsPlatformSource, getPlatformUrl } from '@/providers/core/codemie-auth-helpers.js';
import { applicableAuthMarker } from '@/providers/plugins/sso/sso.auth-gate.js';
import { summarizeSpoolDelivery, type LatestDrop, type SendFailure } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { logger } from '@/utils/logger.js';
import type { DaemonState } from './daemon-manager.js';
import { formatReportRows, type ReportRow } from './analytics-report.js';

export type DeliveryReason = 'credentials_expired' | 'auth_rejected' | 'identity_mismatch' | 'send_failed';

export interface DeliveryHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  reason?: DeliveryReason;
  /** Unsent bytes across all sessions; absent when the spool could not be read, which is not the same as none. */
  pendingBytes?: number;
  /** When the next send is due and why the last one failed; set only when `reason` is `send_failed`. */
  sendFailure?: SendFailure;
  /** The newest drop the spool records; informational, it never changes `status`. */
  latestDrop?: LatestDrop;
}

/**
 * Label and remedy per reason; keyed by `Record` so a new code without a label fails to compile.
 * `identity_mismatch` and `send_failed` come from the spool, which is shared by the whole machine,
 * so their labels say so.
 */
export const DELIVERY_REASONS: Record<DeliveryReason, { label: string; run?: string }> = {
  credentials_expired: { label: 'credentials expired', run: 'codemie profile login' },
  auth_rejected: { label: 'analytics auth rejected', run: 'codemie profile login' },
  identity_mismatch: { label: 'analytics identity mismatch on this machine', run: 'codemie proxy restart' },
  send_failed: { label: 'sending to analytics failed on this machine' },
};

const UNKNOWN: DeliveryHealth = { status: 'unknown' };

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
    const [marker, spool] = await Promise.all([
      applicableAuthMarker(source, [state.targetUrl, state.syncApiUrl, getPlatformUrl(source)]),
      summarizeSpoolDelivery(),
    ]);

    const reason: DeliveryReason | undefined =
      reply?.credentials === 'stale' ? 'credentials_expired'
      : marker ? 'auth_rejected'
      : spool.mismatchHeld ? 'identity_mismatch'
      : spool.sendFailure ? 'send_failed'
      : undefined;

    const drop = spool.latestDrop ? { latestDrop: spool.latestDrop } : {};
    const pending = spool.incomplete ? {} : { pendingBytes: spool.pendingBytes };
    if (reason) {
      const failure = reason === 'send_failed' && spool.sendFailure ? { sendFailure: spool.sendFailure } : {};
      return { status: 'unhealthy', reason, ...pending, ...failure, ...drop };
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
  return { message: `Delivery: ${chalk.yellow('unknown (restart the proxy to enable all checks)')}` };
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
