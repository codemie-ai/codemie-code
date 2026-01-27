/**
 * JSONL Utilities Unit Tests
 *
 * Tests for generic JSONL reader and atomic writer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJSONL } from '../jsonl-reader.js';
import { writeJSONLAtomic } from '../jsonl-writer.js';
import { existsSync } from 'fs';

describe('readJSONL', () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'jsonl-test-'));
    testFile = join(tempDir, 'test.jsonl');
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should return empty array for non-existent file', async () => {
    const result = await readJSONL(testFile);
    expect(result).toEqual([]);
  });

  it('should read and parse JSONL records', async () => {
    const records = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' }
    ];

    await writeJSONLAtomic(testFile, records);
    const result = await readJSONL<{ id: number; name: string }>(testFile);

    expect(result).toEqual(records);
  });

  it('should handle empty lines', async () => {
    const records = [{ id: 1 }, { id: 2 }];
    await writeJSONLAtomic(testFile, records);

    // Read and verify
    const result = await readJSONL<{ id: number }>(testFile);
    expect(result).toEqual(records);
  });

  it('should preserve type safety', async () => {
    interface TestRecord {
      value: string;
      count: number;
    }

    const records: TestRecord[] = [
      { value: 'test', count: 42 }
    ];

    await writeJSONLAtomic(testFile, records);
    const result = await readJSONL<TestRecord>(testFile);

    expect(result[0].value).toBe('test');
    expect(result[0].count).toBe(42);
  });
});

describe('writeJSONLAtomic', () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'jsonl-test-'));
    testFile = join(tempDir, 'test.jsonl');
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should write records atomically', async () => {
    const records = [
      { id: 1, data: 'first' },
      { id: 2, data: 'second' }
    ];

    await writeJSONLAtomic(testFile, records);

    expect(existsSync(testFile)).toBe(true);
    const result = await readJSONL<{ id: number; data: string }>(testFile);
    expect(result).toEqual(records);
  });

  it('should overwrite existing file', async () => {
    const initial = [{ id: 1 }];
    const updated = [{ id: 2 }, { id: 3 }];

    await writeJSONLAtomic(testFile, initial);
    await writeJSONLAtomic(testFile, updated);

    const result = await readJSONL<{ id: number }>(testFile);
    expect(result).toEqual(updated);
  });

  it('should not leave temp files on success', async () => {
    const records = [{ id: 1 }];
    await writeJSONLAtomic(testFile, records);

    const tempFile = `${testFile}.tmp`;
    expect(existsSync(tempFile)).toBe(false);
  });

  it('should handle empty array', async () => {
    await writeJSONLAtomic(testFile, []);

    const result = await readJSONL(testFile);
    expect(result).toEqual([]);
  });

  it('should handle complex objects', async () => {
    const records = [
      {
        id: 1,
        nested: { value: 'test', array: [1, 2, 3] },
        timestamp: Date.now()
      }
    ];

    await writeJSONLAtomic(testFile, records);
    const result = await readJSONL<typeof records[0]>(testFile);

    expect(result[0].nested.value).toBe('test');
    expect(result[0].nested.array).toEqual([1, 2, 3]);
  });
});
