import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { OTEL_STREAMS, SPOOL_STREAMS, spoolRoot, streamFile, type SpoolStream } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { createStatus, readStatus, writeStatus, type SessionStatus } from './session-status.js';
import { hooksOnlyForwardAllowed } from './spool-config.js';
import {
  applyProjectDecision,
  decideProject,
  evaluateProjectPolicy,
  hookEventProjectNames,
  hookRecordIsProject,
  type SessionPolicy,
  type StreamPolicy,
} from './session-project.js';

const NEWLINE = 0x0a;

/** Sessions already told about a discard; bounded so a long-lived daemon cannot grow it without limit. */
const MAX_WARNED_SESSIONS = 1000;
const warnedDiscards = new Set<string>();

function warnDiscardOnce(sessionId: string, ...args: unknown[]): void {
  if (warnedDiscards.has(sessionId)) return;
  if (warnedDiscards.size >= MAX_WARNED_SESSIONS) {
    // Set iteration order is insertion order: drop the oldest entry, not everyone warned so far.
    const oldest = warnedDiscards.values().next().value;
    if (oldest !== undefined) warnedDiscards.delete(oldest);
  }
  warnedDiscards.add(sessionId);
  logger.warn('[otlp-spool] session project conflict: unsent analytics discarded', ...sanitizeLogArgs(...args));
}

/** Single place that reports the none-or-bound -> conflict transition (live ingest and legacy scan). */
function warnConflictStarted(sessionId: string, status: SessionStatus): void {
  logger.warn(
    '[otlp-spool] session switched project: only hooks recorded for the first project before the switch ' +
      'can still be sent; hooks of other projects and all OTLP logs/metrics/traces of this session are not sent',
    ...sanitizeLogArgs({
      sessionId,
      project: status.project ?? null,
      otherNames: Math.max(0, (status.projectConflict?.length ?? 0) - (status.project ? 1 : 0)),
      sealed: Boolean(status.projectSeal),
    })
  );
}

async function hooksFileState(sessionId: string): Promise<{ exists: boolean; size: number }> {
  try {
    return { exists: true, size: (await stat(streamFile(sessionId, 'hooks'))).size };
  } catch {
    return { exists: false, size: 0 };
  }
}

/* ------------------------------------------------------- unlocked internals --- */
// These assume the caller already holds the session lock.

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Range-read everything after `cursor`, up to `end` when given. Never touches the acknowledged prefix. */
async function readRange(
  sessionId: string,
  stream: SpoolStream,
  cursor: number,
  end?: number
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(streamFile(sessionId, stream), 'r');
  } catch {
    return null; // missing file => nothing pending
  }
  try {
    const { size: fileSize } = await handle.stat();
    const size = end === undefined ? fileSize : Math.min(fileSize, end);
    if (size <= cursor) return null; // drained
    const buffer = Buffer.allocUnsafe(size - cursor);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead) : null;
  } finally {
    await handle.close();
  }
}

/** Project names of every hook on disk, acknowledged prefix included. Malformed lines are skipped. */
async function readHookProjectNames(sessionId: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(streamFile(sessionId, 'hooks'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const names: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const { hookEvent } = JSON.parse(line) as { hookEvent: string };
      names.push(...hookEventProjectNames(JSON.parse(hookEvent)));
    } catch {
      // unusable record: carries no usable project
    }
  }
  return names;
}

/**
 * Legacy recovery: scan the hooks already on disk once and bind or conflict.
 * Mutates `status` only (caller holds the lock and does the single write).
 */
export async function resolveLegacyProjectLocked(
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  const hadConflict = Boolean(status.projectConflict);
  applyProjectDecision(status, decideProject(await readHookProjectNames(sessionId), status));
  status.projectScanned = true;
  if (!hadConflict && status.projectConflict) warnConflictStarted(sessionId, status);
}

/**
 * Drop the unsent backlog of `streams` locally: their cursors to EOF. Frees no disk — the sweeper
 * removes the files once the session is drained and idle. Mutates `status` only.
 */
export async function discardBacklogLocked(
  sessionId: string,
  status: SessionStatus,
  streams: readonly SpoolStream[] = SPOOL_STREAMS
): Promise<{ changed: boolean; bytes: number }> {
  let bytes = 0;
  for (const stream of streams) {
    try {
      const { size } = await stat(streamFile(sessionId, stream));
      if (size > status.cursors[stream]) {
        bytes += size - status.cursors[stream];
        status.cursors[stream] = size;
      }
    } catch {
      // missing file: nothing to discard
    }
  }
  return { changed: bytes > 0, bytes };
}

