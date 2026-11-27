/**
 * Sync runner for `codemie analytics sync run` — multi-target, unattended.
 *
 * Ties together settings, identity, the daily window, the in-process report builder and
 * target delivery (webhook and/or git) into one run. Every side effect (clock, settings,
 * identity, marker, fs, delivery, output) is injected via {@link SyncDeps} so tests run
 * without network or real files.
 *
 * `runSync` resolves identity once, then loops over the targets configured in `settings`
 * (webhook, then git, in that order — whichever of `webhookUrl`/`git` is present). Each
 * target gets its own marker-derived window, its own `exportSource.build` call, its own delivery
 * attempt of every built file and its own marker move, so one target's failure never blocks or rolls back
 * another's delivery (AC7/AC8).
 *
 * `runSync` never throws and never calls `process.exit`. Every outcome for a target —
 * success, a skipped empty window, or a failure — prints and appends exactly one line via
 * {@link formatLogLine}:
 *   `<ISO> ok sent <name> <bytes> target=<id>` (one file), `<ISO> ok sent <n> files <total bytes> target=<id>`
 *   `<ISO> skip <reason> target=<id>`
 *   `<ISO> fail <setup|export|send> <redacted detail> target=<id>`
 * An `ok sent` line may carry ` (warning: <what>)` once or twice before ` target=<id>`: the build's `warning` (a part
 * of the run not built for a reason that may pass), then its `leftOut` (sessions no run can build), then the marker's
 * own warning. A `skip` line carries the `leftOut` note alone: a build with no file and a `warning` is a `fail export`
 * line with that warning's text.
 * A setup failure resolved before any target is chosen (no settings file, no configured
 * target, no resolvable identity) carries no ` target=<id>` suffix and counts for every
 * target in `status`; a target whose own marker cannot be read fails `setup` with its
 * suffix and the remaining targets still run. Exit code is 1 if any
 * target failed (or the run failed in setup), 0 otherwise. Category mapping per target:
 * a report-build failure -> `export`; a webhook delivery failure -> `export` when it is an
 * `ExportTooLargeError` (its message carries the byte count), else `send`; a git delivery
 * failure is always `send`, with its detail carrying {@link gitHint}. The marker for a
 * target only moves (to the run's `now()`) after a delivery whose files carry no `warning` — a `leftOut` alone does not
 * hold it; a `skip` and a `fail` move nothing. A marker write that fails after delivery keeps the `ok sent` outcome
 * (exit 0 for that target) with a warning suffix; a run-log append that fails is ignored.
 */
import { appendFile, chmod, mkdir } from 'fs/promises';
import { dirname } from 'path';

import { getCodemiePath } from '@/utils/paths.js';
import { ExportTooLargeError, SyncGitError, SyncTargetMissingError } from '@/utils/errors.js';

import { DEFAULT_LOOKBACK_DAYS, loadSyncSettings } from './config-store.js';
import { realIdentityDeps, resolveSyncIdentity } from './identity.js';
import { readMarker, writeMarker } from './marker.js';
import { includeExternalFor } from './policy.js';
import { errorMessage, redactSecrets } from './redact.js';
import { createGitRunner, gitHint } from './targets/git-client.js';
import { GitTarget, gitMarkerPath } from './targets/git-target.js';
import { sendWebhook } from './targets/webhook-target.js';
import type { ExportSource, SyncFiles, SyncReport, SyncSettings } from './types.js';
import type { AnalyticsCollection } from '../../shared/analytics-collection/types.js';
import { dailyWindow } from './window.js';

/** A `codemie analytics sync` delivery target. */
export type TargetId = 'webhook' | 'git';

/** Every side effect `runSync` needs, injected so tests run without network or real files. */
export interface SyncDeps {
  now(): Date;
  loadSettings(): Promise<SyncSettings | null>;
  resolveIdentity(): Promise<string>;
  /** Builds the files one target gets for its window. */
  exportSource: ExportSource;
  deliver(target: TargetId, settings: SyncSettings, email: string, reports: SyncReport[]): Promise<void>;
  readMarker(target: TargetId, now: Date): Promise<Date | null>;
  writeMarker(target: TargetId, at: Date): Promise<void>;
  appendLog(line: string): Promise<void>;
  print(line: string): void;
  platform: NodeJS.Platform;
}

type Outcome = 'ok' | 'skip' | 'fail';

