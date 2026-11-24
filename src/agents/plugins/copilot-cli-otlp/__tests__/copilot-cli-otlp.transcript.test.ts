import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptFrom, readTranscriptFromAsync } from '../copilot-cli-otlp.transcript.js';

const root = mkdtempSync(join(tmpdir(), 'cop-transcript-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const line = (n: number): string => `${JSON.stringify({ type: 'user.message', data: { text: `message ${n}` } })}\n`;
const write = (name: string, content: string): string => {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
};

describe('readTranscriptFromAsync', () => {
  it('returns what the synchronous reader returns', async () => {
    const path = write('plain.jsonl', line(1) + line(2) + line(3));
    expect(await readTranscriptFromAsync(path)).toEqual(readTranscriptFrom(path));
    expect((await readTranscriptFromAsync(path))?.events).toHaveLength(3);
  });

  it('reads from an offset and leaves a trailing partial line unread', async () => {
    const complete = line(1) + line(2);
    const path = write('offset.jsonl', `${complete}{"type":"user.mess`);
    const read = await readTranscriptFromAsync(path, line(1).length);
    expect(read?.events).toHaveLength(1);
    expect(read?.nextOffset).toBe(complete.length);
    expect(read).toEqual(readTranscriptFrom(path, line(1).length));
  });

  it('flags a read above the cap as truncated and keeps only the tail', async () => {
    const path = write('big.jsonl', Array.from({ length: 50 }, (_, i) => line(i)).join(''));
    const read = await readTranscriptFromAsync(path, 0, 500);
    expect(read?.truncated).toBe(true);
    expect(read?.events.length).toBeGreaterThan(0);
    expect(read?.events.length).toBeLessThan(50);
    expect(read).toEqual(readTranscriptFrom(path, 0, 500));
  });

  it('re-reads from the start when the offset is past the end of the file', async () => {
    const path = write('reset.jsonl', line(1));
    const read = await readTranscriptFromAsync(path, 10_000);
    expect(read?.reset).toBe(true);
    expect(read?.events).toHaveLength(1);
  });

  it('returns null for a missing file', async () => {
    expect(await readTranscriptFromAsync(join(root, 'missing.jsonl'))).toBeNull();
  });
});