/**
 * The one place that applies the project policy, for the tick and for the snapshots. Caller holds
 * the lock. Runs the one-time legacy scan, evaluates `evaluateProjectPolicy`, executes every discard
 * it demands and persists the status once when anything changed.
 */
export async function applyProjectPolicyLocked(
  sessionId: string,
  status: SessionStatus
): Promise<SessionPolicy> {
  const hooks = await hooksFileState(sessionId);
  let dirty = false;
  if (!status.projectScanned && hooks.exists) {
    await resolveLegacyProjectLocked(sessionId, status);
    dirty = true;
  }

  const policy = evaluateProjectPolicy(status, {
    hooksSize: hooks.size,
    hooksOnlyAllowed: hooksOnlyForwardAllowed(),
  });

  let hooksBytes = 0;
  let otelBytes = 0;
  if (policy.hooks.kind === 'discard') {
    const result = await discardBacklogLocked(sessionId, status, ['hooks']);
    hooksBytes = result.bytes;
    dirty ||= result.changed;
  }
  if (policy.otel.kind === 'discard') {
    const result = await discardBacklogLocked(sessionId, status, OTEL_STREAMS);
    otelBytes = result.bytes;
    dirty ||= result.changed;
  }

  if (dirty) {
    await writeStatus(sessionId, status);
  }
  if (hooksBytes > 0 || otelBytes > 0) {
    logger.debug(
      '[otlp-spool] discarded unsent backlog: session project is not sendable',
      ...sanitizeLogArgs({ sessionId, state: policy.state })
    );
    if (policy.state === 'conflict') {
      warnDiscardOnce(sessionId, { sessionId, reason: policy.reason ?? 'none', hooksBytes, otelBytes });
    }
  }
  return policy;
}

type SendPolicy = Extract<StreamPolicy, { kind: 'send' }>;

/** Snapshot-side gate for one stream. Caller holds the lock. `null`: nothing may be sent. */
async function gateStreamLocked(
  sessionId: string,
  status: SessionStatus,
  stream: SpoolStream
): Promise<SendPolicy | null> {
  const policy = await applyProjectPolicyLocked(sessionId, status);
  const streamPolicy = stream === 'hooks' ? policy.hooks : policy.otel;
  return streamPolicy.kind === 'send' ? streamPolicy : null;
}

/**
 * Locked re-check right before a request: the policy still lets `stream` go out under `project`,
 * the exact byte range that was snapshotted is still the next one to send, and the payload that was
 * built from it was built under the same rule the policy applies now. A snapshot of a bound session
 * is unfiltered (blank-named hooks included), so it is stale once a conflict seals the session:
 * `filtered` must match what the policy demands now, otherwise nothing is sent, the cursor stays and
 * the next tick re-snapshots through the filter. Pure read; a sealed session answers true for its
 * filtered hooks prefix only, never for an OTLP stream.
 */
export async function isSendAllowed(
  sessionId: string,
  stream: SpoolStream,
  project: string,
  range: { cursor: number; end: number; filtered: boolean }
): Promise<boolean> {
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return false;
    const hooks = await hooksFileState(sessionId);
    const policy = evaluateProjectPolicy(status, {
      hooksSize: hooks.size,
      hooksOnlyAllowed: hooksOnlyForwardAllowed(),
    });
    const streamPolicy = stream === 'hooks' ? policy.hooks : policy.otel;
    if (streamPolicy.kind !== 'send' || streamPolicy.project.toLowerCase() !== project.toLowerCase()) {
      return false;
    }
    if (status.cursors[stream] !== range.cursor) return false;
    if (Boolean(streamPolicy.onlyProject) !== range.filtered) return false;
    return streamPolicy.limit === undefined || range.end <= streamPolicy.limit;
  });
}

/* --------------------------------------------------------------- producers --- */

/**
 * Append spool bytes and make the session discoverable.
 *
 * Holds the session lock so an append can never interleave with a forwarder
 * snapshot (torn record), a cursor advance, or a sweep deletion.
 */
