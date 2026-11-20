/**
 * JSONL Reader Utility
 *
 * Generic JSONL file reading with type safety.
 * Shared by all session processors and adapters.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { open, readFile } from 'fs/promises';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'fs';
import { logger } from '../../../../utils/logger.js';

/**
 * Every file a parse read, keyed by the path it was read under: the byte length of an append-only
 * transcript, or the whole text of a small file rewritten in place (see {@link readSnapshotFile}).
 */
export type JSONLSnapshot = ReadonlyMap<string, number | string>;

interface SnapshotScope {
  mode: 'record' | 'replay';
  sizes: Map<string, number | string>;
  /** Set during a replay when a recorded file is gone or shorter than recorded. */
  incomplete?: boolean;
  /** The recorded files a replay has read back. */
  visited?: Set<string>;
}

// Scopes a parse to one snapshot without threading it through every adapter's signature.
const snapshotScope = new AsyncLocalStorage<SnapshotScope>();

/**
 * Run `parse` and return, with its result, the byte length of every file
 * {@link readJSONLTolerant} read for it. Lets a caller drop the parsed result and later
 * reproduce exactly the same input with {@link replayJSONLSnapshot}, even when a live
 * transcript has grown since.
 */
export async function recordJSONLSnapshot<T>(parse: () => Promise<T>): Promise<{ result: T; snapshot: JSONLSnapshot }> {
  const sizes = new Map<string, number | string>();
  const result = await snapshotScope.run({ mode: 'record', sizes }, parse);
  return { result, snapshot: sizes };
}

/**
 * Run `parse` reading each file only up to its recorded length, and any file the snapshot
 * did not read as absent, so it sees exactly the input {@link recordJSONLSnapshot} did.
 * `complete` is false when the input could not be reproduced, so the result is partial: a
 * recorded file was removed or truncated since, or was never read back (a child transcript the
 * adapter no longer lists). Adapters swallow read errors, so the result alone cannot tell.
 * Replay relies on transcripts being append-only.
 */
export async function replayJSONLSnapshot<T>(snapshot: JSONLSnapshot, parse: () => Promise<T>): Promise<{ result: T; complete: boolean }> {
  const scope: SnapshotScope = { mode: 'replay', sizes: new Map(snapshot), visited: new Set() };
  const result = await snapshotScope.run(scope, parse);
  const allRead = [...snapshot.keys()].every((path) => scope.visited?.has(path));
  return { result, complete: !scope.incomplete && allRead };
}

/** The recorded entry for `filePath` in a replay, marking it read back; undefined when the snapshot never read it. */
function replayed(scope: SnapshotScope, filePath: string): number | string | undefined {
  const recorded = scope.sizes.get(filePath);
  if (recorded !== undefined) scope.visited?.add(filePath);
  return recorded;
}

/** True while replaying a snapshot that did not include `filePath`: the file is newer than it. */
export function isOutsideJSONLSnapshot(filePath: string): boolean {
  const scope = snapshotScope.getStore();
  return scope?.mode === 'replay' && !scope.sizes.has(filePath);
}

