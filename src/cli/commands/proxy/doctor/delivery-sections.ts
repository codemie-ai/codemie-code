/**
 * The analytics delivery sections of `proxy doctor`: the verdict with its fix hint, then the facts behind it —
 * unsent data, the next retry of a failing send and the newest recorded drop with its remedy.
 */
import { renderHint } from '@/utils/hint.js';
import type { LatestDrop } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import type { DaemonState } from '../daemon-manager.js';
import { collectDeliveryHealth, DELIVERY_REASONS, unknownHint, type DeliveryHealth } from '../delivery-health.js';
import { DOCTOR_COMMAND, type Sections } from './sections.js';

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

/** A session hold reason a user can act on: what is held and the command that releases it. */
export interface HoldReasonEntry {
  text: string;
  fix: string;
}

/** Hold reasons with a remedy, keyed by the session hold reason; a held reason missing here is listed as `On hold` with its size and no `Fix`. */
export const HOLD_REASONS: Record<string, HoldReasonEntry> = {
  work_consent_required: {
    text: 'personal Claude subscription sessions need work consent',
    fix: 'codemie proxy analytics consent grant, then codemie proxy analytics resend (run in this repository, or add --all to grant for every repository)',
  },
};

/** The indent of a hint under its line in `HealthCheckFormatter.printDetail`; the hint mechanism carries one line only. */
const HOLD_LINE_INDENT = '      ';

/**
 * An amount that could not be read is `unknown`, never `none`. The part held in sessions not sent for now is named after
 * it, followed by an `On hold` / `Fix` pair for each held reason that has a remedy, indented like a hint.
 */
function unsentDataMessage(pendingBytes: number | undefined, heldBytes?: number, heldByReason?: Record<string, number>): string {
  if (pendingBytes === undefined) return 'Unsent data: unknown';
  if (pendingBytes <= 0) return 'Unsent data: none';
  const held = heldBytes ? `, ${formatBytes(heldBytes)} of it on hold` : '';
  const heldReasons = Object.entries(heldByReason ?? {}).filter(([, bytes]) => bytes > 0);
  const remedied = Object.entries(HOLD_REASONS)
    .filter(([reason]) => heldReasons.some(([held]) => held === reason))
    .flatMap(([, entry]) => [`${HOLD_LINE_INDENT}On hold: ${entry.text}`, `${HOLD_LINE_INDENT}Fix: ${entry.fix}`]);
  const unexplained = heldReasons
    .filter(([reason]) => !(reason in HOLD_REASONS))
    .map(([reason, bytes]) => `${HOLD_LINE_INDENT}On hold: ${reason.replace(/_/g, ' ')} (${formatBytes(bytes)})`);
  const blocks = [...remedied, ...unexplained];
  return [`Unsent data: ${formatBytes(pendingBytes)} (all sessions on this machine)${held}`, ...blocks].join('\n');
}

/** The error code of a failed send; no HTTP response at all reads as the backend being unreachable. */
function describeError(detail: string): string {
  return detail === 'request_error' ? 'backend unreachable' : detail;
}

function dropHint(reason: string): string | undefined {
  if (reason === 'no_project') {
    return renderHint({ reason: 'sessions without a CodeMie project are not sent; set one for the folder', command: 'codemie setup' });
  }
  if (reason === 'project_conflict_discard') {
    return renderHint({ reason: 'the session used folders that belong to different CodeMie projects; part of its data was not sent' });
  }
  return undefined;
}

function dropSection(drop: LatestDrop): Sections[number] {
  const where = drop.stream ? `${drop.stream}, ` : '';
  const hint = dropHint(drop.reason);
  return {
    id: 'delivery',
    status: 'info',
    message: `Last dropped: ${drop.reason} (${where}${formatTime(drop.at)})`,
    ...(hint !== undefined && { hint }),
  };
}

/** The facts under the verdict: unsent data, the next retry and its error, the newest drop. */
function deliveryDetails(health: DeliveryHealth): Sections {
  const details: Sections = [];
  if (!health.incomplete) {
    details.push({ id: 'delivery', status: 'info', message: unsentDataMessage(health.pendingBytes, health.heldBytes, health.heldByReason) });
  }
  if (health.sendFailure) {
    // The daemon retries on its next tick, so a time that has come reads as due, never as a past date.
    const { nextAt, detail } = health.sendFailure;
    const when = nextAt <= Date.now() ? 'due now' : formatTime(nextAt);
    details.push({ id: 'delivery', status: 'info', message: `Next retry: ${when}${detail ? ` (${describeError(detail)})` : ''}` });
  }
  if (health.latestDrop) details.push(dropSection(health.latestDrop));
  return details;
}

function verdict(health: DeliveryHealth): Sections[number] {
  if (health.status === 'healthy') {
    return { id: 'delivery', status: 'ok', message: 'Analytics delivery: healthy' };
  }
  if (health.status === 'unhealthy') {
    const entry = health.reason ? DELIVERY_REASONS[health.reason] : undefined;
    return {
      id: 'delivery',
      status: entry?.command ? 'error' : 'warn',
      message: `Analytics delivery: unhealthy${entry ? ` (${entry.label})` : ''}`,
      // Without a local fix the state clears on CodeMie's side: the hint is to check again.
      hint: entry?.command
        ? renderHint({ reason: entry.label, command: entry.command })
        : renderHint({ reason: 'it clears once CodeMie accepts the data; check again later', command: DOCTOR_COMMAND }),
    };
  }
  return { id: 'delivery', status: 'info', message: `Analytics delivery: unknown (${unknownHint(health)})` };
}

export async function deliverySections(state: DaemonState, reply: AnalyticsHealthReply | undefined): Promise<Sections> {
  const health = await collectDeliveryHealth(state, reply);
  return [verdict(health), ...deliveryDetails(health)];
}