/** Format one log/print line: `<ISO> <outcome> <rest>`, with a trailing ` target=<id>` when
 * `target` is given, and any secret redacted. Line breaks in `rest` (multi-line git stderr)
 * are collapsed to ` | `, so every outcome is exactly one physical line and its
 * ` target=<id>` suffix stays on the line `status` parses. */
export function formatLogLine(at: Date, outcome: Outcome, rest: string, target?: TargetId): string {
  const suffix = target === undefined ? '' : ` target=${target}`;
  const singleLine = rest.trim().replace(/\s*[\r\n]+\s*/g, ' | ');
  return redactSecrets(`${at.toISOString()} ${outcome} ${singleLine}${suffix}`);
}

async function emit(
  deps: SyncDeps,
  now: Date,
  outcome: Outcome,
  rest: string,
  target?: TargetId
): Promise<void> {
  const line = formatLogLine(now, outcome, rest, target);
  deps.print(line);
  // Best-effort: an unwritable log (permissions, full disk) must not turn the run into a
  // rejection — the printed line still carries the outcome and the exit code is unchanged.
  await deps.appendLog(line).catch(() => undefined);
}

/** Move `target`'s marker after a delivered report. A failure here does not undo the
 * delivery, so it becomes a warning on the `ok sent` line (the next run re-sends this
 * window) rather than a `fail setup`. Returns that warning suffix, or `''` when the marker
 * was saved. */
async function moveMarker(deps: SyncDeps, target: TargetId, now: Date): Promise<string> {
  try {
    await deps.writeMarker(target, now);
    return '';
  } catch (err) {
    return ` (warning: last-sent marker not saved, the next run re-sends this window: ${errorMessage(err)})`;
  }
}

/** The targets `settings` configures, in delivery order (webhook, then git). */
function configuredTargets(settings: SyncSettings): TargetId[] {
  const targets: TargetId[] = [];
  if (settings.webhookUrl !== undefined) {
    targets.push('webhook');
  }
  if (settings.git !== undefined) {
    targets.push('git');
  }
  return targets;
}

/** Run one target end to end: its own window, report build, delivery and marker move, each
 * resulting in exactly one `emit`. Returns whether the target failed. */
async function runTarget(
  deps: SyncDeps,
  now: Date,
  settings: SyncSettings,
  email: string,
  includeExternal: boolean,
  lookbackDays: number,
  target: TargetId
): Promise<boolean> {
  // A marker that cannot be read (EACCES, EISDIR) fails this target only: the loop in `run`
  // still attempts the next target, so one target's state never blocks another's delivery.
  let window: ReturnType<typeof dailyWindow>;
  try {
    const lastSent = await deps.readMarker(target, now);
    window = dailyWindow(now, lastSent, lookbackDays);
  } catch (err) {
    await emit(deps, now, 'fail', `setup ${errorMessage(err)}`, target);
    return true;
  }

  let reports: SyncFiles | null;
  try {
    reports = await deps.exportSource.build({ window, email, includeExternal, now });
  } catch (err) {
    await emit(deps, now, 'fail', `export ${errorMessage(err)}`, target);
    return true;
  }

  // Both are named on the line: a `warning` holds the marker, a `leftOut` (sessions no run can build) does not.
  const buildWarning = reports?.warning === undefined ? '' : ` (warning: ${reports.warning})`;
  const leftOutWarning = reports?.leftOut === undefined ? '' : ` (warning: ${reports.leftOut})`;
  // No file and a `warning`: the build failed to make what it had to send.
  if (reports !== null && reports.length === 0 && reports.warning !== undefined) {
    await emit(deps, now, 'fail', `export ${reports.warning}${leftOutWarning}`, target);
    return true;
  }
  if (reports === null || reports.length === 0) {
    await emit(deps, now, 'skip', `no sessions in window ${window.label}${leftOutWarning}`, target);
    return false;
  }

  try {
    await deps.deliver(target, settings, email, reports);
  } catch (err) {
    await emit(deps, now, 'fail', deliveryFailureDetail(target, err), target);
    return true;
  }

  // A run with a `warning` leaves the marker, so the next run covers this window again.
  const markerWarning = reports.warning === undefined ? await moveMarker(deps, target, now) : '';
  const total = reports.reduce((sum, report) => sum + report.bytes.length, 0);
  const sent = reports.length === 1 ? `${reports[0].fileName} ${total}` : `${reports.length} files ${total}`;
  await emit(deps, now, 'ok', `sent ${sent}${buildWarning}${leftOutWarning}${markerWarning}`, target);
  return false;
}

