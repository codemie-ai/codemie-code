import { open } from 'node:fs/promises';

const NEWLINE = 0x0a;

export interface ReadNewLinesResult {
  lines: string[];
  nextOffset: number;
}

/**
 * Incrementally read complete, newline-terminated lines appended to a
 * transcript file since `fromOffset`.
 *
 * Mirrors the safe-cut rule used by
 * `src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.ts`'s
 * `snapshotPendingHookRecords`: the read is cut at the last `\n` byte so a
 * partially-written trailing line is never returned. Never throws — a
 * missing file, a shrunk/rotated file, or a chunk with no complete line yet
 * all resolve to the documented empty-result shape.
 */
export async function readNewLines(
  filePath: string,
  fromOffset: number
): Promise<ReadNewLinesResult> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return { lines: [], nextOffset: fromOffset }; // missing file => nothing new
  }

  try {
    const { size } = await handle.stat();
    if (size <= fromOffset) {
      return { lines: [], nextOffset: fromOffset }; // nothing new (or file rotated/truncated)
    }

    const buffer = Buffer.allocUnsafe(size - fromOffset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, fromOffset);
    const chunk = buffer.subarray(0, bytesRead);

    const lastNewline = chunk.lastIndexOf(NEWLINE);
    if (lastNewline < 0) {
      return { lines: [], nextOffset: fromOffset }; // no complete line yet
    }

    const complete = chunk.subarray(0, lastNewline + 1);
    const lines = complete
      .toString('utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    return { lines, nextOffset: fromOffset + complete.length };
  } finally {
    await handle.close();
  }
}
