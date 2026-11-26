/**
 * The local mode's daily files: the analytics folder's sessions inside the window, every whole line in file order,
 * each file one gzip stream no larger than the cap.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ExportTooLargeError } from '@/utils/errors.js';

/** Runs before a `readFile` of the folder reaches the file system. */
let beforeRead: ((path: string) => void) | undefined;
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      beforeRead?.(String(args[0]));
      return real.readFile(...args);
    }) as typeof real.readFile,
  };
});

const { OtlpFolderSource } = await import('../otlp-file-builder.js');

const NOW = new Date('2026-11-25T03:00:00.000Z');
const FROM = new Date('2026-11-24T02:00:00.000Z');
const WINDOW = { from: FROM, to: NOW, label: 'w' };
let home: string;

const folder = () => join(home, 'analytics', 'sessions');

/** Writes a folder file and sets its mtime. */
function file(name: string, text: string, mtime: Date = new Date('2026-11-24T12:00:00.000Z')): void {
  mkdirSync(folder(), { recursive: true });
  writeFileSync(join(folder(), name), text);
  utimesSync(join(folder(), name), mtime, mtime);
}

async function build(email = 'A.B@example.com', cap?: number) {
  return new OtlpFolderSource(cap).build({ window: WINDOW, email, includeExternal: false, now: NOW });
}

/** The text of a build of one file. */
async function single(): Promise<string> {
  const reports = await build();
  expect(reports).toHaveLength(1);
  return gunzipSync(reports![0].bytes).toString('utf-8');
}

/** A file is one gzip member: its trailer's length (ISIZE) is the length of all it gunzips to. */
function expectOneMember(bytes: Buffer): void {
  expect(bytes.readUInt32LE(bytes.length - 4)).toBe(gunzipSync(bytes).length);
}

/** `count` lines of hex that gzip barely shrinks, so a small cap is reached by few lines. */
function hexLines(seed: string, count: number): string {
  return Array.from({ length: count }, (_, i) => createHash('sha256').update(`${seed}${i}`).digest('hex') + '\n').join('');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'otlp-file-builder-'));
  vi.stubEnv('CODEMIE_HOME', home);
  beforeRead = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('OtlpFolderSource', () => {
  it('takes the sessions inside the window, their files in order, sessions by id, as one gzip', async () => {
    file('s2.otel_traces.jsonl', 's2-traces\n');
    file('s2.hooks.jsonl', 's2-hook-1\ns2-hook-2\n');
    file('s1.otel_metrics.jsonl', 's1-metrics\n');
    file('s1.otel_logs.jsonl', 's1-logs\n');
    file('s1.hooks.jsonl', 's1-hook\n');
    file('old.hooks.jsonl', 'old-hook\n', new Date('2026-11-20T00:00:00.000Z'));

    const reports = await build();

    expect(reports?.map((report) => report.fileName)).toEqual(['codemie-analytics-a-b-example-com-2026-11-25.otlp.jsonl.gz']);
    expect(reports![0].contentType).toBe('application/gzip');
    expect(gunzipSync(reports![0].bytes).toString('utf-8')).toBe('s1-hook\ns1-logs\ns1-metrics\ns2-hook-1\ns2-hook-2\ns2-traces\n');
    expectOneMember(reports![0].bytes);
  });

  it('an empty folder or none → null', async () => {
    expect(await build()).toBeNull();
    mkdirSync(folder(), { recursive: true });
    expect(await build()).toBeNull();
  });

  it('a folder of more than one gzip chunk gunzips to its lines', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `{"line":${i},"pad":"${'y'.repeat(60)}"}\n`).join('');
    expect(Buffer.byteLength(lines)).toBeGreaterThan(64 * 1024);
    file('big.hooks.jsonl', lines);

    expect(await single()).toBe(lines);
  });

  describe('the cap', () => {
    it('sessions that do not fit together go into the next file, each a whole gzip within the cap', async () => {
      file('s1.hooks.jsonl', hexLines('s1', 1));
      file('s2.hooks.jsonl', hexLines('s2', 1));
      file('s3.hooks.jsonl', hexLines('s3', 2));

      const reports = (await build('A.B@example.com', 160))!;

      expect(reports.map((report) => report.fileName)).toEqual([
        'codemie-analytics-a-b-example-com-2026-11-25.part-01-of-02.otlp.jsonl.gz',
        'codemie-analytics-a-b-example-com-2026-11-25.part-02-of-02.otlp.jsonl.gz',
      ]);
      expect(reports.map((report) => report.contentType)).toEqual(['application/gzip', 'application/gzip']);
      const texts = reports.map((report) => gunzipSync(report.bytes).toString('utf-8'));
      expect(texts).toEqual([hexLines('s1', 1) + hexLines('s2', 1), hexLines('s3', 2)]);
      for (const report of reports) expect(report.bytes.length).toBeLessThanOrEqual(160);
      for (const report of reports) expectOneMember(report.bytes);
    });

    it('a session larger than the cap alone is cut at lines, none lost or repeated, every file within the cap', async () => {
      file('big.hooks.jsonl', hexLines('big', 20));

      const reports = (await build('A.B@example.com', 160))!;

      expect(reports.length).toBeGreaterThan(1);
      const texts = reports.map((report) => gunzipSync(report.bytes).toString('utf-8'));
      for (const text of texts) expect(text.endsWith('\n')).toBe(true);
      expect(texts.join('')).toBe(hexLines('big', 20));
      for (const report of reports) expect(report.bytes.length).toBeLessThanOrEqual(160);
      for (const report of reports) expectOneMember(report.bytes);
    });

    it('a single line whose gzip is above the cap throws ExportTooLargeError with that size and the cap', async () => {
      file('s1.hooks.jsonl', hexLines('s1', 1));

      await expect(build('A.B@example.com', 50)).rejects.toSatisfy(
        (err: unknown) => err instanceof ExportTooLargeError && err.limit === 50 && err.bytes > 50
      );
    });
  });

  describe('edge', () => {
    it('a session whose newest line is exactly window.from is included', async () => {
      file('edge.hooks.jsonl', 'edge\n', FROM);

      expect(await single()).toBe('edge\n');
    });

    it('a last line with no newline is left out', async () => {
      file('s1.hooks.jsonl', 'whole\nhalf');

      expect(await single()).toBe('whole\n');
    });

    it('a session with a move marker is left out', async () => {
      file('s1.hooks.jsonl', 's1\n');
      file('s2.hooks.jsonl', 's2\n');
      file('s2.moving', '{}');

      expect(await single()).toBe('s1\n');
    });

    it('a session whose marker appears while it is read is left out of this run', async () => {
      file('s1.hooks.jsonl', 's1\n');
      file('s2.hooks.jsonl', 's2\n');
      beforeRead = (path) => {
        if (path.endsWith('s2.hooks.jsonl')) writeFileSync(join(folder(), 's2.moving'), '{}');
      };

      expect(await single()).toBe('s1\n');
    });
  });
});
