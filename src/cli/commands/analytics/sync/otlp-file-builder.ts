/**
 * The files `codemie analytics sync` delivers on a machine in the local mode: the analytics folder's sessions whose
 * newest line was written inside the window, as gzipped OTLP JSON Lines files no larger than the export cap.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { ExportTooLargeError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import {
  FOLDER_STREAMS,
  MOVING_SUFFIX,
  analyticsFolderRoot,
  folderFileName,
  folderSessionIdOf,
} from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder-paths.js';
import { setUserEmail } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/hook-record-format.js';
import { emailSlug } from '../report/report-generator.js';
import { errorMessage } from './redact.js';
import { MAX_EXPORT_BYTES } from './targets/webhook-target.js';
import { formatUtcDate, type SyncWindow } from './window.js';
import type { ExportSource, SyncFiles } from './types.js';

const NEWLINE = 0x0a;
/** How many sessions left out the run's line names per list before `and <k> more`. */
const LEFT_OUT_SHOWN = 3;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
}

/** The bytes of a folder file up to its last newline: a line still being written is left for a later run. */
async function wholeLines(path: string): Promise<Buffer | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const end = bytes.lastIndexOf(NEWLINE);
  return end < 0 ? null : bytes.subarray(0, end + 1);
}

/** The lines with the sync email on every resource of every export request line; any other line as it lies. */
function withUserEmail(lines: Buffer, email: string): Buffer {
  // Line by line on the bytes: a session too long for one string is still built, and a line left as it lies keeps its bytes.
  const out: Buffer[] = [];
  for (let start = 0; start < lines.length; ) {
    const newline = lines.indexOf(NEWLINE, start);
    const end = newline < 0 ? lines.length : newline + 1;
    const line = lines.subarray(start, newline < 0 ? end : newline);
    const stamped = line.length === 0 ? null : setUserEmail(line.toString('utf-8'), email);
    out.push(stamped === null ? lines.subarray(start, end) : Buffer.from(stamped + (newline < 0 ? '' : '\n'), 'utf-8'));
    start = end;
  }
  return Buffer.concat(out);
}

/** The session's lines as gzip members no larger than `cap`: whole when it fits, else halved at a line until it does. */
async function compressedPieces(bytes: Buffer, cap: number): Promise<Buffer[]> {
  const compressed = await gzipAsync(bytes);
  if (compressed.length <= cap) return [compressed];
  const middle = bytes.lastIndexOf(NEWLINE, Math.floor(bytes.length / 2));
  const cut = middle >= 0 && middle < bytes.length - 1 ? middle + 1 : bytes.indexOf(NEWLINE) + 1;
  if (cut >= bytes.length) throw new ExportTooLargeError(compressed.length, cap);
  return [
    ...(await compressedPieces(bytes.subarray(0, cut), cap)),
    ...(await compressedPieces(bytes.subarray(cut), cap)),
  ];
}

/**
 * The files of `pieces` in order, each one gzip stream no larger than `cap`: a file ends where the pieces' own gzip
 * sizes would pass the cap, and drops its last pieces into the next file while its own gzip is still above it.
 */
async function packFiles(pieces: Buffer[], cap: number): Promise<Buffer[]> {
  const files: Buffer[] = [];
  let start = 0;
  while (start < pieces.length) {
    let end = start + 1;
    let estimate = pieces[start].length;
    while (end < pieces.length && estimate + pieces[end].length <= cap) estimate += pieces[end++].length;
    let file = await gzipAsync(await gunzipAsync(Buffer.concat(pieces.slice(start, end))));
    while (file.length > cap && end - start > 1) {
      end--;
      file = await gzipAsync(await gunzipAsync(Buffer.concat(pieces.slice(start, end))));
    }
    if (file.length > cap) throw new ExportTooLargeError(file.length, cap);
    files.push(file);
    start = end;
  }
  return files;
}

