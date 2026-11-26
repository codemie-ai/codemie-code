/**
 * The local mode's daily file: the analytics folder's sessions inside the window, every whole line in file order,
 * gzipped as one stream.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

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

async function build(email = 'A.B@example.com') {
  return new OtlpFolderSource().build({ window: WINDOW, email, includeExternal: false, now: NOW });
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

    const report = await build();

    expect(report?.fileName).toBe('codemie-analytics-a-b-example-com-2026-11-25.otlp.jsonl.gz');
    expect(report?.contentType).toBe('application/gzip');
    expect(gunzipSync(report!.bytes).toString('utf-8')).toBe('s1-hook\ns1-logs\ns1-metrics\ns2-hook-1\ns2-hook-2\ns2-traces\n');
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

    const report = await build();

    expect(gunzipSync(report!.bytes).toString('utf-8')).toBe(lines);
  });

  describe('edge', () => {
    it('a session whose newest line is exactly window.from is included', async () => {
      file('edge.hooks.jsonl', 'edge\n', FROM);

      expect(gunzipSync((await build())!.bytes).toString('utf-8')).toBe('edge\n');
    });

    it('a last line with no newline is left out', async () => {
      file('s1.hooks.jsonl', 'whole\nhalf');

      expect(gunzipSync((await build())!.bytes).toString('utf-8')).toBe('whole\n');
    });

    it('a session with a move marker is left out', async () => {
      file('s1.hooks.jsonl', 's1\n');
      file('s2.hooks.jsonl', 's2\n');
      file('s2.moving', '{}');

      expect(gunzipSync((await build())!.bytes).toString('utf-8')).toBe('s1\n');
    });

    it('a session whose marker appears while it is read is left out of this run', async () => {
      file('s1.hooks.jsonl', 's1\n');
      file('s2.hooks.jsonl', 's2\n');
      beforeRead = (path) => {
        if (path.endsWith('s2.hooks.jsonl')) writeFileSync(join(folder(), 's2.moving'), '{}');
      };

      expect(gunzipSync((await build())!.bytes).toString('utf-8')).toBe('s1\n');
    });
  });
});
