/**
 * Where the local mode keeps its analytics: the folder of moved sessions, the names of a session's files there, and
 * the local daemon's own spool. Read by the move into the folder and by the delivery of the folder.
 */
import { mkdir, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

/** The analytics folder: every finished session of the local mode, one `.jsonl` file per stream, only appended to. */
export function analyticsFolderRoot(): string {
  return getCodemiePath('analytics', 'sessions');
}

/**
 * Makes the analytics folder when it is absent, readable by its owner alone; a folder already there is left as it is.
 * Answers the first directory this call made (the folder or a parent of it), `undefined` when it made none.
 */
export async function ensureAnalyticsFolder(): Promise<string | undefined> {
  return mkdir(analyticsFolderRoot(), { recursive: true, mode: 0o700 });
}

/** Whether `dir` is `top` or inside it. */
function isWithin(top: string, dir: string): boolean {
  const rel = relative(top, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Removes `dir` when it is empty: answers whether it did; a directory that holds anything, or is gone, is left. */
async function removeIfEmpty(dir: string): Promise<boolean> {
  try {
    await rmdir(dir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST: what some systems answer for a folder that is not empty.
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    return false;
  }
}

/**
 * Takes back what {@link ensureAnalyticsFolder} made, `made` being its answer: the analytics folder, then each parent
 * up to and including `made`, each only while it is empty — the first one that holds anything, or is gone, ends it.
 * When `made` is `analytics/` or above it, an empty local spool goes first, so `analytics/` can go; one that holds
 * anything stays. Nothing above `made` is removed, and with `undefined` nothing is.
 */
export async function removeMadeAnalyticsFolder(made: string | undefined): Promise<void> {
  if (made === undefined) return;
  const top = resolve(made);
  if (isWithin(top, resolve(getCodemiePath('analytics')))) await removeIfEmpty(localSpoolRoot());
  for (let dir = resolve(analyticsFolderRoot()); isWithin(top, dir); dir = dirname(dir)) {
    if (!(await removeIfEmpty(dir))) return;
  }
}

/** The local daemon's spool, where a session stays until it is moved into the analytics folder. */
export function localSpoolRoot(): string {
  return getCodemiePath('analytics', 'spool');
}

/** The streams of a session in the analytics folder, in the order a delivery reads them. */
export const FOLDER_STREAMS = ['hooks', 'logs', 'metrics', 'traces'] as const;
export type FolderStream = (typeof FOLDER_STREAMS)[number];

const FOLDER_SUFFIX: Record<FolderStream, string> = {
  hooks: '.hooks.jsonl',
  logs: '.otel_logs.jsonl',
  metrics: '.otel_metrics.jsonl',
  traces: '.otel_traces.jsonl',
};

/** The name of one stream's file of a session in the analytics folder. */
export function folderFileName(sessionId: string, stream: FolderStream): string {
  return sessionId + FOLDER_SUFFIX[stream];
}

/** The suffix of the marker of a move in progress, `<sessionId>.moving`: a session with one is not delivered. */
export const MOVING_SUFFIX = '.moving';

/** The session id of a folder file name (a stream file or a move marker); `undefined` for any other name. */
export function folderSessionIdOf(fileName: string): string | undefined {
  for (const suffix of [...Object.values(FOLDER_SUFFIX), MOVING_SUFFIX]) {
    if (fileName.length > suffix.length && fileName.endsWith(suffix)) return fileName.slice(0, -suffix.length);
  }
  return undefined;
}