/** Error for a file a replayed snapshot never read: it is newer than the snapshot, so it reads as absent. */
function newerThanSnapshot(filePath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${filePath} is newer than the snapshot`), { code: 'ENOENT' });
}

/**
 * The first `length` bytes of `filePath`. A file removed or shorter than `length` since it was
 * recorded marks the replay incomplete; a removed one still fails as it would have.
 */
async function readPrefix(scope: SnapshotScope, filePath: string, length: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    scope.incomplete = true;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    if (bytesRead < length) scope.incomplete = true;
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Synchronous {@link readPrefix}. */
function readPrefixSync(scope: SnapshotScope, filePath: string, length: number): Buffer {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    scope.incomplete = true;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    if (bytesRead < length) scope.incomplete = true;
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read an append-only transcript (JSONL) as text, as the active snapshot scope says: whole and
 * recording its length, or only up to the length recorded for it. A file the replayed snapshot
 * never read fails with `ENOENT`. Adapters read transcripts through this (or
 * {@link readJSONLTolerant}) so analytics can drop a parsed family and replay it later. Never use
 * it for a file that is rewritten in place: a byte prefix of a rewritten file is not its old content.
 */
export async function readTranscriptText(filePath: string): Promise<string> {
  const scope = snapshotScope.getStore();
  if (scope?.mode === 'replay') {
    const length = replayed(scope, filePath);
    if (length === undefined) throw newerThanSnapshot(filePath);
    if (typeof length === 'string') return length;
    return (await readPrefix(scope, filePath, length)).toString('utf-8');
  }
  const buffer = await readFile(filePath);
  scope?.sizes.set(filePath, buffer.length);
  return buffer.toString('utf-8');
}

/** Synchronous {@link readTranscriptText}, for adapters whose transcript reader is synchronous. */
export function readTranscriptTextSync(filePath: string): string {
  const scope = snapshotScope.getStore();
  if (scope?.mode === 'replay') {
    const length = replayed(scope, filePath);
    if (length === undefined) throw newerThanSnapshot(filePath);
    if (typeof length === 'string') return length;
    return readPrefixSync(scope, filePath, length).toString('utf-8');
  }
  const buffer = readFileSync(filePath);
  scope?.sizes.set(filePath, buffer.length);
  return buffer.toString('utf-8');
}

/**
 * Read a small file that may be rewritten in place (a JSON sidecar) as text. Recording keeps its
 * whole text, so a replay returns exactly what discovery read; a file absent then stays absent
 * (`ENOENT`). Use {@link readTranscriptText} for append-only transcripts, which can be large.
 */
export async function readSnapshotFile(filePath: string): Promise<string> {
  const scope = snapshotScope.getStore();
  if (scope?.mode === 'replay') {
    const recorded = replayed(scope, filePath);
    if (recorded === undefined) throw newerThanSnapshot(filePath);
    return typeof recorded === 'string' ? recorded : (await readPrefix(scope, filePath, recorded)).toString('utf-8');
  }
  const text = await readFile(filePath, 'utf-8');
  scope?.sizes.set(filePath, text);
  return text;
}

/**
 * Read all records from JSONL file, skipping corrupted lines.
 * Inside {@link recordJSONLSnapshot} / {@link replayJSONLSnapshot} the read is recorded or
 * replayed; a file outside a replayed snapshot reads as missing.
 *
 * @param filePath - Absolute path to JSONL file
 * @param logPrefix - Log prefix for warnings (e.g. '[codex-storage]')
 * @returns Array of parsed records (empty if file doesn't exist; corrupted lines skipped)
 * @throws The read error for any failure other than a missing file (EACCES, EMFILE, EISDIR, …)
 */
export async function readJSONLTolerant<T>(filePath: string, logPrefix = '[jsonl-reader]'): Promise<T[]> {
  try {
    const content = await readTranscriptText(filePath);
    const lines = content.trim().split('\n');
    const results: T[] = [];
    let corruptedCount = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        results.push(JSON.parse(line) as T);
      } catch {
        corruptedCount++;
      }
    }

    if (corruptedCount > 0) {
      logger.warn(`${logPrefix} Skipped ${corruptedCount} corrupted JSONL lines in ${filePath}`);
    }

    return results;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Read all records from JSONL file.
 *
 * @param filePath - Absolute path to JSONL file
 * @returns Array of parsed records (empty if file doesn't exist)
 * @throws Error if file exists but cannot be read/parsed
 */
export async function readJSONL<T>(filePath: string): Promise<T[]> {
  try {
    if (!existsSync(filePath)) {
      return [];
    }

    const content = await readFile(filePath, 'utf8');

    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as T);

  } catch (error) {
    logger.error('[jsonl-reader] Failed to read JSONL:', error);
    throw error;
  }
}
