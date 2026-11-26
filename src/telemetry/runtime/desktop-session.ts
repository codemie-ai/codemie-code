import { randomUUID } from 'crypto';
import { stat } from 'fs/promises';
import { hostOf } from '@/agents/core/session/send-path.js';
import type { Session } from '@/agents/core/session/types.js';
import type { DesktopTelemetryRuntimeConfig, LocalTelemetryDiscoveredSession } from '@/telemetry/runtime/types.js';
import { restoreCompletedFiles } from '@/telemetry/runtime/completed-files.js';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { detectGitBranch, detectGitRemoteRepo, processStartedAt } from '@/utils/processes.js';

/** How often a live daemon retries delivering its undelivered records; these retries spend no attempt. */
export const DESKTOP_REDELIVERY_INTERVAL_MS = 10 * 60 * 1000;

/** How long a re-tracked record waits for its reconcile lock; past it the session is retried at the next poll. */
export const DESKTOP_REOPEN_LOCK_BUDGET_MS = 30_000;

export interface TranscriptFingerprint {
  mtimeMs: number;
  size: number;
}

export interface TrackedSession {
  codemieSessionId: string;
  lastSeenActivityAt: number;
  transcript?: TranscriptFingerprint;
}

/** The daemon as the owner of the records it creates or re-tracks. */
export function daemonOwner(): Pick<Session, 'ownerPid' | 'ownerStartedAt'> {
  return { ownerPid: process.pid, ownerStartedAt: processStartedAt() };
}

/** Activity newer than the record's saved one and its end: an end at a touch with no transcript write is only in `endTime`. */
export function hasActivityAfter(record: Session, updatedAt: number): boolean {
  return updatedAt > Math.max(record.runtimeCheckpoint?.lastSeenActivityAt ?? 0, record.endTime ?? 0);
}

/**
 * A Desktop session's end: its last activity — the later of the tracked (in-memory) and the saved one —, else
 * its last discovery, else its start. Never the moment it is finalized.
 * ponytail: the saved activity moves only on a transcript change, so a record finalized from disk (the start-up
 * scan, the CLI) ends short by trailing activity that wrote nothing — duration only, no tokens lost.
 */
export function desktopEndTime(session: Session, trackedActivityAt?: number): number {
  const saved = session.runtimeCheckpoint?.lastSeenActivityAt;
  const activity = saved === undefined ? trackedActivityAt : Math.max(saved, trackedActivityAt ?? saved);
  return activity ?? session.runtimeCheckpoint?.lastDiscoveredAt ?? session.startTime;
}

/**
 * A record is handled only by a daemon of its own CodeMie host: the cookies are keyed by host, and another host
 * would receive the data under its own account. A record without `codemieUrl` predates the field and is this
 * host's; a daemon whose own URL has no host treats nothing as foreign.
 */
export function isForeignRecord(record: Session, daemonUrl: string): boolean {
  const recordHost = hostOf(record.codemieUrl);
  const daemonHost = hostOf(daemonUrl);
  return recordHost !== undefined && daemonHost !== undefined && recordHost !== daemonHost;
}

export type RecordKind = 'restart' | 'legacy' | 'undelivered' | 'foreign-gone';

export function isSameFingerprint(
  previous: TranscriptFingerprint | undefined,
  current: TranscriptFingerprint
): boolean {
  return previous !== undefined
    && previous.mtimeMs === current.mtimeMs
    && previous.size === current.size;
}

