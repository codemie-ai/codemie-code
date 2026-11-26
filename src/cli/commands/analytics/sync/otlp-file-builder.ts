/**
 * The file `codemie analytics sync` delivers on a machine in the local mode: the analytics folder's sessions whose
 * newest line was written inside the window, each of them whole, as one gzipped OTLP JSON Lines file.
 */
import { once } from 'node:events';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import {
  FOLDER_STREAMS,
  MOVING_SUFFIX,
  analyticsFolderRoot,
  folderFileName,
  folderSessionIdOf,
} from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-folder-paths.js';
import { emailSlug } from '../report/report-generator.js';
import { formatUtcDate } from './window.js';
import type { ExportSource, SyncReport } from './types.js';

const NEWLINE = 0x0a;

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

/**
 * The analytics folder as the daily file: the sessions whose newest line falls in the window, each session's lines fed
 * into the gzip as soon as it is read.
 */
export class OtlpFolderSource implements ExportSource {
  async build(input: Parameters<ExportSource['build']>[0]): Promise<SyncReport | null> {
    const gzip = createGzip();
    try {
      return await this.fill(gzip, input);
    } finally {
      // Ended, emptied or left by a read that threw: the stream is released either way.
      gzip.destroy();
    }
  }

  private async fill(
    gzip: ReturnType<typeof createGzip>,
    input: Parameters<ExportSource['build']>[0]
  ): Promise<SyncReport | null> {
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
    const chunks: Buffer[] = [];
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    let written = false;
    for (const sessionId of sessionIds) {
      const marker = join(root, sessionId + MOVING_SUFFIX);
      // A session being moved is left for a later run.
      if (await exists(marker)) continue;
      const paths = FOLDER_STREAMS.map((stream) => join(root, folderFileName(sessionId, stream)));
      const mtimes = await Promise.all(paths.map((path) => stat(path).then((info) => info.mtimeMs, () => null)));
      const newest = Math.max(...mtimes.filter((mtime): mtime is number => mtime !== null));
      if (newest < window.from.getTime() || newest > window.to.getTime()) continue;

      const sessionParts: Buffer[] = [];
      for (const path of paths) {
        const lines = await wholeLines(path);
        if (lines) sessionParts.push(lines);
      }
      if (await exists(marker)) continue;
      for (const part of sessionParts) {
        if (!gzip.write(part)) await once(gzip, 'drain');
        written = true;
      }
    }
    if (!written) {
      gzip.destroy();
      return null;
    }
    const ended = once(gzip, 'end');
    gzip.end();
    await ended;

    return {
      fileName: `codemie-analytics-${emailSlug(email.toLowerCase())}-${formatUtcDate(now)}.otlp.jsonl.gz`,
      bytes: Buffer.concat(chunks),
      contentType: 'application/gzip',
    };
  }
}
