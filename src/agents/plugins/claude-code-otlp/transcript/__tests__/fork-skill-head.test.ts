/**
 * `hasCompleteLine` needs only a boolean: it must neither retain what it reads nor read a file
 * without limit when the first line has no newline (EPMCDME-16391).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = vi.hoisted(() => ({ bytes: 0, maxChunk: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const inner = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const r = await inner(...a);
        read.bytes += r.bytesRead;
        read.maxChunk = Math.max(read.maxChunk, r.bytesRead);
        return r;
      };
      return handle;
    },
  };
});

import { hasCompleteLine } from '../fork-skill.js';

const MIB = 1024 * 1024;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'head-'));
  read.bytes = 0;
  read.maxChunk = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('hasCompleteLine', () => {
  it('missing, empty and no-newline files have no complete line', async () => {
    expect(await hasCompleteLine(join(dir, 'missing.jsonl'))).toBe(false);
    writeFileSync(join(dir, 'empty.jsonl'), '');
    expect(await hasCompleteLine(join(dir, 'empty.jsonl'))).toBe(false);
    writeFileSync(join(dir, 'partial.jsonl'), '{"type":"user"');
    expect(await hasCompleteLine(join(dir, 'partial.jsonl'))).toBe(false);
  });

  it('stops at the first newline without reading the rest of a large file', async () => {
    const file = join(dir, 'big.jsonl');
    writeFileSync(file, `{"a":1}\n${'x'.repeat(8 * MIB)}`);
    expect(await hasCompleteLine(file)).toBe(true);
    expect(read.bytes).toBeLessThanOrEqual(16 * 1024);
  });

  it('an oversized partial first line stays undecided with bounded reads in small chunks', async () => {
    const file = join(dir, 'huge-partial.jsonl');
    writeFileSync(file, 'x'.repeat(12 * MIB));
    expect(await hasCompleteLine(file)).toBe(false);
    expect(read.bytes).toBeLessThanOrEqual(4 * MIB);
    expect(read.maxChunk).toBeLessThanOrEqual(16 * 1024);
  });
});
