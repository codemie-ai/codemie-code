/**
 * Tests for the incremental transcript reader: `readNewLines`.
 *
 * The reader must only ever return complete, newline-terminated lines, cutting
 * at the last `\n` byte so a partially-written trailing line is never handed
 * back to the caller — mirrors the safe-cut rule in
 * `src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.ts`'s
 * `snapshotPendingHookRecords`. It must never throw, even for a missing file.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNewLines } from '../transcript-reader.js';

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('readNewLines', () => {
  it('returns only complete lines and nextOffset points exactly after the last complete line; a second call returns only newly appended lines', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codemie-transcript-'));
    const filePath = join(tmpDir, 'transcript.jsonl');

    const completePrefix = 'line1\nline2\n';
    await writeFile(filePath, `${completePrefix}partial-line-no-newli`);

    const first = await readNewLines(filePath, 0);

    expect(first.lines).toEqual(['line1', 'line2']);
    expect(first.nextOffset).toBe(Buffer.byteLength(completePrefix));

    // Complete the previously-partial line and add a new complete line.
    await appendFile(filePath, 'ne\nline4\n');

    const second = await readNewLines(filePath, first.nextOffset);

    expect(second.lines).toEqual(['partial-line-no-newline', 'line4']);
    expect(second.nextOffset).toBeGreaterThan(first.nextOffset);
  });

  it('returns an empty result without throwing when the file is missing', async () => {
    const result = await readNewLines(
      'C:/nonexistent/path/that/does/not/exist.jsonl',
      0
    );

    expect(result).toEqual({ lines: [], nextOffset: 0 });
  });

  it('returns an empty result and does not advance the offset when the file has only an unterminated partial line', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codemie-transcript-'));
    const filePath = join(tmpDir, 'transcript.jsonl');

    await writeFile(filePath, 'no-newline-yet');

    const result = await readNewLines(filePath, 0);

    expect(result).toEqual({ lines: [], nextOffset: 0 });
  });

  it('resumes a fresh parse from 0 after the file is rotated/truncated below the persisted offset', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codemie-transcript-'));
    const filePath = join(tmpDir, 'transcript.jsonl');

    await writeFile(filePath, 'line1\nline2\nline3\n');
    const first = await readNewLines(filePath, 0);
    expect(first.lines).toEqual(['line1', 'line2', 'line3']);

    // Rotation: the file is replaced by a much shorter one, so its size now sits below the
    // previously persisted offset.
    await writeFile(filePath, 'new1\nnew2\n');

    const second = await readNewLines(filePath, first.nextOffset);

    expect(second.lines).toEqual(['new1', 'new2']);
    expect(second.nextOffset).toBe(Buffer.byteLength('new1\nnew2\n'));
  });

  it('returns an empty result when nothing new has been written since fromOffset', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codemie-transcript-'));
    const filePath = join(tmpDir, 'transcript.jsonl');

    const content = 'line1\nline2\n';
    await writeFile(filePath, content);

    const result = await readNewLines(filePath, Buffer.byteLength(content));

    expect(result).toEqual({
      lines: [],
      nextOffset: Buffer.byteLength(content),
    });
  });
});
