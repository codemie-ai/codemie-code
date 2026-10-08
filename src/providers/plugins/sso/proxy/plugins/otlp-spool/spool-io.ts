import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { spoolRoot, streamFile, type SpoolStream } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { createStatus, readStatus, writeStatus } from './session-status.js';

const NEWLINE = 0x0a;

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

/** Range-read everything after `cursor`. Never touches the acknowledged prefix. */
async function readRange(
  sessionId: string,
  stream: SpoolStream,
  cursor: number
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(streamFile(sessionId, stream), 'r');
  } catch {
    return null; // missing file => nothing pending
  }
  try {
    const { size } = await handle.stat();
    if (size <= cursor) return null; // drained
    const buffer = Buffer.allocUnsafe(size - cursor);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead) : null;
  } finally {
    await handle.close();
  }
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
  data: string | Buffer
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    await mkdir(spoolRoot(), { recursive: true });

    const path = streamFile(sessionId, stream);
    const recreated = !(await fileExists(path));
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
    const cursor = status.cursors[stream];
    const bytes = await readRange(sessionId, stream, cursor);
    return bytes ? { cursor, bytes } : null;
  });
}

export interface PendingHookBatch {
  cursor: number;
  /** Complete, newline-terminated NDJSON records. */
  records: string[];
  /** Exact number of source bytes these records occupy, including newlines. */
  byteLength: number;
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

    const cursor = status.cursors.hooks;
    const pending = await readRange(sessionId, 'hooks', cursor);
    if (!pending) return null;

    const lastNewline = pending.lastIndexOf(NEWLINE);
    if (lastNewline < 0) return null; // no complete record yet

    const complete = pending.subarray(0, lastNewline + 1);
    const records = complete
      .toString('utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    return { cursor, records, byteLength: complete.length };
  });
}
