import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { CopilotEvent } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';

export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export interface TranscriptRead {
  events: CopilotEvent[];
  /** Byte offset of the first unread complete line. */
  nextOffset: number;
  /** True when the file was larger than the cap and only its tail was read. */
  truncated: boolean;
  /** True when the stored offset was past the end of the file, so the transcript was re-read from the start. */
  reset: boolean;
}

interface ReadWindow {
  start: number;
  length: number;
  truncated: boolean;
  reset: boolean;
}

function planRead(size: number, fromOffset: number, maxBytes: number): ReadWindow {
  const reset = fromOffset > size;
  let start = reset ? 0 : fromOffset;
  let truncated = false;
  if (size - start > maxBytes) {
    start = size - maxBytes;
    truncated = true;
  }
  return { start, length: size - start, truncated, reset };
}

function parseWindow(buffer: Buffer, { start, truncated, reset }: ReadWindow): TranscriptRead {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { events: [], nextOffset: start, truncated, reset };
  }
  let text = buffer.subarray(0, lastNewline + 1).toString('utf-8');
  if (truncated) {
    text = text.slice(text.indexOf('\n') + 1); // first line is cut
  }
  const events: CopilotEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed as CopilotEvent);
    } catch {
      // Unparseable line: dropped, as the managed reader does.
    }
  }
  return { events, nextOffset: start + lastNewline + 1, truncated, reset };
}

/**
 * Reads complete JSONL lines from `fromOffset`. A trailing line still being written is left
 * for the next read. Above the byte cap only the tail is read and `truncated` is set.
 */
export function readTranscriptFrom(
  filePath: string,
  fromOffset = 0,
  maxBytes: number = MAX_TRANSCRIPT_BYTES
): TranscriptRead | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const window = planRead(fstatSync(fd).size, fromOffset, maxBytes);
    const buffer = Buffer.alloc(window.length);
    readSync(fd, buffer, 0, window.length, window.start);
    return parseWindow(buffer, window);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Same as `readTranscriptFrom`, without blocking the event loop on the file read (for the shared proxy daemon). */
export async function readTranscriptFromAsync(
  filePath: string,
  fromOffset = 0,
  maxBytes: number = MAX_TRANSCRIPT_BYTES
): Promise<TranscriptRead | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const window = planRead((await handle.stat()).size, fromOffset, maxBytes);
    const buffer = Buffer.alloc(window.length);
    await handle.read(buffer, 0, window.length, window.start);
    return parseWindow(buffer, window);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
