import chalk from 'chalk';
import { getAnalyticsPlatformSource, getPlatformUrl } from '@/providers/core/codemie-auth-helpers.js';
import { applicableAuthMarker } from '@/providers/plugins/sso/sso.auth-gate.js';
import { summarizeSpoolDelivery, type LatestDrop } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { logger } from '@/utils/logger.js';
import type { DaemonState } from './daemon-manager.js';

export type DeliveryReason = 'credentials_expired' | 'auth_rejected' | 'identity_mismatch' | 'send_failed';

export interface DeliveryHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  reason?: DeliveryReason;
  pendingBytes: number;
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

const UNKNOWN: DeliveryHealth = { status: 'unknown', pendingBytes: 0 };

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
      : spool.sendFailed ? 'send_failed'
      : undefined;

    const drop = spool.latestDrop ? { latestDrop: spool.latestDrop } : {};
    if (reason) {
      return { status: 'unhealthy', reason, pendingBytes: spool.pendingBytes, ...drop };
    }
    return { status: reply?.credentials === 'ok' ? 'healthy' : 'unknown', pendingBytes: spool.pendingBytes, ...drop };
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

/** The `Last dropped:` detail of the newest recorded drop, with the remedy of a session without a project. */
export function formatDropLines(drop: LatestDrop | undefined): string[] {
  if (!drop) return [];
  const where = drop.stream ? `${drop.stream}, ` : '';
  // The time is read from a status file: one outside the date range is printed as stored, not thrown on.
  const at = new Date(drop.at);
  const when = Number.isNaN(at.getTime()) ? String(drop.at) : at.toISOString();
  const lines = [`  Last dropped: ${drop.reason} (${where}${when})`];
  if (drop.reason === 'no_project') {
    lines.push('  Run: set a CodeMie project for the folder (codemie setup) — sessions without a project are not sent');
  }
  return lines;
}

/**
 * The shared `Delivery:` headline with its indented `Pending:`, `Run:` and `Last dropped:` details.
 * `null` means the proxy is not running, so there is nothing to detail.
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
  lines.push(...formatDropLines(health.latestDrop));
  return lines;
}