export async function appendSpool(
  sessionId: string,
  stream: SpoolStream,
  data: string | Buffer,
  projectNames?: string[]
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    await mkdir(spoolRoot(), { recursive: true });

    const path = streamFile(sessionId, stream);
    const exists = await fileExists(path);
    const recreated = !exists;

    if (stream === 'hooks' && projectNames) {
      // Observe and decide in the same critical section as the append. The status is
      // written BEFORE the bytes: a failed append leaves a conservative status and
      // the hook client retries the same batch.
      const status = (await readStatus(sessionId)) ?? createStatus();
      // The exact end of everything written so far: the end of the sealed prefix if this batch conflicts.
      const sizeBefore = exists ? (await stat(path)).size : 0;
      if (!status.projectScanned) {
        if (exists) {
          await resolveLegacyProjectLocked(sessionId, status);
        } else {
          status.projectScanned = true;
        }
      }
      const hadConflict = Boolean(status.projectConflict);
      applyProjectDecision(status, decideProject(projectNames, status), sizeBefore);
      if (recreated) {
        // A new file is a new incarnation: a seal of the old one must not point into it.
        status.cursors.hooks = 0;
        delete status.projectSeal;
      }
      await writeStatus(sessionId, status);
      if (!hadConflict && status.projectConflict) warnConflictStarted(sessionId, status);
      await appendFile(path, data);
      return;
    }

    await appendFile(path, data);

    const status = await readStatus(sessionId);
    if (!status) {
      await writeStatus(sessionId, createStatus());
      return;
    }
    // A recreated file restarts at offset 0, so a cursor left over from a swept
    // (or partially deleted) session would otherwise skip these bytes forever.
    if (recreated && status.cursors[stream] !== 0) {
      status.cursors[stream] = 0;
      await writeStatus(sessionId, status);
    }
  });
}

/* --------------------------------------------------------------- consumers --- */

export interface PendingBytes {
  /** Project the session is bound to; sent as `X-CodeMie-Project`. */
  project: string;
  /** Cursor the snapshot was taken from — pass it back when acknowledging. */
  cursor: number;
  bytes: Buffer;
}

/**
 * Consistent snapshot of the bytes pending for an OTEL stream.
 *
 * The lock guarantees the snapshot never contains a partially written append,
 * so the protobuf payload handed to the backend is always whole.
 * Must NOT be called while already holding the session lock.
 */
export async function snapshotPendingBytes(
  sessionId: string,
  stream: SpoolStream
): Promise<PendingBytes | null> {
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return null; // session was swept
    const gate = await gateStreamLocked(sessionId, status, stream);
    if (!gate) return null;
    const cursor = status.cursors[stream];
    const bytes = await readRange(sessionId, stream, cursor);
    return bytes ? { project: gate.project, cursor, bytes } : null;
  });
}

export interface PendingHookBatch {
  /** Project the session is bound to; sent as `X-CodeMie-Project`. */
  project: string;
  cursor: number;
  /** Complete, newline-terminated NDJSON records that may be sent. */
  records: string[];
  /** Exact number of source bytes consumed, including newlines and records that are not sent. */
  byteLength: number;
  /** Records read but not provably the sealed project's (sealed session only). */
  dropped: number;
  /** The records went through the only-this-project filter (sealed session). Bound snapshots are not filtered. */
  filtered: boolean;
}

/**
 * Consistent snapshot of the complete NDJSON records pending for hooks.
 *
 * The chunk is cut at the last newline byte, so an incomplete trailing record
 * stays pending and `byteLength` is a byte-exact acknowledgement amount.
 * Cutting on a newline is safe for UTF-8: `0x0a` cannot occur inside a
 * multi-byte sequence.
 * Must NOT be called while already holding the session lock.
 */
export async function snapshotPendingHookRecords(
  sessionId: string
): Promise<PendingHookBatch | null> {
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return null;
    const gate = await gateStreamLocked(sessionId, status, 'hooks');
    if (!gate) return null;

    const cursor = status.cursors.hooks;
    const pending = await readRange(sessionId, 'hooks', cursor, gate.limit);
    if (!pending) return null;

    const lastNewline = pending.lastIndexOf(NEWLINE);
    if (lastNewline < 0) {
      // Inside a sealed prefix nothing will ever complete a partial record (bytes after the seal
      // belong to the next batch), so consume it instead of waiting for it forever.
      return gate.limit === undefined
        ? null
        : { project: gate.project, cursor, records: [], byteLength: pending.length, dropped: 1, filtered: true };
    }

    const complete = pending.subarray(0, lastNewline + 1);
    let records = complete
      .toString('utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    let dropped = 0;
    if (gate.onlyProject) {
      const only = gate.onlyProject;
      const kept = records.filter((record) => hookRecordIsProject(record, only));
      dropped = records.length - kept.length;
      records = kept;
    }

    return {
      project: gate.project,
      cursor,
      records,
      byteLength: complete.length,
      dropped,
      filtered: Boolean(gate.onlyProject),
    };
  });
}