/** A transcript's stat() fingerprint; undefined when it cannot be read, so it never matches a saved one. */
export async function readTranscriptFingerprint(transcriptPath: string): Promise<TranscriptFingerprint | undefined> {
  try {
    const stats = await stat(transcriptPath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    logger.debug('[desktop-telemetry] Failed to stat transcript', {
      transcriptPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

/** A working directory's git branch, repository and CodeMie project. */
export type Attribution = [string | undefined, string | undefined, string | undefined];

export function detectAttribution(workingDirectory: string, profile: string | undefined): Promise<Attribution> {
  return Promise.all([
    detectGitBranch(workingDirectory),
    detectGitRemoteRepo(workingDirectory),
    // The daemon's own profile, by name: the active profile may have changed since it started.
    ConfigLoader.load(workingDirectory, profile ? { name: profile } : undefined)
      .then(c => c.codeMieProject ?? undefined)
      .catch(() => undefined)
  ]);
}

/** A new record of a discovered session, owned by this daemon. */
export function buildNewSession(
  config: DesktopTelemetryRuntimeConfig,
  credentialsUrl: string,
  discovered: LocalTelemetryDiscoveredSession,
  [gitBranch, repository, project]: Attribution,
  baselineCutoffMs: number | undefined
): Session {
  return {
    sessionId: randomUUID(),
    agentName: config.clientType,
    provider: config.provider,
    codemieUrl: credentialsUrl,
    startTime: baselineCutoffMs ?? discovered.createdAt,
    workingDirectory: discovered.workingDirectory,
    gitBranch: gitBranch || undefined,
    repository: repository || undefined,
    project: project || undefined,
    status: 'active',
    activeDurationMs: 0,
    ...daemonOwner(),
    correlation: {
      status: 'matched',
      agentSessionId: discovered.agentSessionId,
      agentSessionFile: discovered.transcriptPath,
      retryCount: 0
    },
    runtimeCheckpoint: {
      externalSessionId: discovered.externalSessionId,
      transcriptPath: discovered.transcriptPath,
      lastDiscoveredAt: Date.now(),
      lastSeenActivityAt: discovered.updatedAt,
      ...(baselineCutoffMs !== undefined && { baselineCutoffMs })
    }
  };
}

export async function followFolder(config: DesktopTelemetryRuntimeConfig, existing: Session, workingDirectory: string): Promise<void> {
  if (workingDirectory === existing.workingDirectory) return;
  // ponytail: the start metric and the deltas sent before the switch keep the previous folder's attribution
  const [gitBranch, repository, project] = await detectAttribution(workingDirectory, config.profile);
  logger.info('[desktop-telemetry] Session switched folder', {
    sessionId: existing.sessionId, from: existing.workingDirectory, to: workingDirectory, gitBranch, repository, project
  });
  existing.workingDirectory = workingDirectory;
  existing.gitBranch = gitBranch || undefined;
  existing.repository = repository || undefined;
  existing.project = project || undefined;
}

/** Moves a `completed` record's set back to its live names and clears its end and delivery state. */
export async function reopenCompleted(existing: Session, discovered: LocalTelemetryDiscoveredSession): Promise<void> {
  logger.info('[desktop-telemetry] Reopening completed session — activity resumed', {
    sessionId: existing.sessionId,
    externalSessionId: discovered.externalSessionId,
  });
  await restoreCompletedFiles(existing.sessionId);
  // An ownerless completed record is either a pre-upgrade one, whose daemon sent its end metric without recording it,
  // or a legacy one closed locally with nothing sent — either way its earlier stretch is not reported again
  const endMetricLeft = existing.ownerPid === undefined
    || existing.endMetricSentAt !== undefined
    || existing.endMetricSkipped !== undefined;
  existing.status = 'active';
  delete existing.endTime;
  delete existing.reason;
  delete existing.endMetricSentAt;
  delete existing.endMetricSkipped;
  delete existing.deliveryAttempts;
  delete existing.localFinalizeFailures;
  delete existing.deliveryAttemptedAt;
  delete existing.droppedAt;
  delete existing.droppedReason;
  delete existing.deliveryFailingSince;
  delete existing.deliveryRealAttempts;
  // ponytail: the stretch start lags its first activity by up to one poll interval (and the reopen lock wait), and when
  // the previous stretch's end metric never left, the next end metric covers that stretch, the gap and the new one;
  // delivering the pending end metric at the reopen would make it exact
  if (endMetricLeft) {
    existing.stretchStartTime = discovered.updatedAt;
  }
}