/** `<category> <redacted detail>` for a failed delivery. Webhook keeps its existing
 * `export`/`send` split (an `ExportTooLargeError` means the report itself was too large);
 * a git failure is always `send`, with the likely cause's hint appended. */
function deliveryFailureDetail(target: TargetId, err: unknown): string {
  if (target === 'git') {
    const cause = err instanceof SyncGitError ? err.gitCause : 'other';
    return `send ${errorMessage(err)} — ${gitHint(cause)}`;
  }

  const category = err instanceof ExportTooLargeError ? 'export' : 'send';
  return `${category} ${errorMessage(err)}`;
}

async function run(deps: SyncDeps, now: Date): Promise<number> {
  const settings = await deps.loadSettings();

  if (settings === null) {
    await emit(deps, now, 'fail', `setup ${errorMessage(new SyncTargetMissingError())}`);
    return 1;
  }

  const targets = configuredTargets(settings);
  if (targets.length === 0) {
    await emit(deps, now, 'fail', `setup ${errorMessage(new SyncTargetMissingError())}`);
    return 1;
  }

  // Identity and the include-external policy are preconditions resolved once, before any
  // target runs; any failure here (including an unexpected throw) is a `setup` failure,
  // caught by `runSync`'s outer handler below — and carries no target, since no target has
  // been attempted yet.
  const email = await deps.resolveIdentity();
  const lookbackDays = settings.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const includeExternal = includeExternalFor(settings.includeExternal, deps.platform);

  let anyFailed = false;
  for (const target of targets) {
    const failed = await runTarget(deps, now, settings, email, includeExternal, lookbackDays, target);
    anyFailed = anyFailed || failed;
  }

  return anyFailed ? 1 : 0;
}

export async function runSync(deps: SyncDeps): Promise<number> {
  const now = deps.now();

  try {
    return await run(deps, now);
  } catch (err) {
    await emit(deps, now, 'fail', `setup ${errorMessage(err)}`);
    return 1;
  }
}

const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

/** Append `line` to `~/.codemie/logs/analytics-sync.log` (dir 0700, file 0600). */
async function appendSyncLog(line: string): Promise<void> {
  const logPath = getCodemiePath('logs', 'analytics-sync.log');
  const logDir = dirname(logPath);
  await mkdir(logDir, { recursive: true, mode: LOG_DIR_MODE });
  await chmod(logDir, LOG_DIR_MODE);
  await appendFile(logPath, `${line}\n`, { mode: LOG_FILE_MODE });
  await chmod(logPath, LOG_FILE_MODE);
}

/** Deliver `reports` to `target`. Only called for a target `configuredTargets` already found
 * present on `settings`, so the "missing settings" branches below are defensive, not a
 * normal path. */
async function deliverToTarget(
  target: TargetId,
  settings: SyncSettings,
  email: string,
  reports: SyncReport[]
): Promise<void> {
  if (target === 'webhook') {
    if (settings.webhookUrl === undefined) {
      throw new SyncTargetMissingError();
    }
    await sendWebhook(settings.webhookUrl, reports);
    return;
  }

  if (settings.git === undefined) {
    throw new SyncTargetMissingError();
  }
  await new GitTarget(settings.git, email, createGitRunner()).deliver(reports);
}

/** Real dependencies for `runSync`: real clock, settings, identity, markers, fs and network; the file comes from
 * `collection`'s export source. */
export function realSyncDeps(collection: Pick<AnalyticsCollection, 'exportSource'>): SyncDeps {
  return {
    now: () => new Date(),
    loadSettings: () => loadSyncSettings(),
    resolveIdentity: () => resolveSyncIdentity(realIdentityDeps),
    exportSource: collection.exportSource(),
    deliver: deliverToTarget,
    readMarker: (target: TargetId, now: Date) =>
      target === 'git' ? readMarker(now, gitMarkerPath()) : readMarker(now),
    writeMarker: (target: TargetId, at: Date) =>
      target === 'git' ? writeMarker(at, gitMarkerPath()) : writeMarker(at),
    appendLog: appendSyncLog,
    print: (line: string): void => {
      console.log(line);
    },
    platform: process.platform,
  };
}