/**
 * The analytics folder as the daily files: the sessions whose newest line falls in the window, in order, as files of
 * one gzip stream of whole lines each, no larger than `cap`; a session that does not fit a file alone is cut at a line.
 * A session with one line above the cap is left out whole and named in `leftOut`; a session whose file cannot be read
 * is left out for this run and named in `warning`; the others are built either way. A folder that cannot be listed
 * throws. `null` when nothing was built or left out.
 */
export class OtlpFolderSource implements ExportSource {
  constructor(private readonly cap: number = MAX_EXPORT_BYTES) {}

  async build(input: Parameters<ExportSource['build']>[0]): Promise<SyncFiles | null> {
    const { window, email, now } = input;
    const root = analyticsFolderRoot();
    let names: string[];
    try {
      names = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    const sessionIds = [...new Set(names.map(folderSessionIdOf).filter((id): id is string => id !== undefined))].sort();
    const pieces: Buffer[] = [];
    const leftOut: string[] = [];
    const notRead: string[] = [];
    for (const sessionId of sessionIds) {
      try {
        pieces.push(...(await this.sessionPieces(root, sessionId, window, email)));
      } catch (err) {
        logger.debug('[analytics-sync] session left out', ...sanitizeLogArgs({ sessionId, err: errorMessage(err) }));
        (err instanceof ExportTooLargeError ? leftOut : notRead).push(`${sessionId} (${errorMessage(err)})`);
      }
    }
    if (pieces.length === 0 && leftOut.length === 0 && notRead.length === 0) return null;
    const files = pieces.length === 0 ? [] : await packFiles(pieces, this.cap);

    const base = `codemie-analytics-${emailSlug(email.toLowerCase())}-${formatUtcDate(now)}`;
    const width = Math.max(2, String(files.length).length);
    const part = (k: number) => `part-${String(k).padStart(width, '0')}-of-${String(files.length).padStart(width, '0')}.`;
    const reports: SyncFiles = files.map((bytes, i) => ({
      fileName: `${base}.${files.length === 1 ? '' : part(i + 1)}otlp.jsonl.gz`,
      bytes,
      contentType: 'application/gzip',
    }));
    if (notRead.length > 0) reports.warning = leftOutText(notRead, ', the marker stays and the next run tries them again');
    if (leftOut.length > 0) reports.leftOut = leftOutText(leftOut, '');
    return reports;
  }

  /**
   * The session's gzip pieces, every export request line naming `email` as its resources' `user.email`; none when it
   * is being moved, outside the window or has no whole line yet.
   */
  private async sessionPieces(root: string, sessionId: string, window: SyncWindow, email: string): Promise<Buffer[]> {
    const marker = join(root, sessionId + MOVING_SUFFIX);
    // A session being moved is left for a later run.
    if (await exists(marker)) return [];
    const paths = FOLDER_STREAMS.map((stream) => join(root, folderFileName(sessionId, stream)));
    const mtimes = await Promise.all(paths.map((path) => stat(path).then((info) => info.mtimeMs, () => null)));
    const newest = Math.max(...mtimes.filter((mtime): mtime is number => mtime !== null));
    if (newest < window.from.getTime() || newest > window.to.getTime()) return [];

    const sessionParts: Buffer[] = [];
    for (const path of paths) {
      const lines = await wholeLines(path);
      if (lines) sessionParts.push(lines);
    }
    if (await exists(marker)) return [];
    if (sessionParts.length === 0) return [];
    return compressedPieces(withUserEmail(Buffer.concat(sessionParts), email), this.cap);
  }
}

/** `OTLP files built without <n> session(s)<note>: …` naming the first sessions left out, each with its error. */
function leftOutText(sessions: string[], note: string): string {
  const shown = sessions.slice(0, LEFT_OUT_SHOWN).join(', ');
  const more = sessions.length > LEFT_OUT_SHOWN ? `, and ${sessions.length - LEFT_OUT_SHOWN} more` : '';
  return `OTLP files built without ${sessions.length} session${sessions.length === 1 ? '' : 's'}${note}: ${shown}${more}`;
}
