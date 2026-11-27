/**
 * The local mode's daily files: the analytics folder's sessions inside the window, every whole line in file order,
 * each file one gzip stream no larger than the cap.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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

    it('a single line whose gzip is above the cap leaves its session out: an empty list naming it, the size and the cap', async () => {
      file('s1.hooks.jsonl', hexLines('s1', 1));

      const reports = (await build('A.B@example.com', 50))!;

      expect(reports).toHaveLength(0);
      const size = /^OTLP files built without 1 session: s1 \(Export size (\d+) bytes exceeds limit of 50 bytes\)$/.exec(
        reports.leftOut ?? ''
      );
      expect(size).not.toBeNull();
      expect(Number(size![1])).toBeGreaterThan(50);
      expect(reports.warning).toBeUndefined();
    });

    it('a session with a line above the cap beside a good one: the good one built, the other named alone', async () => {
      file('big.hooks.jsonl', hexLines('big', 1));
      file('ok.hooks.jsonl', 'ok\n');

      const reports = (await build('A.B@example.com', 50))!;

      expect(reports.map((report) => gunzipSync(report.bytes).toString('utf-8'))).toEqual(['ok\n']);
      expect(reports.leftOut).toMatch(/^OTLP files built without 1 session: big \(Export size \d+ bytes exceeds limit of 50 bytes\)$/);
      expect(reports.warning).toBeUndefined();
    });

    it('five sessions that cannot be built: the first three named in order, then the count of the rest', async () => {
      for (const id of ['s1', 's2', 's3', 's4', 's5']) file(`${id}.hooks.jsonl`, hexLines(id, 1));

      const reports = (await build('A.B@example.com', 50))!;

      expect(reports).toHaveLength(0);
      const named = (id: string) => `${id} \\(Export size \\d+ bytes exceeds limit of 50 bytes\\)`;
      expect(reports.leftOut).toMatch(
        new RegExp(`^OTLP files built without 5 sessions: ${named('s1')}, ${named('s2')}, ${named('s3')}, and 2 more$`)
      );
      expect(reports.warning).toBeUndefined();
    });
  });

  describe('a session that cannot be read', () => {
    /** A folder "file" that is a directory: its read fails on every platform. */
    function unreadable(name: string): void {
      mkdirSync(join(folder(), name), { recursive: true });
      const mtime = new Date('2026-11-24T12:00:00.000Z');
      utimesSync(join(folder(), name), mtime, mtime);
    }

    it('is left out for this run and named in the warning, the good session beside it is built', async () => {
      unreadable('bad.hooks.jsonl');
      file('good.hooks.jsonl', 'good\n');

      const reports = (await build())!;

      expect(reports.map((report) => gunzipSync(report.bytes).toString('utf-8'))).toEqual(['good\n']);
      expect(reports.warning).toMatch(
        /^OTLP files built without 1 session, the marker stays and the next run tries them again: bad \(/
      );
      expect(reports.leftOut).toBeUndefined();
    });

    it('a line above the cap and an unreadable file beside a good one: the first in leftOut, the second in the warning', async () => {
      file('big.hooks.jsonl', hexLines('big', 1));
      unreadable('bad.hooks.jsonl');
      file('ok.hooks.jsonl', 'ok\n');

      const reports = (await build('A.B@example.com', 50))!;

      expect(reports.map((report) => gunzipSync(report.bytes).toString('utf-8'))).toEqual(['ok\n']);
      expect(reports.leftOut).toMatch(/^OTLP files built without 1 session: big \(Export size \d+ bytes exceeds limit of 50 bytes\)$/);
      expect(reports.warning).toMatch(
        /^OTLP files built without 1 session, the marker stays and the next run tries them again: bad \(/
      );
    });

    it('five unreadable sessions: the warning names the first three in order, then the count of the rest', async () => {
      for (const id of ['s1', 's2', 's3', 's4', 's5']) unreadable(`${id}.hooks.jsonl`);

      const reports = (await build())!;

      expect(reports).toHaveLength(0);
      expect(reports.warning).toMatch(
        /^OTLP files built without 5 sessions, the marker stays and the next run tries them again: s1 \(.+\), s2 \(.+\), s3 \(.+\), and 2 more$/
      );
      expect(reports.warning).not.toContain('s4');
      expect(reports.leftOut).toBeUndefined();
    });

    it('edge: a session with a line above the cap and an unreadable file → the read fails first: named in the warning', async () => {
      file('mix.hooks.jsonl', hexLines('mix', 1));
      unreadable('mix.otel_logs.jsonl');

      const reports = (await build('A.B@example.com', 50))!;

      expect(reports.warning).toMatch(
        /^OTLP files built without 1 session, the marker stays and the next run tries them again: mix \(/
      );
      expect(reports.leftOut).toBeUndefined();
    });

    it('edge: left out at one run and readable at the next → a warning at the first, built at the next', async () => {
      unreadable('bad.hooks.jsonl');
      const first = (await build())!;
      expect(first.warning).toMatch(/^OTLP files built without 1 session, the marker stays and the next run tries them again: bad /);
      expect(first.leftOut).toBeUndefined();

      rmSync(join(folder(), 'bad.hooks.jsonl'), { recursive: true });
      file('bad.hooks.jsonl', 'bad\n');

      const reports = (await build())!;
      expect(reports.warning).toBeUndefined();
      expect(reports.leftOut).toBeUndefined();
      expect(reports.map((report) => gunzipSync(report.bytes).toString('utf-8'))).toEqual(['bad\n']);
    });

    it('edge: a folder that cannot be listed → the build rejects', async () => {
      mkdirSync(join(home, 'analytics'), { recursive: true });
      writeFileSync(folder(), 'not a folder');

      await expect(build()).rejects.toThrow();
    });
  });

  describe('the sync email', () => {
    type Attr = { key: string; value: { stringValue: string } };
    const attr = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
    /** An export line of `kind` with its line id, an optional resource-level email and a record-level email. */
    function exportLine(kind: 'resourceLogs' | 'resourceMetrics', id: string, resourceEmail?: string): string {
      const resource = [attr('codemie.line_id', id), ...(resourceEmail ? [attr('user.email', resourceEmail)] : [])];
      const pad = createHash('sha256').update(id).digest('hex');
      const record = { attributes: [attr('user.email', ''), attr('pad', pad)] };
      return JSON.stringify({ [kind]: [{ resource: { attributes: resource }, scopeLogs: [{ logRecords: [record] }] }] }) + '\n';
    }
    const resources = (line: string): Attr[][] => {
      const parsed = JSON.parse(line) as Record<string, { resource: { attributes: Attr[] } }[]>;
      return Object.values(parsed)[0].map((entry) => entry.resource.attributes);
    };
    const lines = (reports: { bytes: Buffer }[]) =>
      reports.flatMap((report) => gunzipSync(report.bytes).toString('utf-8').split('\n').filter((line) => line !== ''));
    const snapshot = () => Object.fromEntries(readdirSync(folder()).map((name) => [name, readFileSync(join(folder(), name))]));

    it('every resource of every line names the sync email with its case; line ids, records and the folder stay', async () => {
      file('s1.hooks.jsonl', exportLine('resourceLogs', 's1.hooks.jsonl:a') + 'not an export\n');
      file('s1.otel_metrics.jsonl', exportLine('resourceMetrics', 's1.otel_metrics.jsonl:b', 'other@example.com'));
      const before = snapshot();

      const built = lines((await build('A.B@Example.com'))!);

      expect(built[1]).toBe('not an export');
      const exports = [built[0], built[2]];
      expect(exports.map(resources)).toEqual([
        [[attr('codemie.line_id', 's1.hooks.jsonl:a'), attr('user.email', 'A.B@Example.com')]],
        [[attr('codemie.line_id', 's1.otel_metrics.jsonl:b'), attr('user.email', 'A.B@Example.com')]],
      ]);
      for (const line of exports) {
        const record = Object.values(JSON.parse(line) as Record<string, { scopeLogs: { logRecords: { attributes: Attr[] }[] }[] }[]>)[0][0]
          .scopeLogs[0].logRecords[0];
        expect(record.attributes[0]).toEqual(attr('user.email', ''));
      }
      expect(snapshot()).toEqual(before);
    });

    it('a session split across files: every line of every part names the email, each part within the cap', async () => {
      const ids = Array.from({ length: 20 }, (_, i) => `big.hooks.jsonl:${i}`);
      file('big.hooks.jsonl', ids.map((id) => exportLine('resourceLogs', id)).join(''));

      const reports = (await build('A.B@Example.com', 600))!;

      expect(reports.length).toBeGreaterThan(1);
      for (const report of reports) expect(report.bytes.length).toBeLessThanOrEqual(600);
      const built = lines(reports);
      expect(built.map(resources)).toEqual(
        ids.map((id) => [[attr('codemie.line_id', id), attr('user.email', 'A.B@Example.com')]])
      );
    });
  });

  describe('the window', () => {
    it('a session whose newest file is written one second after window.to is not built, one inside it is', async () => {
      file('late.hooks.jsonl', 'late\n', new Date(NOW.getTime() + 1000));
      file('inside.hooks.jsonl', 'inside\n');

      expect(await single()).toBe('inside\n');
    });

    it('edge: a session whose newest file is written exactly at window.to is built', async () => {
      file('edge.hooks.jsonl', 'edge\n', NOW);

      expect(await single()).toBe('edge\n');
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
