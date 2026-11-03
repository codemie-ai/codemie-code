import { hostOf } from '@/agents/core/session/send-path.js';
import type { Session } from '@/agents/core/session/types.js';
import { processStartedAt } from '@/utils/processes.js';

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
