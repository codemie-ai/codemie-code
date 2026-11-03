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
 * target gets its own marker-derived window, its own `buildReport` call, its own delivery
 * attempt and its own marker move, so one target's failure never blocks or rolls back
 * another's delivery (AC7/AC8).
 *
 * `runSync` never throws and never calls `process.exit`. Every outcome for a target —
 * success, a skipped empty window, or a failure — prints and appends exactly one line via
 * {@link formatLogLine}:
 *   `<ISO> ok sent <name> <bytes> target=<id>`
 *   `<ISO> skip <reason> target=<id>`
 *   `<ISO> fail <setup|export|send> <redacted detail> target=<id>`
 * A setup failure resolved before any target is chosen (no settings file, no configured
 * target, no resolvable identity) carries no ` target=<id>` suffix and counts for every
 * target in `status`; a target whose own marker cannot be read fails `setup` with its
 * suffix and the remaining targets still run. Exit code is 1 if any
 * target failed (or the run failed in setup), 0 otherwise. Category mapping per target:
 * a report-build failure -> `export`; a webhook delivery failure -> `export` when it is an
 * `ExportTooLargeError` (its message carries the byte count), else `send`; a git delivery
 * failure is always `send`, with its detail carrying {@link gitHint}. The marker for a
 * target only moves (to the run's `now()`) after that target's delivery resolves — never on
 * `skip` or `fail`. A marker write that fails after delivery keeps the `ok sent` outcome
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
import { buildSyncReport } from './report-builder.js';
import { createGitRunner, gitHint } from './targets/git-client.js';
import { GitTarget, gitMarkerPath } from './targets/git-target.js';
import { sendWebhook } from './targets/webhook-target.js';
import type { SyncReport, SyncSettings } from './types.js';
import { dailyWindow } from './window.js';
import { SessionsSource } from '../sources/sessions-source.js';
import type { AnalyticsSource } from '../sources/types.js';

/** A `codemie analytics sync` delivery target. */
export type TargetId = 'webhook' | 'git';

/** Every side effect `runSync` needs, injected so tests run without network or real files. */
export interface SyncDeps {
  now(): Date;
  loadSettings(): Promise<SyncSettings | null>;
  resolveIdentity(): Promise<string>;
  buildReport: typeof buildSyncReport;
  deliver(target: TargetId, settings: SyncSettings, email: string, report: SyncReport): Promise<void>;
  readMarker(target: TargetId, now: Date): Promise<Date | null>;
  writeMarker(target: TargetId, at: Date): Promise<void>;
  appendLog(line: string): Promise<void>;
  print(line: string): void;
  platform: NodeJS.Platform;
  /** The analytics data source `buildReport` loads sessions from. */
  source: AnalyticsSource;
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

  let report: SyncReport | null;
  try {
    report = await deps.buildReport({ source: deps.source, window, email, includeExternal, now });
  } catch (err) {
    await emit(deps, now, 'fail', `export ${errorMessage(err)}`, target);
    return true;
  }

  if (report === null) {
    await emit(deps, now, 'skip', `no sessions in window ${window.label}`, target);
    return false;
  }

  try {
    await deps.deliver(target, settings, email, report);
  } catch (err) {
    await emit(deps, now, 'fail', deliveryFailureDetail(target, err), target);
    return true;
  }

  const markerWarning = await moveMarker(deps, target, now);
  await emit(deps, now, 'ok', `sent ${report.fileName} ${report.bytes.length}${markerWarning}`, target);
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

/** Deliver `report` to `target`. Only called for a target `configuredTargets` already found
 * present on `settings`, so the "missing settings" branches below are defensive, not a
 * normal path. */
async function deliverToTarget(
  target: TargetId,
  settings: SyncSettings,
  email: string,
  report: SyncReport
): Promise<void> {
  if (target === 'webhook') {
    if (settings.webhookUrl === undefined) {
      throw new SyncTargetMissingError();
    }
    await sendWebhook(settings.webhookUrl, report);
    return;
  }

  if (settings.git === undefined) {
    throw new SyncTargetMissingError();
  }
  await new GitTarget(settings.git, email, createGitRunner()).deliver(report);
}

/** Real dependencies for `runSync`: real clock, settings, identity, markers, fs and network. */
export function realSyncDeps(): SyncDeps {
  return {
    now: () => new Date(),
    loadSettings: () => loadSyncSettings(),
    resolveIdentity: () => resolveSyncIdentity(realIdentityDeps),
    buildReport: buildSyncReport,
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
    source: new SessionsSource(),
  };
}
