import { stat } from 'node:fs/promises';
import {
  OTEL_STREAMS,
  SPOOL_STREAMS,
  statusFile,
  streamFile,
  type SpoolStream,
} from './spool-paths.js';
import type { SessionStatus } from './session-status.js';

export interface StreamState {
  exists: boolean;
  /** Current file size in bytes (0 when missing). */
  size: number;
  /** Acknowledged byte offset from the status file. */
  cursor: number;
  /** Last write time of the spool file, or `null` when missing. */
  mtimeMs: number | null;
}

export interface SpoolState {
  sessionId: string;
  streams: Record<SpoolStream, StreamState>;
  /** Latest mtime across existing spool data files — i.e. last producer write. */
  latestWriteMs: number | null;
}

/**
 * Snapshot the filesystem truth for a session: spool files are the source of
 * truth for *what was written*, cursors for *what was delivered*.
 */
export async function readSpoolState(
  sessionId: string,
  status: SessionStatus
): Promise<SpoolState> {
  const entries = await Promise.all(
    SPOOL_STREAMS.map(async (stream): Promise<[SpoolStream, StreamState]> => {
      const cursor = status.cursors[stream];
      try {
        const info = await stat(streamFile(sessionId, stream));
        return [stream, { exists: true, size: info.size, cursor, mtimeMs: info.mtimeMs }];
      } catch {
        return [stream, { exists: false, size: 0, cursor, mtimeMs: null }];
      }
    })
  );

  const streams = Object.fromEntries(entries) as Record<SpoolStream, StreamState>;
  const latestWriteMs = SPOOL_STREAMS.reduce<number | null>((latest, stream) => {
    const mtimeMs = streams[stream].mtimeMs;
    if (mtimeMs === null) return latest;
    return latest === null ? mtimeMs : Math.max(latest, mtimeMs);
  }, null);

  return { sessionId, streams, latestWriteMs };
}

/** The stream was written at some point (sticky, survives the cursor reaching EOF). */
export const hasData = (state: StreamState): boolean => state.size > 0;

/** Bytes exist after the cursor and still need to be delivered. */
export const hasPending = (state: StreamState): boolean => state.size > state.cursor;

/** Everything written has been acknowledged (missing/empty files are drained). */
export const isDrained = (state: StreamState): boolean => state.size <= state.cursor;

export function hooksGroupPresent(spool: SpoolState): boolean {
  return hasData(spool.streams.hooks);
}

export function otelGroupPresent(spool: SpoolState): boolean {
  return OTEL_STREAMS.some((stream) => hasData(spool.streams[stream]));
}

export function hasPendingData(spool: SpoolState): boolean {
  return SPOOL_STREAMS.some((stream) => hasPending(spool.streams[stream]));
}

export function isSessionDrained(spool: SpoolState): boolean {
  return SPOOL_STREAMS.every((stream) => isDrained(spool.streams[stream]));
}

/**
 * Last producer activity. Spool appends bump spool-file mtimes; forwarding and
 * cursor writes only touch the status file, so the status mtime is a fallback
 * used solely when no spool data file exists.
 */
export async function lastActivityMs(spool: SpoolState): Promise<number | null> {
  if (spool.latestWriteMs !== null) return spool.latestWriteMs;
  try {
    const info = await stat(statusFile(spool.sessionId));
    return info.mtimeMs;
  } catch {
    return null;
  }
}
