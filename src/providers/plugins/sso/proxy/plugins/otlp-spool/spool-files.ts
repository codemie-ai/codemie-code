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

/** Most of a session's hooks spool read to learn whether its hooks obfuscated (the head holds the first events). */
const OBFUSCATION_EVIDENCE_BYTES = 256 * 1024;

/**
 * Whether the session's hook events were obfuscated. A hook stamps `rules_version` on every event it forwards while
 * obfuscation is on for its folder, so this is how the daemon, which has no project directory, learns a project-scoped
 * setting. `none`: no usable hook event on disk yet.
 */
export async function hookObfuscationEvidence(sessionId: string): Promise<'on' | 'off' | 'none'> {
  const head = await readRange(sessionId, 'hooks', 0, OBFUSCATION_EVIDENCE_BYTES);
  if (!head) return 'none';
  let sawEvent = false;
  for (const line of head.toString('utf-8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const { hookEvent } = JSON.parse(line) as { hookEvent: string };
      const event = JSON.parse(hookEvent) as Record<string, unknown> | null;
      if (typeof event !== 'object' || event === null) continue;
      sawEvent = true;
      if (event['rules_version'] !== undefined) return 'on';
    } catch {
      // partial or unusable record
    }
  }
  return sawEvent ? 'off' : 'none';
}
