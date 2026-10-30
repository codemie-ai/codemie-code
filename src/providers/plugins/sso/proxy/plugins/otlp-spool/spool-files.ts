import { open, readFile, stat } from 'node:fs/promises';
import { streamFile, type SpoolStream } from './spool-paths.js';
import { hookEventProjectNames } from './session-project.js';

/* Read-only spool file helpers; callers that need consistency hold the session lock. */

export async function hooksFileState(sessionId: string): Promise<{ exists: boolean; size: number }> {
  try {
    return { exists: true, size: (await stat(streamFile(sessionId, 'hooks'))).size };
  } catch {
    return { exists: false, size: 0 };
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Range-read everything after `cursor`, up to `end` when given. Never touches the acknowledged prefix. */
export async function readRange(
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
export async function readHookProjectNames(sessionId: string): Promise<string[]> {
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
